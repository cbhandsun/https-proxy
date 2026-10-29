'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkWithdrawal } = require('../../scripts/context-hosted/n08/observed-boundary.js');
const owner = { pid: 123, manifestSha256: 'a'.repeat(64), nonce: 'b'.repeat(32) };
function evidence(rootId = 'hbs_' + 'c'.repeat(32)) {
  return {
    response: { status: 403, bytes: Buffer.from('{"error":{"code":"context_recovery_disabled"}}') },
    ownerStatus: { ...owner, alive: true },
    externalToolReplays: 0,
    oldRootPrivateRequestDelta: 0,
    inFlightDefaultDispatchDelta: 0,
    before: { rootId, expiresAt: 1000, readerCalls: 2, readerBytes: 200 },
    after: { rootId, expiresAt: 1000, readerCalls: 3, readerBytes: 300 },
  };
}
test('withdrawal compares actual hbs root identity, fixed expiry and cumulative counters', () => {
  assert.doesNotThrow(() => checkWithdrawal(evidence(), owner));
  for (const rootId of [
    'c'.repeat(64),
    'hbs_' + 'c'.repeat(31),
    'hbs_' + 'c'.repeat(33),
    'hbs_' + 'C'.repeat(32),
    '',
    null,
  ]) {
    assert.throws(() => checkWithdrawal(evidence(rootId), owner));
  }
  for (const patch of [
    { rootId: 'hbs_' + 'd'.repeat(32) },
    { expiresAt: 1001 },
    { readerCalls: 1 },
    { readerBytes: 199 },
  ]) {
    const value = evidence();
    Object.assign(value.after, patch);
    assert.throws(() => checkWithdrawal(value, owner));
  }
});
