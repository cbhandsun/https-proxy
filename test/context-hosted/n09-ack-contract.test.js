'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createN09AckContract,
  parseN09AckCommand,
  parseN09AckReceipt,
} = require('../../scripts/context-hosted/n09-ack/contract');
const config = { pid: 123, epoch: 'a'.repeat(32), signingKey: 'b'.repeat(64) };
const command = (extra = {}) => ({
  version: 1,
  operation: 'arm-save',
  pid: config.pid,
  epoch: config.epoch,
  sequence: 1,
  rootId: 'hbs_' + 'c'.repeat(32),
  expiresAt: 1000,
  minRevision: 1,
  ...extra,
});
const receipt = (extra = {}) => ({
  version: 1,
  kind: 'host-save-completed',
  durableBoundary: 'await-reference-save',
  pid: config.pid,
  epoch: config.epoch,
  sequence: 1,
  rootId: command().rootId,
  expiresAt: 1000,
  revision: 2,
  calls: 1,
  returnedBytes: 2,
  revisionSource: 'validated-reference-save',
  evidenceLevel: 'observer-boundary-only',
  liveDaemonProved: false,
  ...extra,
});
function safe(error) {
  assert.equal(error.message, 'n09_host_ack_rejected');
  assert.equal(error.code, error.message);
  assert.equal(error.cause, undefined);
  return true;
}

test('signed commands and receipts are canonical, detached and never claim runtime qualification', () => {
  const contract = createN09AckContract(config);
  const input = command();
  const signed = contract.signCommand(input);
  assert.deepEqual(contract.verifyCommand(signed), input);
  assert.ok(Object.isFrozen(signed) && Object.isFrozen(signed.payload));
  input.sequence = 2;
  assert.equal(signed.payload.sequence, 1);
  const reordered = Object.fromEntries(Object.entries(command()).reverse());
  assert.equal(contract.signCommand(reordered).signature, signed.signature);
  assert.deepEqual(contract.verifyReceipt(contract.signReceipt(receipt())), receipt());
  assert.throws(() => contract.verifyReceipt(signed), safe);
  assert.equal(JSON.stringify(signed).includes(config.signingKey), false);
  contract.close();
  contract.close();
  assert.throws(() => contract.signCommand(command()), safe);
  assert.throws(() => contract.verifyCommand(signed), safe);
});

test('signatures bind all fields, process, epoch, operation and independent secret', () => {
  const contract = createN09AckContract(config);
  const signed = contract.signCommand(command());
  for (const change of [
    { pid: 124 },
    { epoch: 'd'.repeat(32) },
    { operation: 'revoke-bound-root' },
    { sequence: 2 },
    { rootId: 'hbs_' + 'd'.repeat(32) },
    { expiresAt: 1001 },
    { minRevision: 2 },
  ]) {
    assert.throws(() => contract.verifyCommand({ ...signed, payload: command(change) }), safe);
  }
  const other = createN09AckContract({ ...config, signingKey: 'c'.repeat(64) });
  assert.throws(() => other.verifyCommand(signed), safe);
  for (const signature of ['', 'A'.repeat(64), '0'.repeat(64), '0'.repeat(64) + '\n', null, {}])
    assert.throws(() => contract.verifyCommand({ ...signed, signature }), safe);
  other.close();
  contract.close();
});

test('strict schemas reject malformed, empty, extreme and capability-bearing fields', () => {
  for (const input of [
    null,
    undefined,
    [],
    {},
    command({ version: 2 }),
    command({ operation: 'eval' }),
    command({ pid: 0 }),
    command({ epoch: 'a'.repeat(32) + '\n' }),
    command({ sequence: 0 }),
    command({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
    command({ rootId: '../root' }),
    command({ expiresAt: -1 }),
    command({ minRevision: 0 }),
    { ...command(), principal: 'private' },
    { ...command(), path: 'private' },
  ])
    assert.throws(() => parseN09AckCommand(input), safe);
  assert.equal(
    parseN09AckCommand(
      command({
        sequence: Number.MAX_SAFE_INTEGER,
        expiresAt: Number.MAX_SAFE_INTEGER,
        minRevision: Number.MAX_SAFE_INTEGER,
      })
    ).sequence,
    Number.MAX_SAFE_INTEGER
  );
  for (const extra of [
    { evidenceLevel: 'actual-host' },
    { liveDaemonProved: true },
    { calls: -1 },
    { returnedBytes: Infinity },
    { revision: 0 },
    { durableBoundary: 'database-read' },
  ])
    assert.throws(() => parseN09AckReceipt(receipt(extra)), safe);
});

test('contract never invokes getters, coercion or Proxy traps on unknown input', () => {
  let hits = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        hits++;
      },
      ownKeys() {
        hits++;
      },
      getPrototypeOf() {
        hits++;
      },
    }
  );
  const getter = command();
  Object.defineProperty(getter, 'pid', {
    enumerable: true,
    get() {
      hits++;
      return 123;
    },
  });
  const coercion = {
    toString() {
      hits++;
      return config.epoch;
    },
  };
  for (const input of [proxy, getter, command({ epoch: coercion })])
    assert.throws(() => parseN09AckCommand(input), safe);
  const contract = createN09AckContract(config);
  assert.throws(() => contract.verifyCommand(proxy), safe);
  assert.throws(() => createN09AckContract(proxy), safe);
  assert.throws(() => createN09AckContract({ ...config, signingKey: coercion }), safe);
  assert.equal(hits, 0);
  contract.close();
});
