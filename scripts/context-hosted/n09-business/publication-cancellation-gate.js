'use strict';
const { types } = require('node:util');
const { performance } = require('node:perf_hooks');
const { fields, isN09NativePromise, discardN09PromiseRejection } = require('../n09-ack/contract');
const fail = () => new Error('n09_publication_cancellation_gate_failed');
const keys = ['generation', 'callOrdinal', 'rootId', 'expiresAt', 'expectedRevision', 'transition'];
const observedKeys = [...keys, 'activeCount', 'operation', 'status'];

// Private acceptance seam after the original publication action has resolved.
// This only pauses its caller; it cannot manufacture cancellation, a durable
// transition, an ACK or a public response. Nothing here authorizes a receipt.
function createPublicationCancellationGate(input) {
  let config;
  try {
    config = fields(input, ['inspect', 'publish', 'released', 'pause', 'now']);
    for (const [name, fn] of Object.entries(config))
      if (
        typeof fn !== 'function' ||
        types.isProxy(fn) ||
        types.isGeneratorFunction(fn) ||
        (name !== 'pause' && types.isAsyncFunction(fn))
      )
        throw fail();
  } catch {
    throw fail();
  }
  let state = 'idle',
    target,
    lastTime,
    rejectWaiting,
    preparedOrdinal;
  function available() {
    if (state === 'failed' || state === 'closed') throw fail();
  }
  function invoke(name, ...args) {
    available();
    const value = Reflect.apply(config[name], undefined, args);
    discardN09PromiseRejection(value);
    if (types.isPromise(value)) throw fail();
    available();
    return value;
  }
  function now() {
    const value = invoke('now');
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - 5000 ||
      (lastTime !== undefined && value < lastTime)
    )
      throw fail();
    lastTime = value;
    return value;
  }
  function reject() {
    if (state !== 'closed') state = 'failed';
    rejectWaiting?.(fail());
  }
  async function pause(ms, remaining) {
    const pending = Reflect.apply(config.pause, undefined, [ms]);
    if (!isN09NativePromise(pending)) {
      discardN09PromiseRejection(pending);
      throw fail();
    }
    discardN09PromiseRejection(pending);
    let timer;
    const stopped = new Promise((_, reject) => {
      rejectWaiting = reject;
      timer = setTimeout(() => reject(fail()), remaining);
    });
    try {
      available();
      if ((await Promise.race([pending, stopped])) !== undefined) throw fail();
      available();
    } finally {
      clearTimeout(timer);
      rejectWaiting = undefined;
    }
  }
  return Object.freeze({
    arm(input) {
      try {
        available();
        if (state !== 'idle') throw fail();
        const value = fields(input, keys);
        if (
          !Number.isSafeInteger(value.generation) ||
          value.generation < 1 ||
          value.generation > 16 ||
          !Number.isSafeInteger(value.callOrdinal) ||
          value.callOrdinal < 1 ||
          value.callOrdinal >= 1024 ||
          typeof value.rootId !== 'string' ||
          value.rootId.length !== 36 ||
          !/^hbs_[a-f0-9]{32}$/.test(value.rootId) ||
          !Number.isSafeInteger(value.expiresAt) ||
          value.expiresAt < 1 ||
          !Number.isSafeInteger(value.expectedRevision) ||
          value.expectedRevision < 2 ||
          value.expectedRevision >= Number.MAX_SAFE_INTEGER ||
          !['withdrawn', 'uncertain'].includes(value.transition) ||
          (value.transition === 'uncertain' && value.expectedRevision < 3) ||
          value.callOrdinal + (value.transition === 'uncertain' ? 3 : 2) > 1024
        )
          throw fail();
        target = Object.freeze(value);
        state = 'armed';
      } catch {
        reject();
        throw fail();
      }
    },
    async afterPublicationAction(action) {
      try {
        available();
        if (state === 'idle' || state === 'released') return;
        if (state !== 'armed') throw fail();
        // Uncertain needs the genuine sending ACK as well as prepared. The
        // independent ACK boundary validates that prefix; this gate never
        // consumes or replaces either original token.
        const first = target.transition === 'uncertain' && action === 'prepare';
        if (
          first
            ? preparedOrdinal !== undefined
            : action !== (target.transition === 'withdrawn' ? 'prepare' : 'sending') ||
              (target.transition === 'uncertain' && preparedOrdinal === undefined)
        )
          throw fail();
        state = 'validating';
        const hardDeadline = performance.now() + 5000;
        const deadline = now() + 5000;
        const remainingTime = () => Math.min(deadline - now(), hardDeadline - performance.now());
        const observed = fields(invoke('inspect'), observedKeys);
        if (
          observed.generation !== target.generation ||
          !Number.isSafeInteger(observed.callOrdinal) ||
          observed.callOrdinal <= (preparedOrdinal ?? target.callOrdinal) ||
          observed.callOrdinal > 1024 ||
          observed.activeCount !== 0 ||
          observed.operation !== 'save-reference-state' ||
          observed.status !== 'completed' ||
          observed.transition !== (action === 'prepare' ? 'prepared' : 'sending') ||
          observed.rootId !== target.rootId ||
          observed.expiresAt !== target.expiresAt ||
          observed.expectedRevision !== target.expectedRevision - (first ? 2 : 1)
        )
          throw fail();
        if (remainingTime() <= 0) throw fail();
        if (first) {
          preparedOrdinal = observed.callOrdinal;
          state = 'armed';
          return;
        }
        const receipt = Object.freeze({
          ...target,
          callOrdinal: observed.callOrdinal,
          revision: target.expectedRevision,
        });
        state = 'publishing';
        if (invoke('publish', receipt) !== undefined || state !== 'publishing') throw fail();
        state = 'holding';
        for (;;) {
          if (remainingTime() <= 0) throw fail();
          const released = invoke('released');
          if (typeof released !== 'boolean' || state !== 'holding' || remainingTime() <= 0)
            throw fail();
          if (released) {
            state = 'released';
            return;
          }
          const remaining = remainingTime();
          if (remaining <= 0) throw fail();
          await pause(Math.min(10, remaining), remaining);
        }
      } catch {
        reject();
        throw fail();
      }
    },
    inspect() {
      return Object.freeze({ state, daemonQualified: false });
    },
    close() {
      state = 'closed';
      rejectWaiting?.(fail());
    },
  });
}
module.exports = { createPublicationCancellationGate };
