'use strict';

const { types } = require('node:util');
const { fields, discardN09PromiseRejection } = require('../n09-ack/contract');
const fail = () => new Error('n09_publication_ack_boundary_failed');
const transitions = new Set([
  'prepared',
  'sending',
  'transport-finished',
  'uncertain',
  'withdrawn',
]);
const factsKeys = ['rootId', 'expiresAt', 'revision'];
const baselineKeys = [
  'generation',
  'callOrdinal',
  'rootId',
  'expiresAt',
  'expectedRevision',
  'transition',
];
const observedKeys = [
  'generation',
  'callOrdinal',
  'activeCount',
  'operation',
  'transition',
  'rootId',
  'expiresAt',
  'expectedRevision',
  'status',
];

// Private acceptance composition only. The runtime hook calls this AFTER the
// genuine producer and BEFORE exposing its original opaque ACK. No storage
// operation, token, reference, payload, authorization or deadline is replaced.
function createPublicationAckBoundary(input) {
  let config;
  try {
    config = fields(input, ['inspect', 'publish', 'released', 'sleep', 'now']);
    if (
      Object.values(config).some(
        (value) =>
          typeof value !== 'function' ||
          types.isProxy(value) ||
          types.isAsyncFunction(value) ||
          types.isGeneratorFunction(value)
      )
    )
      throw fail();
  } catch {
    throw fail();
  }
  let state = 'idle',
    baseline,
    lastTime,
    cursor,
    ordinal,
    predecessors,
    predecessorIndex;
  function available() {
    if (state === 'closed' || state === 'failed') throw fail();
  }
  function invoke(name, ...args) {
    available();
    const value = config[name](...args);
    discardN09PromiseRejection(value);
    if (types.isPromise(value)) throw fail();
    available();
    return value;
  }
  function now() {
    const time = invoke('now');
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      time > Number.MAX_SAFE_INTEGER - 5000 ||
      (lastTime !== undefined && time < lastTime)
    )
      throw fail();
    lastTime = time;
    return time;
  }
  return Object.freeze({
    arm(input, route = 'direct') {
      try {
        available();
        if (state !== 'idle') throw fail();
        const value = fields(input, baselineKeys);
        if (
          !Number.isSafeInteger(value.generation) ||
          value.generation < 1 ||
          value.generation > 16 ||
          !Number.isSafeInteger(value.callOrdinal) ||
          value.callOrdinal < 1 ||
          value.callOrdinal >= 1024 ||
          typeof value.rootId !== 'string' ||
          !/^hbs_[a-f0-9]{32}$/.test(value.rootId) ||
          !Number.isSafeInteger(value.expiresAt) ||
          value.expiresAt < 1 ||
          !Number.isSafeInteger(value.expectedRevision) ||
          value.expectedRevision < 1 ||
          value.expectedRevision >= Number.MAX_SAFE_INTEGER ||
          !transitions.has(value.transition)
        )
          throw fail();
        if (!['direct', 'prepared-prefix'].includes(route)) throw fail();
        if (
          route === 'prepared-prefix' &&
          !['sending', 'transport-finished', 'uncertain', 'withdrawn'].includes(value.transition)
        )
          throw fail();
        predecessors =
          route === 'direct'
            ? []
            : ['sending', 'withdrawn'].includes(value.transition)
              ? ['prepared']
              : ['prepared', 'sending'];
        cursor = value.expectedRevision - predecessors.length;
        if (cursor < 1 || value.callOrdinal + predecessors.length >= 1024) throw fail();
        ordinal = value.callOrdinal;
        predecessorIndex = 0;
        baseline = Object.freeze(value);
        state = 'armed';
      } catch {
        state = 'failed';
        throw fail();
      }
    },
    afterDurableAck(input) {
      try {
        available();
        if (state === 'idle' || state === 'released') return;
        if (state !== 'armed') throw fail();
        const facts = fields(input, factsKeys);
        if (
          facts.rootId !== baseline.rootId ||
          facts.expiresAt !== baseline.expiresAt ||
          facts.revision !== cursor + 1
        )
          throw fail();
        // Validation callbacks cannot recursively authenticate another ACK,
        // even if their caller catches the nested rejection.
        state = 'validating';
        const observed = fields(invoke('inspect'), observedKeys);
        if (
          observed.generation !== baseline.generation ||
          observed.activeCount !== 0 ||
          observed.status !== 'completed' ||
          observed.operation !== 'save-reference-state' ||
          observed.transition !== (predecessors[predecessorIndex] ?? baseline.transition) ||
          observed.rootId !== baseline.rootId ||
          observed.expiresAt !== baseline.expiresAt ||
          observed.expectedRevision !== cursor ||
          !Number.isSafeInteger(observed.callOrdinal) ||
          observed.callOrdinal <= ordinal ||
          observed.callOrdinal > 1024
        )
          throw fail();
        if (predecessorIndex < predecessors.length) {
          // Only the fixed, exact predecessor chain may return its genuine
          // ACK. It grants no held receipt and cannot skip the target write.
          predecessorIndex++;
          cursor++;
          ordinal = observed.callOrdinal;
          state = 'armed';
          return;
        }
        state = 'holding';
        const deadline = now() + 5000;
        const receipt = Object.freeze({
          boundary: 'durable-store-before-host-ack',
          transition: baseline.transition,
          generation: observed.generation,
          callOrdinal: observed.callOrdinal,
          ...facts,
        });
        if (invoke('publish', receipt) !== undefined) throw fail();
        for (let polls = 0; polls < 512; polls++) {
          if (now() >= deadline) throw fail();
          const released = invoke('released');
          if (typeof released !== 'boolean' || now() >= deadline) throw fail();
          if (released) {
            baseline = undefined;
            state = 'released';
            return;
          }
          if (invoke('sleep', 10) !== undefined) throw fail();
        }
        throw fail();
      } catch {
        baseline = undefined;
        state = 'failed';
        throw fail();
      }
    },
    inspect: () => Object.freeze({ state, daemonQualified: false }),
    close() {
      baseline = undefined;
      state = 'closed';
    },
  });
}

module.exports = { createPublicationAckBoundary };
