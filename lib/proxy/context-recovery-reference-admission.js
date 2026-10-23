'use strict';

const { validateReferenceAdmission } = require('./context-recovery-reference-state');
const { storageFailure } = require('./context-recovery-storage-contract');
const { types } = require('node:util');

function assertData(input) {
  let nodes = 65536;
  const ancestors = new Set();
  function visit(value, depth) {
    if (--nodes < 0 || depth > 64) throw storageFailure();
    if (value === null || typeof value !== 'object') return;
    if (types.isProxy(value) || ancestors.has(value)) throw storageFailure();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))
      throw storageFailure();
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const slot = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== 'string' ||
        !slot ||
        !Object.hasOwn(slot, 'value') ||
        (!slot.enumerable && !(array && key === 'length'))
      )
        throw storageFailure();
      if (!(array && key === 'length')) visit(slot.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, 0);
}

// A live owner's pre-write view is only a comparison precondition.
// Validate it against the authenticated row under the same write transaction
// that saves a budget debit or publication. It never grants source read access.
function assertRecoveryReferenceAdmission(stored, current) {
  try {
    assertData(stored);
    assertData(current);
    return validateReferenceAdmission(stored, current);
  } catch {
    throw storageFailure();
  }
}

module.exports = { assertRecoveryReferenceAdmission };
