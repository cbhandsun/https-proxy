'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RECOVERY_TTL_MS } = require('../lib/proxy/context-recovery-limits');
const {
  parseAnchorSnapshot,
  assertAnchorSuccessor,
} = require('../lib/proxy/context-recovery-anchor-contract');

const hash = (number) => number.toString(16).padStart(64, '0');
const row = (overrides = {}) => ({
  scope: hash(1),
  revision: 1,
  createdAt: 100,
  expiresAt: 1000,
  kind: 'state',
  tag: hash(2),
  ...overrides,
});
const snapshot = (overrides = {}) => ({
  version: 1,
  storeId: 'a'.repeat(32),
  keyIdentity: hash(3),
  locationHash: hash(4),
  maxTime: 200,
  scopes: [row()],
  ...overrides,
});
function safeFailure(error) {
  assert.equal(error.code, 'context_recovery_storage_unavailable');
  assert.equal(error.message, error.code);
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}
const rejects = (input) => assert.throws(() => parseAnchorSnapshot(input), safeFailure);
const rejectsChange = (before, after) =>
  assert.throws(() => assertAnchorSuccessor(before, after), safeFailure);

test('anchor parser clones and freezes exact plain and null-prototype data without modifying input', () => {
  const input = snapshot();
  const result = parseAnchorSnapshot(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.scopes, input.scopes);
  assert.notEqual(result.scopes[0], input.scopes[0]);
  assert.ok(
    Object.isFrozen(result) && Object.isFrozen(result.scopes) && Object.isFrozen(result.scopes[0])
  );
  input.scopes[0].revision = 2;
  input.scopes.push(row({ scope: hash(9) }));
  assert.equal(result.scopes[0].revision, 1);
  assert.equal(result.scopes.length, 1);
  const plain = Object.assign(Object.create(null), snapshot());
  plain.scopes = [Object.assign(Object.create(null), row())];
  assert.deepEqual(parseAnchorSnapshot(plain), snapshot());
  assert.equal(parseAnchorSnapshot(snapshot({ scopes: [] })).scopes.length, 0);
});

test('anchor parser accepts exact 256 sorted rows, safe integer extremes and legitimate future revocation metadata', () => {
  const input = snapshot({
    maxTime: Number.MAX_SAFE_INTEGER,
    scopes: Array.from({ length: 256 }, (_, index) =>
      row({ scope: hash(index), revision: Number.MAX_SAFE_INTEGER })
    ),
  });
  assert.equal(parseAnchorSnapshot(input).scopes.length, 256);
  assert.equal(
    parseAnchorSnapshot(
      snapshot({
        maxTime: 0,
        scopes: [
          row({
            createdAt: 1000,
            expiresAt: 1000 + RECOVERY_TTL_MS,
            kind: 'revoked',
          }),
        ],
      })
    ).maxTime,
    0
  );
  assert.equal(
    parseAnchorSnapshot(
      snapshot({
        scopes: [
          row({ createdAt: Number.MAX_SAFE_INTEGER - 1, expiresAt: Number.MAX_SAFE_INTEGER }),
        ],
      })
    ).scopes[0].expiresAt,
    Number.MAX_SAFE_INTEGER
  );
});

test('anchor parser rejects missing, extraneous, executable, cyclic and non-plain snapshots safely', () => {
  for (const value of [
    null,
    undefined,
    0,
    true,
    '',
    [],
    () => {},
    new Date(),
    Object.create(snapshot()),
    { ...snapshot(), extra: 'PRIVATE_INPUT' },
    { ...snapshot(), version: 2 },
    { ...snapshot(), [Symbol('private')]: 1 },
  ])
    rejects(value);
  for (const key of Object.keys(snapshot())) {
    const value = snapshot();
    delete value[key];
    rejects(value);
  }
  const cycle = snapshot();
  cycle.scopes = cycle;
  rejects(cycle);
  const rowCycle = row();
  rowCycle.scope = rowCycle;
  rejects(snapshot({ scopes: [rowCycle] }));
  const hidden = snapshot();
  Object.defineProperty(hidden, 'maxTime', { value: 200, enumerable: false });
  rejects(hidden);
});

test('anchor parser rejects proxies at every boundary without invoking their traps or accessors', () => {
  let invoked = 0;
  const traps = {
    get() {
      invoked++;
      throw Error('PRIVATE_TRAP');
    },
    getPrototypeOf() {
      invoked++;
      throw Error('PRIVATE_TRAP');
    },
    ownKeys() {
      invoked++;
      throw Error('PRIVATE_TRAP');
    },
    getOwnPropertyDescriptor() {
      invoked++;
      throw Error('PRIVATE_TRAP');
    },
  };
  for (const value of [
    new Proxy(snapshot(), traps),
    snapshot({ scopes: new Proxy([], traps) }),
    snapshot({ scopes: [new Proxy(row(), traps)] }),
  ])
    rejects(value);
  const revoked = Proxy.revocable(snapshot(), {});
  revoked.revoke();
  rejects(revoked.proxy);
  for (const target of [snapshot(), row()]) {
    const key = Object.keys(target)[0];
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        invoked++;
        throw Error('PRIVATE_GETTER');
      },
    });
    rejects('version' in target ? target : snapshot({ scopes: [target] }));
  }
  const array = [row()];
  Object.defineProperty(array, '0', {
    enumerable: true,
    get() {
      invoked++;
      throw Error('PRIVATE_ARRAY_GETTER');
    },
  });
  rejects(snapshot({ scopes: array }));
  const coercion = {
    valueOf() {
      invoked++;
      throw Error('PRIVATE_COERCION');
    },
    toString() {
      invoked++;
      throw Error('PRIVATE_COERCION');
    },
  };
  rejects(snapshot({ maxTime: coercion }));
  rejects(snapshot({ scopes: [row({ tag: coercion, kind: coercion })] }));
  assert.equal(invoked, 0);
});

test('anchor parser rejects sparse, subclassed, decorated, duplicated, unsorted and oversized rows', () => {
  class Rows extends Array {}
  const decorated = [row()];
  decorated.extra = 1;
  const symbol = [row()];
  symbol[Symbol('private')] = 1;
  for (const scopes of [
    null,
    {},
    new Array(1),
    new Rows(row()),
    decorated,
    symbol,
    [row(), row()],
    [row({ scope: hash(9) }), row()],
    Array.from({ length: 257 }, (_, index) => row({ scope: hash(index) })),
  ])
    rejects(snapshot({ scopes }));
  rejects(snapshot({ scopes: [{ ...row(), extra: true }] }));
  rejects(snapshot({ scopes: [Object.create(row())] }));
});

test('anchor parser rejects coercion, malformed hashes, unsafe numbers and invalid lifetime bounds', () => {
  for (const key of ['storeId', 'keyIdentity', 'locationHash']) {
    for (const value of [
      null,
      {},
      1,
      '',
      'A'.repeat(key === 'storeId' ? 32 : 64),
      'a'.repeat(key === 'storeId' ? 31 : 63),
      'a'.repeat(65),
    ])
      rejects(snapshot({ [key]: value }));
  }
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '200', 1n, {}]) {
    rejects(snapshot({ maxTime: value }));
    for (const key of ['revision', 'createdAt', 'expiresAt'])
      rejects(snapshot({ scopes: [row({ [key]: value })] }));
  }
  for (const value of [
    row({ revision: 0 }),
    row({ expiresAt: 100 }),
    row({ expiresAt: 99 }),
    row({ expiresAt: 101 + RECOVERY_TTL_MS }),
    row({ scope: 'g'.repeat(64) }),
    row({ tag: 'A'.repeat(64) }),
    row({ kind: 'denied' }),
    row({ kind: {} }),
  ])
    rejects(snapshot({ scopes: [value] }));
});

test('anchor successor admits monotonic updates, TTL shortening, revocation, new scopes and exact replay', () => {
  const before = snapshot();
  assert.deepEqual(assertAnchorSuccessor(before, before), before);
  const after = snapshot({
    maxTime: 250,
    scopes: [
      row({ revision: 2, expiresAt: 900, tag: hash(5), kind: 'revoked' }),
      row({ scope: hash(9) }),
    ],
  });
  const result = assertAnchorSuccessor(before, after);
  assert.deepEqual(result, after);
  assert.notEqual(result, after);
  assert.ok(Object.isFrozen(result.scopes));
  assert.deepEqual(assertAnchorSuccessor(snapshot({ scopes: [] }), after), after);
});

test('anchor successor rejects identity changes, time/revision rollback, missing live scopes and revival', () => {
  const before = snapshot();
  for (const overrides of [
    { storeId: 'b'.repeat(32) },
    { keyIdentity: hash(8) },
    { locationHash: hash(8) },
    { maxTime: 199 },
    { scopes: [] },
    { scopes: [row({ revision: 2, createdAt: 101 })] },
    { scopes: [row({ revision: 2, expiresAt: 1001 })] },
  ])
    rejectsChange(before, snapshot(overrides));
  rejectsChange(snapshot({ scopes: [row({ revision: 2 })] }), before);
  rejectsChange(
    snapshot({ scopes: [row({ kind: 'revoked' })] }),
    snapshot({ scopes: [row({ revision: 2 })] })
  );
});

test('same-revision successor must preserve every authenticated row field', () => {
  const before = snapshot();
  for (const overrides of [
    { tag: hash(8) },
    { kind: 'revoked' },
    { expiresAt: 900 },
    { createdAt: 99 },
  ])
    rejectsChange(before, snapshot({ scopes: [row(overrides)] }));
});

test('expiry permits removal exactly at the deadline, not old-lifetime revision or tag rollback', () => {
  const before = snapshot({ scopes: [row({ revision: 7, kind: 'revoked' })] });
  rejectsChange(before, snapshot({ maxTime: 999, scopes: [] }));
  assert.equal(
    assertAnchorSuccessor(before, snapshot({ maxTime: 1000, scopes: [] })).scopes.length,
    0
  );
  for (const overrides of [
    { revision: 6, kind: 'revoked' },
    { revision: 7, kind: 'state' },
    { revision: 7, kind: 'revoked', tag: hash(9) },
  ])
    rejectsChange(before, snapshot({ maxTime: 1000, scopes: [row(overrides)] }));
});

test('expired scope can start a new engine lifetime without inheriting the prior revision or denial', () => {
  const before = snapshot({ scopes: [row({ revision: 7, kind: 'revoked' })] });
  const next = snapshot({
    maxTime: 1000,
    scopes: [row({ createdAt: 1000, expiresAt: 2000, revision: 1, tag: hash(9) })],
  });
  assert.deepEqual(assertAnchorSuccessor(before, next), next);
  rejectsChange(before, { ...next, maxTime: 999 });
  rejectsChange(before, { ...next, scopes: [row({ createdAt: 999, expiresAt: 2000 })] });
});

test('successor validates both inputs and has no null enrollment, executable or malformed bypass', () => {
  for (const invalid of [null, {}, { ...snapshot(), scopes: [row({ revision: 0 })] }]) {
    rejectsChange(invalid, snapshot());
    rejectsChange(snapshot(), invalid);
  }
});
