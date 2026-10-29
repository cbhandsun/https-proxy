'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  declareCapacityFailure,
  capacityFailureReceipt,
} = require('../scripts/lib/context-recovery-capacity-failure');
const entry = (patch = {}) => ({
  operation: 'advance',
  stage: 'advance',
  commandIndex: 1,
  scheduledMs: 0,
  ...patch,
});
const safe = { message: 'persistent_capacity_execution_failed' };

test('failure proof is immutable, bounded metadata attached only to its owned result or error', () => {
  const error = Error('private');
  assert.equal(
    declareCapacityFailure(
      error,
      entry(),
      entry({ operation: 'close', stage: 'storage-close', commandIndex: 2, scheduledMs: 86400000 })
    ),
    error
  );
  const receipt = capacityFailureReceipt(error);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.primary), true);
  assert.equal(Object.isFrozen(receipt.cleanup), true);
  assert.throws(() => {
    receipt.primary.operation = 'private';
  }, TypeError);
  assert.equal(JSON.stringify(receipt).includes('private'), false);
  assert.equal(capacityFailureReceipt({ primary: entry() }), null);
  assert.equal(capacityFailureReceipt(Error('private')), null);
  const clean = {};
  assert.equal(declareCapacityFailure(clean), clean);
  assert.equal(capacityFailureReceipt(clean), null);
  const extreme = {};
  declareCapacityFailure(
    extreme,
    entry({ commandIndex: Number.MAX_SAFE_INTEGER, scheduledMs: 86400000 })
  );
  assert.equal(capacityFailureReceipt(extreme).primary.commandIndex, Number.MAX_SAFE_INTEGER);
});

test('invalid and executable proof inputs reject without running hooks or copying private data', () => {
  let touched = 0;
  const hostile = Object.defineProperty(entry(), 'operation', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const proxy = new Proxy(entry(), {
    ownKeys() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const inherited = Object.create(entry());
  const hidden = Object.defineProperty(entry(), 'stage', { enumerable: false, value: 'advance' });
  for (const value of [
    null,
    false,
    0,
    '',
    [],
    {},
    hostile,
    proxy,
    inherited,
    hidden,
    entry({ extra: true }),
    entry({ operation: 'PRIVATE' }),
    entry({ stage: 'PRIVATE' }),
    entry({ commandIndex: 0 }),
    entry({ commandIndex: 1.5 }),
    entry({ commandIndex: Infinity }),
    entry({ scheduledMs: -1 }),
    entry({ scheduledMs: 86400001 }),
    entry({ scheduledMs: NaN }),
  ]) {
    assert.throws(() => declareCapacityFailure({}, value), safe);
  }
  assert.throws(() => declareCapacityFailure({}, undefined, entry()), safe);
  for (const invalid of [null, false, 0, '', {}, entry({ scheduledMs: -1 })])
    assert.throws(() => declareCapacityFailure({}, entry(), invalid), safe);
  for (const owner of [null, 1, '', () => {}, proxy])
    assert.throws(() => declareCapacityFailure(owner, entry()), safe);
  for (const owner of [undefined, null, false, 1, 'private', Symbol(), proxy, hostile])
    assert.equal(capacityFailureReceipt(owner), null);
  assert.equal(touched, 0);
});
