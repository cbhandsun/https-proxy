'use strict';

const { performance } = require('node:perf_hooks');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { storageFailure } = require('./context-recovery-storage-contract');

const STORAGE_STARTUP_PHASES = Object.freeze([
  'worker_started',
  'paths_started',
  'paths_ready',
  'ownership_started',
  'ownership_acquired',
  'key_protect_started',
  'key_protect_finished',
  'key_write_started',
  'key_write_finished',
  'key_unprotect_started',
  'key_unprotect_finished',
  'database_prepare_started',
  'database_prepared',
  'database_opened',
  'engine_ready',
]);

// A bounded observation only: no request data, selectors, native exceptions or
// timer control. Observer failures cannot change admission or storage results.
function createStorageStartupProgress(observer) {
  if (observer !== undefined && typeof observer !== 'function') throw storageFailure();
  const started = performance.now();
  let last = -1;
  let finished = false;
  function report(phase) {
    try {
      const result = observer?.(
        Object.freeze({
          phase,
          elapsedMs: Math.max(0, Math.floor(performance.now() - started)),
        })
      );
      if (nativeReaderPromise(result))
        Promise.prototype.then.call(
          result,
          () => {},
          () => {}
        );
    } catch {
      // Diagnostics are optional and never authorize or fail a transaction.
    }
  }
  return {
    advance(phase) {
      const index = STORAGE_STARTUP_PHASES.indexOf(phase);
      if (finished || index < 0 || index <= last) throw storageFailure();
      last = index;
      report(phase);
    },
    finish(success) {
      if (finished) return;
      finished = true;
      report(success ? 'ready' : 'failed');
    },
  };
}

module.exports = { createStorageStartupProgress };
