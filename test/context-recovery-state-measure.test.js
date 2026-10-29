'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cloneRecoveryStateData,
  measureRecoveryStateData,
} = require('../lib/proxy/context-recovery-state-encoder');

function rawBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (!value || typeof value !== 'object') return 0;
  return Object.keys(value).reduce(
    (bytes, key) => bytes + Buffer.byteLength(key) + rawBytes(value[key]),
    0
  );
}

test('state measurement preserves encoded bytes and conservatively bounds raw array keys', () => {
  for (const value of [
    null,
    true,
    false,
    -0,
    1e100,
    '',
    '原文🙂',
    '\ud800',
    '\udc00',
    '\0\b\t\n\f\r"\\',
    [],
    {},
    [null, false, -0],
    { 'escaped"key': ['原文🙂', { nested: '\ud800' }] },
    Array(1025).fill(''),
    { nested: [Array(10000).fill(''), ['exact']] },
    { first: 'x'.repeat(600000), second: 'x'.repeat(600000) },
    Array.from({ length: 65536 }, (_, index) => String.fromCharCode(index)).join(''),
  ]) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(value));
    const measured = measureRecoveryStateData(value, encodedBytes);
    assert.equal(measured.encodedBytes, encodedBytes);
    assert.ok(measured.rawBytesUpperBound >= rawBytes(value));
    assert.deepEqual(Object.keys(measured).sort(), ['encodedBytes', 'rawBytesUpperBound']);
    assert.equal(
      JSON.stringify(cloneRecoveryStateData(value, encodedBytes)),
      JSON.stringify(value)
    );
    if (encodedBytes > 1) assert.throws(() => measureRecoveryStateData(value, encodedBytes - 1));
  }
});

test('state measurement keeps complete descriptor, depth and occurrence admission', () => {
  let touched = 0;
  const hook = () => {
    touched++;
    throw Error('must not run');
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 1;
  let deep = 'leaf';
  for (let index = 0; index < 65; index++) deep = [deep];
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    cycle,
    sparse,
    deep,
    Array(65536).fill(null),
    Object.defineProperty({}, 'value', { enumerable: true, get: hook }),
    new Proxy({}, { ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook }),
    revoked.proxy,
    new Date(),
    { [Symbol('hidden')]: 'value' },
  ]) {
    assert.throws(() => cloneRecoveryStateData(value));
    assert.throws(() => measureRecoveryStateData(value));
  }
  assert.equal(touched, 0);
  for (const maximum of [0, -1, NaN, Infinity, 1.5, 112 * 1024 * 1024 + 4097])
    assert.throws(() => measureRecoveryStateData({}, maximum));
});

test('state measurement counts without serialization and never retains prior admission', (t) => {
  const value = { entries: Array(32).fill('private synthetic body') };
  const expected = Buffer.byteLength(JSON.stringify(value));
  t.mock.method(JSON, 'stringify', (input) => {
    assert.ok(input === null || typeof input !== 'object', 'must not serialize the retained tree');
    return String(input);
  });
  assert.equal(measureRecoveryStateData(value).encodedBytes, expected);
  value.entries.push('changed');
  assert.ok(measureRecoveryStateData(value).encodedBytes > expected);
  Object.defineProperty(value, 'later', {
    enumerable: true,
    get() {
      return assert.fail('getter invoked');
    },
  });
  assert.throws(() => measureRecoveryStateData(value));
});
