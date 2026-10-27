'use strict';

const { types } = require('node:util');
const { performance } = require('node:perf_hooks');
const OPERATIONS = new Set([
  'catalog',
  'scan',
  'scan-reference',
  'inspect',
  'load',
  'load-reference',
  'save',
  'save-reference',
  'save-reference-state',
  'read-source',
  'read-source-and-settle',
  'settle-reader',
  'revoke',
  'revoke-all',
  'revoke-scopes',
  'sweep',
]);
const KEYS = ['sequence', 'operation', 'status', 'elapsedMs'];
const fail = () => new Error('publication_operation_progress_invalid');

// Private fixture observation only. No request data, scope, result or exception
// crosses this boundary; neither a start nor a completion confers qualification.
function createPublicationOperationProgress() {
  let last = null;
  let sequence = 0;
  const active = new Map();
  const samples = [];
  return {
    observe(input) {
      if (
        !input ||
        typeof input !== 'object' ||
        types.isProxy(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      )
        throw fail();
      const names = Reflect.ownKeys(input);
      if (names.length !== KEYS.length || names.some((name) => !KEYS.includes(name))) throw fail();
      const value = {};
      for (const name of KEYS) {
        const slot = Object.getOwnPropertyDescriptor(input, name);
        if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
        value[name] = slot.value;
      }
      if (
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        value.sequence > 128 ||
        typeof value.operation !== 'string' ||
        !OPERATIONS.has(value.operation) ||
        !['started', 'completed', 'failed'].includes(value.status) ||
        !Number.isSafeInteger(value.elapsedMs) ||
        value.elapsedMs < 0 ||
        value.elapsedMs > 60000 ||
        (last && value.elapsedMs < last.elapsedMs)
      )
        throw fail();
      if (value.status === 'started') {
        if (value.sequence !== sequence + 1) throw fail();
        sequence = value.sequence;
        active.set(value.sequence, value.operation);
      } else {
        if (active.get(value.sequence) !== value.operation) throw fail();
        active.delete(value.sequence);
      }
      last = value;
      samples.push(value);
      if (samples.length > 16) samples.shift();
    },
    describe() {
      return last ? { ...last } : null;
    },
    snapshot() {
      return samples.map((value) => ({ ...value }));
    },
  };
}

function observePublicationOperations(execute, emit, now = () => performance.now()) {
  if ([execute, emit, now].some((value) => typeof value !== 'function' || types.isProxy(value)))
    throw fail();
  const progress = createPublicationOperationProgress();
  const origin = now();
  if (!Number.isFinite(origin) || origin < 0) throw fail();
  let sequence = 0;
  return async (request) => {
    if (!request || typeof request !== 'object' || types.isProxy(request)) throw fail();
    const slot = Object.getOwnPropertyDescriptor(request, 'operation');
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    const current = ++sequence;
    const publish = (status) => {
      progress.observe({
        sequence: current,
        operation: slot.value,
        status,
        elapsedMs: Math.round(now() - origin),
      });
      emit(progress.describe());
    };
    publish('started');
    let result;
    try {
      result = await execute(request);
    } catch (error) {
      try {
        publish('failed');
      } catch (observationError) {
        throw new AggregateError(
          [error, observationError],
          'publication_operation_observation_failed',
          { cause: observationError }
        );
      }
      throw error;
    }
    publish('completed');
    return result;
  };
}

module.exports = { createPublicationOperationProgress, observePublicationOperations };
