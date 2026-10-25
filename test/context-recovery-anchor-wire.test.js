'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeAnchorSnapshot,
  decodeAnchorSnapshot,
} = require('../lib/proxy/context-recovery-anchor-wire');
const snapshot = () => ({
  version: 1,
  storeId: 'a'.repeat(32),
  keyIdentity: 'b'.repeat(64),
  locationHash: 'c'.repeat(64),
  maxTime: 100,
  scopes: [],
});
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.cause === undefined;
const json = JSON.stringify;

test('v1 wire remains byte-compatible and the v2 header witness never reduces its native capacity', () => {
  for (const count of [0, 1, 16, 128, 256]) {
    const old = snapshot();
    old.scopes = Array.from({ length: count }, (_, index) => ({
      scope: index.toString(16).padStart(64, '0'),
      revision: 1,
      createdAt: 50,
      expiresAt: 1000,
      kind: 'state',
      tag: 'd'.repeat(64),
    }));
    const legacy = encodeAnchorSnapshot(old);
    assert.equal(legacy, json(old));
    const next = { ...old, version: 2, headerTag: 'e'.repeat(64) };
    const wire = encodeAnchorSnapshot(next);
    assert.ok(Buffer.byteLength(wire) <= Buffer.byteLength(legacy));
    if (Buffer.byteLength(wire) <= 65536 - 28) assert.deepEqual(decodeAnchorSnapshot(wire), next);
    else assert.throws(() => decodeAnchorSnapshot(wire), safe);
    if (Buffer.byteLength(legacy) <= 65536 - 28)
      assert.deepEqual(decodeAnchorSnapshot(legacy), old);
  }
});

test('wire rejects empty, oversized, ambiguous, duplicate, truncated, extra, malformed and unknown representations', () => {
  const value = { ...snapshot(), version: 2, headerTag: 'd'.repeat(64) };
  const tuple = JSON.parse(encodeAnchorSnapshot(value));
  for (const text of [
    undefined,
    '',
    'PRIVATE',
    'x'.repeat(65509),
    'null',
    'true',
    '123',
    '[]',
    '{}',
    json(value),
    json(tuple.slice(0, -1)),
    json([...tuple, 'PRIVATE']),
    json([3, ...tuple.slice(1)]),
    json([...tuple.slice(0, -1), {}]),
    json([2, ...tuple.slice(1, 5), 'bad', []]),
    ' ' + json(tuple),
    json(snapshot()).replace('"version":1', '"version":0,"version":1'),
  ])
    assert.throws(() => decodeAnchorSnapshot(text), safe);
});

test('encoder preserves the closed non-executable snapshot boundary', () => {
  const value = { ...snapshot(), version: 2, headerTag: 'd'.repeat(64) };
  let calls = 0;
  const accessor = { ...value };
  Object.defineProperty(accessor, 'headerTag', {
    enumerable: true,
    get() {
      calls++;
      throw Error('PRIVATE');
    },
  });
  for (const input of [
    null,
    [],
    {},
    accessor,
    new Proxy(value, {}),
    { ...value, version: 3 },
    { ...value, headerTag: '' },
    { ...value, token: 'PRIVATE' },
  ])
    assert.throws(() => encodeAnchorSnapshot(input), safe);
  assert.equal(calls, 0);
});
