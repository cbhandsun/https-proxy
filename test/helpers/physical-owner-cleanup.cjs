'use strict';

// Trusted synchronous test callbacks only. Keep the original thrown value and
// attempt every cleanup once; a later cleanup must not erase earlier evidence.
function finishPhysicalOwnerCleanup(primaryFailures, actions) {
  const failures = primaryFailures.slice();
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      failures.push(error);
    }
  }
  reportCleanupFailures(primaryFailures, failures);
}

// Trusted fixture callbacks only; await cleanup without rerunning the scenario.
async function finishPhysicalOwnerCleanupAsync(primaryFailures, actions) {
  const failures = primaryFailures.slice();
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  reportCleanupFailures(primaryFailures, failures);
}

function reportCleanupFailures(primaryFailures, failures) {
  if (failures.length > primaryFailures.length) {
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, 'physical_owner_cleanup_failed');
  }
}

module.exports = { finishPhysicalOwnerCleanup, finishPhysicalOwnerCleanupAsync };
