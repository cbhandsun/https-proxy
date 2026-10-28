'use strict';
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const { exact, snapshotOwnData } = require('../shared/boundary');
const { discardN09PromiseRejection, isN09NativePromise } = require('../n09-ack/contract');
const { createPublicationCommitWitness } = require('./publication-commit-witness');
const fail = () => new Error('n09_prepared_commit_boundary_failed');

// Private acceptance composition. Read admission alone is insufficient: the
// fresh authenticated sample must identify the one actual target write.
async function createPublicationCommitBoundary(
  input,
  query,
  createWitness = createPublicationCommitWitness,
  transition = 'prepared'
) {
  let witness, closeWitnessMethod;
  let witnessClosed = false,
    witnessCloseFailed = false;
  function closeWitness() {
    if (!closeWitnessMethod) return;
    if (witnessClosed) {
      if (witnessCloseFailed) throw fail();
      return;
    }
    witnessClosed = true;
    try {
      const result = Reflect.apply(closeWitnessMethod, witness, []);
      if (result !== undefined) {
        discardN09PromiseRejection(result);
        throw fail();
      }
    } catch {
      witnessCloseFailed = true;
      throw fail();
    }
  }
  try {
    if (
      !['prepared', 'sending', 'transport-finished', 'withdrawn', 'uncertain'].includes(transition)
    )
      throw fail();
    const config = exact(input, ['ownedRoot', 'runtimeDir', 'rootId', 'expiresAt', 'revision']);
    if (
      typeof query !== 'function' ||
      types.isProxy(query) ||
      typeof createWitness !== 'function' ||
      types.isProxy(createWitness) ||
      types.isAsyncFunction(createWitness) ||
      typeof config.rootId !== 'string' ||
      config.rootId.length !== 36 ||
      !/^hbs_[a-f0-9]{32}$/.test(config.rootId) ||
      !Number.isSafeInteger(config.expiresAt) ||
      config.expiresAt < 1 ||
      !Number.isSafeInteger(config.revision) ||
      config.revision < 1 ||
      config.revision === Number.MAX_SAFE_INTEGER
    )
      throw fail();
    const ask = (timeout) => {
      const result = query(timeout);
      if (!isN09NativePromise(result)) {
        discardN09PromiseRejection(result);
        throw fail();
      }
      return result;
    };
    const baseline = snapshotOwnData(await ask(750));
    if (
      baseline.activeCount !== 0 ||
      !['idle', 'completed'].includes(baseline.status) ||
      !Number.isSafeInteger(baseline.generation) ||
      baseline.generation < 1 ||
      baseline.generation > 16 ||
      !Number.isSafeInteger(baseline.callOrdinal) ||
      baseline.callOrdinal < 1 ||
      baseline.callOrdinal > 1024
    )
      throw fail();
    const resource = createWitness({
      ownedRoot: config.ownedRoot,
      runtimeDir: config.runtimeDir,
      expectedRevision: config.revision,
    });
    if (types.isPromise(resource)) {
      discardN09PromiseRejection(resource);
      throw fail();
    }
    if (
      !resource ||
      typeof resource !== 'object' ||
      types.isProxy(resource) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(resource))
    )
      throw fail();
    // Capture only a safe own synchronous cleanup before checking the rest of
    // the factory result. A malformed result may already own a real read lock.
    witness = resource;
    const cleanup = Object.getOwnPropertyDescriptor(resource, 'close');
    if (
      cleanup &&
      Object.hasOwn(cleanup, 'value') &&
      typeof cleanup.value === 'function' &&
      !types.isProxy(cleanup.value) &&
      !types.isAsyncFunction(cleanup.value) &&
      !types.isGeneratorFunction(cleanup.value)
    )
      closeWitnessMethod = cleanup.value;
    const methods = exact(resource, ['waitPending', 'release', 'close']);
    if (
      Object.values(methods).some(
        (value) =>
          typeof value !== 'function' || types.isProxy(value) || types.isGeneratorFunction(value)
      ) ||
      types.isAsyncFunction(methods.close) ||
      types.isAsyncFunction(methods.release)
    )
      throw fail();
    let closed = false,
      observed = false,
      waiting = false,
      closeFailed = false;
    return Object.freeze({
      async waitPending() {
        try {
          if (closed || waiting || observed) throw fail();
          waiting = true;
          const deadline = performance.now() + 750;
          const pending = Reflect.apply(methods.waitPending, witness, []);
          if (!isN09NativePromise(pending)) {
            discardN09PromiseRejection(pending);
            throw fail();
          }
          const lock = exact(await pending, [
            'readAdmissionBlocked',
            'evidenceLevel',
            'publicationQualified',
          ]);
          const remaining = Math.floor(deadline - performance.now());
          if (
            closed ||
            remaining < 1 ||
            lock.readAdmissionBlocked !== true ||
            lock.evidenceLevel !== 'sqlite-read-admission-only' ||
            lock.publicationQualified !== false
          )
            throw fail();
          const state = snapshotOwnData(await ask(remaining));
          if (
            closed ||
            performance.now() >= deadline ||
            state.generation !== baseline.generation ||
            !Number.isSafeInteger(state.callOrdinal) ||
            state.callOrdinal <= baseline.callOrdinal ||
            state.callOrdinal > 1024 ||
            state.activeCount !== 1 ||
            state.status !== 'pending' ||
            state.operation !== 'save-reference-state' ||
            state.transition !== transition ||
            state.rootId !== config.rootId ||
            state.expiresAt !== config.expiresAt ||
            state.expectedRevision !== config.revision
          )
            throw fail();
          observed = true;
          return Object.freeze({
            boundary: transition + '-save-reference-state-commit-pending',
            readAdmissionBlocked: true,
            actualPreparedWritePending: transition === 'prepared',
            ...(transition !== 'prepared'
              ? { actualTransitionWritePending: true, transition }
              : {}),
            expectedRevision: config.revision,
          });
        } catch {
          closed = true;
          try {
            closeWitness();
          } catch {
            closeFailed = true;
          }
          throw fail();
        } finally {
          waiting = false;
        }
      },
      release() {
        if (closed || waiting || !observed) throw fail();
        try {
          const result = exact(Reflect.apply(methods.release, witness, []), ['released']);
          if (result.released !== true) throw fail();
          closed = true;
          return Object.freeze({ released: true });
        } catch {
          closed = true;
          closeFailed = true;
          try {
            closeWitness();
          } catch {
            /* already rejected */
          }
          throw fail();
        }
      },
      close() {
        if (closed) {
          if (closeFailed) throw fail();
          return;
        }
        closed = true;
        try {
          closeWitness();
        } catch {
          closeFailed = true;
          throw fail();
        }
      },
    });
  } catch {
    try {
      closeWitness();
    } catch {
      /* construction is rejected */
    }
    throw fail();
  }
}
const createPreparedCommitBoundary = (input, query, createWitness) =>
  createPublicationCommitBoundary(input, query, createWitness, 'prepared');
module.exports = { createPreparedCommitBoundary, createPublicationCommitBoundary };
