'use strict';
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { storageFailure } = require('./context-recovery-storage-contract');
const PHASES = Object.freeze([
  'verify_before_started',
  'verify_before_finished',
  'engine_execute_started',
  'engine_execute_finished',
  'engine_snapshot_started',
  'engine_snapshot_finished',
  'anchor_persist_started',
  'anchor_persist_finished',
  'verify_after_started',
  'verify_after_finished',
]);
const noop = Object.freeze({ advance() {}, finish() {} });
function callback(value) {
  if (value !== undefined && (typeof value !== 'function' || types.isProxy(value)))
    throw storageFailure();
}
function emit(observer, value) {
  try {
    const result = observer?.(Object.freeze(value));
    if (nativeReaderPromise(result))
      Promise.prototype.then.call(
        result,
        () => {},
        () => {}
      );
  } catch {
    /* Optional observation never changes storage admission or ACK. */
  }
}
// Only fixed phase/sequence/time metadata crosses the worker boundary. This
// observation owns no timer, request, result, exception or authority to ACK.
function createStorageExecutionProgress(observer) {
  callback(observer);
  let sequence = 0;
  return {
    begin() {
      if (observer === undefined) return noop;
      const current = ++sequence,
        started = performance.now();
      let index = -1,
        finished = false;
      const report = (phase) =>
        emit(observer, {
          sequence: current,
          phase,
          elapsedMs: Math.min(60000, Math.max(0, Math.floor(performance.now() - started))),
        });
      return {
        advance(phase) {
          if (finished || PHASES[index + 1] !== phase) throw storageFailure();
          index++;
          report(phase);
        },
        finish(success) {
          if (finished) return;
          if (typeof success !== 'boolean' || (success && index !== PHASES.length - 1))
            throw storageFailure();
          finished = true;
          report(success ? 'completed' : 'failed');
        },
      };
    },
  };
}
function createStorageExecutionObserver(observer) {
  callback(observer);
  let sequence = 0,
    index = -1,
    elapsed = 0,
    finished = true;
  return (input) => {
    if (
      !input ||
      typeof input !== 'object' ||
      types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw storageFailure();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 3 || keys.some((key) => !['sequence', 'phase', 'elapsedMs'].includes(key)))
      throw storageFailure();
    const value = {};
    for (const key of ['sequence', 'phase', 'elapsedMs']) {
      const slot = Object.getOwnPropertyDescriptor(input, key);
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw storageFailure();
      value[key] = slot.value;
    }
    if (
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 ||
      !Number.isSafeInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 60000 ||
      typeof value.phase !== 'string'
    )
      throw storageFailure();
    const next = finished && value.sequence === sequence + 1;
    const previous = next ? -1 : index;
    if (
      (!next && (finished || value.sequence !== sequence || value.elapsedMs < elapsed)) ||
      (value.phase !== 'failed' &&
        value.phase !== PHASES[previous + 1] &&
        !(value.phase === 'completed' && previous === PHASES.length - 1)) ||
      (next && value.phase !== PHASES[0])
    )
      throw storageFailure();
    sequence = value.sequence;
    elapsed = value.elapsedMs;
    finished = ['completed', 'failed'].includes(value.phase);
    index = finished ? previous : previous + 1;
    emit(observer, value);
  };
}
module.exports = { createStorageExecutionProgress, createStorageExecutionObserver };
