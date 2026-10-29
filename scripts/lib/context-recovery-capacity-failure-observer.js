'use strict';

const { types } = require('node:util');
const { rejectAsyncReaderResult } = require('../../lib/proxy/context-recovery-reader-result');
const { declareCapacityFailure } = require('./context-recovery-capacity-failure');

function createCapacityFailureObserver(callback) {
  if (
    callback !== undefined &&
    (typeof callback !== 'function' ||
      types.isProxy(callback) ||
      types.isAsyncFunction(callback) ||
      types.isGeneratorFunction(callback))
  )
    throw new Error('persistent_capacity_execution_failed');
  let notified = false;
  let failed = false;
  return {
    notify(primary) {
      if (notified || callback === undefined) return;
      notified = true;
      try {
        // Only a branded, empty token crosses the boundary, never driver data.
        const result = callback(declareCapacityFailure(Object.freeze({}), primary));
        rejectAsyncReaderResult(result);
        if (result !== undefined) failed = true;
      } catch {
        // Defer rejection to the workload loop so its finally still closes.
        failed = true;
      }
    },
    failed: () => failed,
  };
}

module.exports = { createCapacityFailureObserver };
