'use strict';

const { types } = require('node:util');
const { storageFailure } = require('./context-recovery-storage-contract');
const failures = new WeakMap();
const phases = new Set([
  'engine-execute',
  'engine-snapshot',
  'anchor-persist',
  'anchor-snapshot',
  'anchor-successor',
  'anchor-admission-receipt',
  'anchor-identity-before',
  'anchor-prepare',
  'anchor-channel-open',
  'anchor-request',
  'anchor-reply',
  'anchor-identity-after',
  'anchor-receipt',
  'owner-verify',
  'owner-close',
  'worker-unavailable',
  'worker-rejected',
]);

function parseStorageFailureDiagnostic(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 2
  )
    throw storageFailure();
  const values = {};
  for (const name of ['phase', 'cleanupFailed']) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw storageFailure();
    values[name] = slot.value;
  }
  if (!phases.has(values.phase) || typeof values.cleanupFailed !== 'boolean')
    throw storageFailure();
  return Object.freeze(values);
}

// No exception fields, messages, causes or stacks are inspected or retained.
// These labels are observations only and cannot authorize a storage result.
// cleanupFailed=false records no observed secondary failure; it is never a
// cleanup acknowledgement (especially when the worker became unavailable).
function storageExecutionFailure(phase, cleanupFailed = false) {
  const error = storageFailure();
  failures.set(error, parseStorageFailureDiagnostic({ phase, cleanupFailed }));
  return error;
}
function storageFailureDiagnostic(error) {
  return failures.get(error) ?? null;
}
function transferStorageFailure(error) {
  const receipt = storageFailureDiagnostic(error);
  return receipt ? storageExecutionFailure(receipt.phase, receipt.cleanupFailed) : storageFailure();
}
function createStorageFailureReporter(observer) {
  if (observer !== undefined && (typeof observer !== 'function' || types.isProxy(observer)))
    throw storageFailure();
  return (operation, diagnostic) => {
    try {
      const result = observer?.(Object.freeze({ operation, ...diagnostic }));
      if (types.isPromise(result))
        Promise.prototype.then.call(
          result,
          () => {},
          () => {}
        );
    } catch {
      // Observation cannot change failure, authorize success or retry work.
    }
  };
}
module.exports = {
  storageExecutionFailure,
  storageFailureDiagnostic,
  transferStorageFailure,
  parseStorageFailureDiagnostic,
  createStorageFailureReporter,
};
