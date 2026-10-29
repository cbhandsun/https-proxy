'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const {
  createN09BootstrapContract,
} = require('../../scripts/context-hosted/n09-ack/bootstrap-contract');
const config = { token: 'synthetic_'.repeat(4), pid: 123, manifestSha256: 'a'.repeat(64) };
const required = 'scripts/context-hosted/n09-ack/host-install.js';
const payload = () => ({
  version: 1,
  pid: config.pid,
  epoch: 'b'.repeat(32),
  manifestSha256: config.manifestSha256,
  sourcePins: {
    [required]: 'c'.repeat(64),
    'lib/example.cjs': 'd'.repeat(64),
    'package.json': 'e'.repeat(64),
  },
});
function safe(error) {
  assert.equal(error.message, 'n09_host_ack_rejected');
  assert.equal(error.code, error.message);
  assert.equal(error.cause, undefined);
  return true;
}

test('bootstrap signatures preserve ordered JSON and detach frozen payloads', () => {
  const contract = createN09BootstrapContract(config);
  const original = payload();
  const ordered = Object.fromEntries(Object.entries(original).reverse());
  ordered.sourcePins = Object.fromEntries(Object.entries(original.sourcePins).reverse());
  const signed = contract.sign(ordered);
  assert.equal(JSON.stringify(signed.payload), JSON.stringify(ordered));
  assert.equal(
    signed.signature,
    createHmac('sha256', config.token)
      .update('hpm.n09.bootstrap.v1\0' + JSON.stringify(ordered))
      .digest('hex')
  );
  const verified = contract.verify(signed);
  assert.deepEqual(verified, ordered);
  assert.notEqual(verified, signed.payload);
  assert.notEqual(verified.sourcePins, signed.payload.sourcePins);
  assert.ok(
    Object.isFrozen(verified) && Object.isFrozen(verified.sourcePins) && Object.isFrozen(signed)
  );
  ordered.sourcePins[required] = 'f'.repeat(64);
  assert.equal(verified.sourcePins[required], 'c'.repeat(64));
  assert.notEqual(contract.sign(original).signature, signed.signature);
  assert.equal(
    contract.mailboxKey(original),
    createHmac('sha256', config.token)
      .update(
        'hpm.n09.mailbox.key.v1\0' +
          config.pid +
          '\0' +
          original.epoch +
          '\0' +
          config.manifestSha256
      )
      .digest('hex')
  );
  assert.notEqual(
    contract.mailboxKey(original),
    contract.mailboxKey({ ...original, epoch: 'f'.repeat(32) })
  );
  contract.close();
});

test('bootstrap rejects cross-identity, tampered, malformed and closed envelopes', () => {
  const contract = createN09BootstrapContract(config);
  const signed = contract.sign(payload());
  for (const change of [
    { pid: 124 },
    { manifestSha256: 'f'.repeat(64) },
    { token: 'other_token_'.repeat(4) },
  ]) {
    const other = createN09BootstrapContract({ ...config, ...change });
    assert.throws(() => other.verify(signed), safe);
    other.close();
  }
  for (const value of [
    null,
    {},
    { ...signed, extra: 1 },
    { ...signed, signature: 'a'.repeat(64) + '\n' },
    { ...signed, payload: { ...signed.payload, epoch: 'f'.repeat(32) } },
  ])
    assert.throws(() => contract.verify(value), safe);
  for (const change of [
    { version: 2 },
    { pid: 0 },
    { epoch: 'B'.repeat(32) },
    { epoch: 'b'.repeat(31) + '\n' },
    { manifestSha256: 'f'.repeat(64) },
    { extra: 1 },
  ]) {
    assert.throws(() => contract.sign({ ...payload(), ...change }), safe);
    assert.throws(() => contract.mailboxKey({ ...payload(), ...change }), safe);
  }
  contract.close();
  contract.close();
  for (const operation of [
    () => contract.sign(payload()),
    () => contract.verify(signed),
    () => contract.mailboxKey(payload()),
  ])
    assert.throws(operation, safe);
});

test('bootstrap source pins enforce bounded relative path records', () => {
  const contract = createN09BootstrapContract(config);
  for (const name of [
    '',
    '/absolute.js',
    '../bad.js',
    'a/../bad.js',
    './bad.js',
    'a//bad.js',
    'a\\bad.js',
    'C:/bad.js',
    'a/\n.js',
    'a/\x7f.js',
    'a.txt',
    'a.js\n',
  ]) {
    assert.throws(
      () =>
        contract.sign({
          ...payload(),
          sourcePins: { [required]: 'c'.repeat(64), [name]: 'd'.repeat(64) },
        }),
      safe
    );
  }
  for (const sourcePins of [
    {},
    { 'a.js': 'c'.repeat(64) },
    { [required]: 'x'.repeat(64) },
    Object.assign(Object.create({ inherited: 1 }), payload().sourcePins),
    [],
    null,
  ]) {
    assert.throws(() => contract.sign({ ...payload(), sourcePins }), safe);
  }
  const sourcePins = { [required]: 'c'.repeat(64) };
  for (let index = 0; index < 511; index++) sourcePins['lib/' + index + '.js'] = 'd'.repeat(64);
  assert.equal(
    Object.keys(contract.verify(contract.sign({ ...payload(), sourcePins })).sourcePins).length,
    512
  );
  sourcePins['lib/overflow.js'] = 'e'.repeat(64);
  assert.throws(() => contract.sign({ ...payload(), sourcePins }), safe);
  contract.close();
});

test('bootstrap rejects accessors and proxies without executing their traps', () => {
  const contract = createN09BootstrapContract(config);
  let calls = 0;
  const hostile = () => {
    calls++;
    throw new Error('private sentinel');
  };
  const proxy = new Proxy({}, { ownKeys: hostile, getPrototypeOf: hostile, get: hostile });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const object of [proxy, revoked.proxy]) {
    assert.throws(() => createN09BootstrapContract(object), safe);
    assert.throws(() => contract.sign(object), safe);
    assert.throws(() => contract.verify(object), safe);
    assert.throws(() => contract.mailboxKey(object), safe);
    assert.throws(() => contract.sign({ ...payload(), sourcePins: object }), safe);
  }
  for (const name of Object.keys(payload())) {
    const input = payload();
    Object.defineProperty(input, name, { enumerable: true, get: hostile });
    assert.throws(() => contract.sign(input), safe);
  }
  const pin = {};
  Object.defineProperty(pin, required, { enumerable: true, get: hostile });
  assert.throws(() => contract.sign({ ...payload(), sourcePins: pin }), safe);
  for (const name of ['payload', 'signature']) {
    const envelope = { ...contract.sign(payload()) };
    Object.defineProperty(envelope, name, { enumerable: true, get: hostile });
    assert.throws(() => contract.verify(envelope), safe);
  }
  assert.equal(calls, 0);
  contract.close();
});

test('bootstrap rejects hidden, symbolic and exotic record fields', () => {
  const contract = createN09BootstrapContract(config);
  for (const key of ['hidden', Symbol('hidden')]) {
    const input = payload();
    Object.defineProperty(input, key, { value: true });
    assert.throws(() => contract.sign(input), safe);
    const sourcePins = { ...payload().sourcePins };
    Object.defineProperty(sourcePins, key, { value: 'c'.repeat(64) });
    assert.throws(() => contract.sign({ ...payload(), sourcePins }), safe);
  }
  const hidden = payload();
  Object.defineProperty(hidden, 'epoch', { value: hidden.epoch, enumerable: false });
  assert.throws(() => contract.sign(hidden), safe);
  for (const input of [[], new Date(0), Object.assign(Object.create({}), payload())]) {
    assert.throws(() => contract.sign(input), safe);
  }
  const secretConfig = { ...config };
  Object.defineProperty(secretConfig, 'token', {
    get() {
      throw new Error('private sentinel');
    },
  });
  assert.throws(() => createN09BootstrapContract(secretConfig), safe);
  contract.close();
});

test('bootstrap configuration validates exact plain data and ASCII key limits', () => {
  for (const change of [
    { token: '' },
    { token: 'x'.repeat(31) },
    { token: 'x'.repeat(257) },
    { token: 'x'.repeat(32) + '\n' },
    { token: '非'.repeat(32) },
    { pid: NaN },
    { pid: 1.5 },
    { pid: Number.MAX_SAFE_INTEGER + 1 },
    { manifestSha256: 'A'.repeat(64) },
    { extra: true },
  ])
    assert.throws(() => createN09BootstrapContract({ ...config, ...change }), safe);
  for (const length of [32, 256]) {
    const contract = createN09BootstrapContract({ ...config, token: 'x'.repeat(length) });
    assert.deepEqual(contract.verify(contract.sign(payload())), payload());
    contract.close();
  }
  const contract = createN09BootstrapContract(Object.assign(Object.create(null), config));
  const data = Object.assign(Object.create(null), payload());
  data.sourcePins = Object.assign(Object.create(null), data.sourcePins);
  assert.deepEqual(contract.verify(contract.sign(data)), payload());
  contract.close();
});
