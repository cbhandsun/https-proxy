'use strict';

const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const {
  STORAGE_TTL_MS,
  storageCatalog,
} = require('../../lib/proxy/context-recovery-storage-contract');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');

const fail = () => new Error('capacity_retention_witness_failed');
const MAX_SAMPLES = 32768;
const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function callable(value) {
  return typeof value === 'function' && !types.isProxy(value) && !types.isGeneratorFunction(value);
}

// Only numeric time samples and catalog metadata are retained. No checkpoint,
// payload, key or source is read to establish the actual root expiry boundary.
function createCapacityRetentionWitness(options = {}) {
  const settings = {
    roots: 1,
    now: Date.now,
    monotonic: () => performance.now(),
    sleep: defaultSleep,
  };
  try {
    if (
      !options ||
      typeof options !== 'object' ||
      types.isProxy(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      throw fail();
    for (const name of Reflect.ownKeys(options)) {
      const slot = Object.getOwnPropertyDescriptor(options, name);
      if (!Object.hasOwn(settings, name) || !slot?.enumerable || !Object.hasOwn(slot, 'value'))
        throw fail();
      settings[name] = slot.value;
    }
    if (
      !Number.isSafeInteger(settings.roots) ||
      settings.roots < 1 ||
      settings.roots > 4 ||
      !['now', 'monotonic', 'sleep'].every((name) => callable(settings[name])) ||
      types.isAsyncFunction(settings.now) ||
      types.isAsyncFunction(settings.monotonic)
    )
      throw fail();
  } catch {
    throw fail();
  }
  let failed = false,
    busy = false,
    waited = false,
    previous,
    catalog,
    deadline;
  let sampleCount = 0;
  const samples = new Map();
  function reject() {
    failed = true;
    throw fail();
  }
  function read() {
    try {
      if (failed) throw fail();
      const wall = settings.now();
      const monotonic = settings.monotonic();
      if (
        !Number.isSafeInteger(wall) ||
        wall < 0 ||
        wall > Number.MAX_SAFE_INTEGER - STORAGE_TTL_MS ||
        !Number.isFinite(monotonic) ||
        monotonic < 0 ||
        monotonic > Number.MAX_SAFE_INTEGER - STORAGE_TTL_MS ||
        (previous && (wall < previous.wall || monotonic < previous.monotonic))
      )
        throw fail();
      previous = { wall, monotonic };
      return previous;
    } catch {
      return reject();
    }
  }
  function summary() {
    return Object.freeze({
      roots: catalog.length,
      minRootExpiresAt: Math.min(...catalog.map((entry) => entry.expiresAt)),
      maxRootExpiresAt: Math.max(...catalog.map((entry) => entry.expiresAt)),
    });
  }
  function expired(sample) {
    return sample.monotonic >= deadline && sample.wall >= summary().maxRootExpiresAt;
  }
  async function exclusive(action) {
    if (failed || busy) return reject();
    busy = true;
    try {
      return await action();
    } catch {
      return reject();
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    now() {
      const sample = read();
      if (!catalog) {
        if (++sampleCount > MAX_SAMPLES) return reject();
        // A later sample in the same wall millisecond gives a conservative birth.
        samples.set(sample.wall, sample.monotonic);
      }
      return sample.wall;
    },
    observeCatalog(input) {
      try {
        if (failed || busy || waited) throw fail();
        const entries = storageCatalog(input);
        const current = read();
        if (
          entries.length !== settings.roots ||
          entries.some((entry) => entry.expiresAt <= current.wall)
        )
          throw fail();
        if (catalog) {
          if (
            entries.some(
              (entry, index) =>
                entry.scope !== catalog[index].scope ||
                entry.createdAt !== catalog[index].createdAt ||
                entry.expiresAt !== catalog[index].expiresAt ||
                entry.revision < catalog[index].revision
            )
          )
            throw fail();
        } else {
          const births = entries.map((entry) => samples.get(entry.expiresAt - STORAGE_TTL_MS));
          if (births.some((birth) => birth === undefined)) throw fail();
          deadline = Math.max(...births) + STORAGE_TTL_MS;
          samples.clear();
        }
        catalog = entries;
        return summary();
      } catch {
        return reject();
      }
    },
    inspect() {
      read();
      return Object.freeze({
        rootsObserved: catalog?.length ?? 0,
        minRootExpiresAt: catalog ? summary().minRootExpiresAt : null,
        maxRootExpiresAt: catalog ? summary().maxRootExpiresAt : null,
        expiryWaitCompleted: waited,
      });
    },
    async waitForExpiry() {
      return exclusive(async () => {
        if (!catalog || waited) throw fail();
        let current = read();
        while (!expired(current)) {
          const duration = Math.min(
            60000,
            Math.max(
              1,
              Math.ceil(deadline - current.monotonic),
              summary().maxRootExpiresAt - current.wall
            )
          );
          const pending = settings.sleep(duration);
          if (!nativeReaderPromise(pending) || (await pending) !== undefined) throw fail();
          const next = read();
          if (next.monotonic <= current.monotonic) throw fail();
          current = next;
        }
        waited = true;
        return summary();
      });
    },
    async assertExpired(storage) {
      return exclusive(async () => {
        if (
          !waited ||
          !catalog ||
          !expired(read()) ||
          !storage ||
          typeof storage !== 'object' ||
          types.isProxy(storage) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(storage))
        )
          throw fail();
        const slot = Object.getOwnPropertyDescriptor(storage, 'execute');
        if (!slot?.enumerable || !Object.hasOwn(slot, 'value') || !callable(slot.value))
          throw fail();
        async function execute(request) {
          const reply = Reflect.apply(slot.value, storage, [request]);
          // Reject arbitrary thenables without consulting a then property.
          return { value: nativeReaderPromise(reply) ? await reply : reply };
        }
        if (storageCatalog((await execute({ operation: 'catalog' })).value).length !== 0)
          throw fail();
        for (const entry of catalog) {
          for (const operation of ['load', 'load-reference']) {
            if ((await execute({ operation, scope: entry.scope })).value !== null) throw fail();
          }
        }
        const result = (await execute({ operation: 'inspect' })).value;
        // Inspect is numeric metadata; use descriptors so hostile replies cannot run getters.
        if (
          !result ||
          typeof result !== 'object' ||
          types.isProxy(result) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(result)) ||
          Reflect.ownKeys(result).length !== 2
        )
          throw fail();
        for (const name of ['records', 'bytes']) {
          const field = Object.getOwnPropertyDescriptor(result, name);
          if (!field?.enumerable || !Object.hasOwn(field, 'value') || field.value !== 0)
            throw fail();
        }
        if (!expired(read())) throw fail();
        return Object.freeze({ roots: catalog.length, expired: true });
      });
    },
  });
}

module.exports = { createCapacityRetentionWitness };
