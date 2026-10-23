'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  recoveryLegacyEnrollmentPreview: preview,
  assertLegacyEnrollment: enroll,
} = require('../lib/proxy/context-recovery-anchor-enrollment');

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

test('legacy review exposes frozen minimal metadata and a domain separated complete fingerprint', () => {
  const input = snapshot();
  const review = preview(input);
  const expected = createHash('sha256')
    .update('hpm.context.recovery.anchor.legacy-enrollment.v1\0')
    .update(JSON.stringify(input))
    .digest('hex');
  assert.deepEqual(review, {
    fingerprint: expected,
    storeId: input.storeId,
    scopeCount: 1,
    maxTime: 200,
  });
  assert.ok(Object.isFrozen(review));
  assert.deepEqual(Object.keys(review), ['fingerprint', 'storeId', 'scopeCount', 'maxTime']);
  const result = enroll(input, expected);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.scopes, input.scopes);
  assert.notEqual(result.scopes[0], input.scopes[0]);
  assert.ok(
    Object.isFrozen(result) && Object.isFrozen(result.scopes) && Object.isFrozen(result.scopes[0])
  );
  input.scopes[0].tag = hash(9);
  assert.equal(result.scopes[0].tag, hash(2));
});

test('legacy fingerprints canonicalize property insertion order and null prototypes', () => {
  const input = snapshot();
  const reordered = Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(input).reverse())
  );
  reordered.scopes = [
    Object.assign(Object.create(null), Object.fromEntries(Object.entries(row()).reverse())),
  ];
  assert.equal(preview(reordered).fingerprint, preview(input).fingerprint);
  assert.deepEqual(enroll(reordered, preview(input).fingerprint), input);
});

test('legacy enrollment supports empty snapshots and maximum supported metadata', () => {
  for (const input of [
    snapshot({ maxTime: 0, scopes: [] }),
    snapshot({
      maxTime: Number.MAX_SAFE_INTEGER,
      scopes: Array.from({ length: 256 }, (_, index) =>
        row({
          scope: hash(index),
          revision: Number.MAX_SAFE_INTEGER,
          createdAt: Number.MAX_SAFE_INTEGER - 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
        })
      ),
    }),
  ]) {
    const review = preview(input);
    assert.equal(review.scopeCount, input.scopes.length);
    assert.deepEqual(enroll(input, review.fingerprint), input);
  }
});

test('legacy approval rejects every identity, clock and authenticated row change', () => {
  const approved = preview(snapshot()).fingerprint;
  for (const changed of [
    snapshot({ storeId: 'b'.repeat(32) }),
    snapshot({ keyIdentity: hash(7) }),
    snapshot({ locationHash: hash(7) }),
    snapshot({ maxTime: 201 }),
    snapshot({ scopes: [] }),
    ...[
      { scope: hash(7) },
      { revision: 2 },
      { createdAt: 101 },
      { expiresAt: 999 },
      { kind: 'revoked' },
      // Budget changes are authenticated by the envelope tag, not a snapshot field.
      { tag: hash(7) },
    ].map((change) => snapshot({ scopes: [row(change)] })),
  ])
    assert.throws(() => enroll(changed, approved), safeFailure);
});

test('legacy approval rejects malformed fingerprints without coercion or proxy access', () => {
  let calls = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        calls++;
        throw new Error('private');
      },
      getPrototypeOf() {
        calls++;
        throw new Error('private');
      },
      ownKeys() {
        calls++;
        throw new Error('private');
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw new Error('private');
      },
    }
  );
  const coercible = {
    toString() {
      calls++;
      return hash(1);
    },
  };
  for (const value of [
    undefined,
    null,
    1,
    true,
    [],
    hostile,
    coercible,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    'a'.repeat(64) + '\n',
    new String(hash(1)),
    Symbol('fingerprint'),
  ]) {
    assert.throws(() => enroll(snapshot(), value), safeFailure);
  }
  assert.equal(calls, 0);
  assert.throws(() => enroll(snapshot(), hash(0)), safeFailure);
});

test('legacy metadata rejects hostile snapshots without invoking executable input', () => {
  let calls = 0;
  const traps = {
    get() {
      calls++;
      throw new Error('private');
    },
    getPrototypeOf() {
      calls++;
      throw new Error('private');
    },
    ownKeys() {
      calls++;
      throw new Error('private');
    },
    getOwnPropertyDescriptor() {
      calls++;
      throw new Error('private');
    },
  };
  const getter = snapshot();
  Object.defineProperty(getter, 'storeId', {
    enumerable: true,
    get() {
      calls++;
      return 'a'.repeat(32);
    },
  });
  const rowGetter = row();
  Object.defineProperty(rowGetter, 'tag', {
    enumerable: true,
    get() {
      calls++;
      return hash(2);
    },
  });
  const arrayGetter = [row()];
  Object.defineProperty(arrayGetter, '0', {
    enumerable: true,
    get() {
      calls++;
      return row();
    },
  });
  const approved = preview(snapshot()).fingerprint;
  for (const value of [
    new Proxy(snapshot(), traps),
    getter,
    snapshot({ scopes: new Proxy([row()], traps) }),
    snapshot({ scopes: [new Proxy(row(), traps)] }),
    snapshot({ scopes: [rowGetter] }),
    snapshot({ scopes: arrayGetter }),
  ]) {
    assert.throws(() => preview(value), safeFailure);
    assert.throws(() => enroll(value, approved), safeFailure);
  }
  assert.equal(calls, 0);
});

test('legacy metadata rejects malformed, oversized and extended schemas with safe failures', () => {
  const missing = snapshot();
  delete missing.storeId;
  const approved = preview(snapshot()).fingerprint;
  for (const value of [
    undefined,
    null,
    '',
    [],
    missing,
    snapshot({ version: 2 }),
    snapshot({ maxTime: -1 }),
    snapshot({ maxTime: Number.MAX_SAFE_INTEGER + 1 }),
    snapshot({ scopes: [row({ expiresAt: 100 })] }),
    snapshot({ scopes: [row({ revision: 0 })] }),
    snapshot({ scopes: [row(), row()] }),
    snapshot({ scopes: new Array(1) }),
    snapshot({ scopes: Array.from({ length: 257 }, (_, index) => row({ scope: hash(index) })) }),
    { ...snapshot(), budget: 1 },
  ]) {
    assert.throws(() => preview(value), safeFailure);
    assert.throws(() => enroll(value, approved), safeFailure);
  }
});
