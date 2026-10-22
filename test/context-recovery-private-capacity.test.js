'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  privateHistoryCapacity,
  privateHistoryTtl,
  validatePrivateHistoryUsage: validate,
  isPrivateHistoryRootId,
} = require('../lib/proxy/context-recovery-private-capacity');
const { LEGACY_RECOVERY_TTL_MS, RECOVERY_TTL_MS } = require('../lib/proxy/context-recovery-limits');
const MiB = 1024 * 1024;
const { normalizeRecoveryReferenceData } = require('../lib/proxy/context-recovery-state-data');
const {
  fingerprintContextData,
  fingerprintRecoveryReference,
} = require('../lib/proxy/context-recovery-fingerprint');
const { normalizeStorageEnvelope } = require('../lib/proxy/context-recovery-storage-data');
const id = (index) => `hbs_${index.toString(16).padStart(32, '0')}`;
const entry = (version, bytes, index = 1) => ({ version, bytes, rootId: id(index) });
const entries = (version, count, bytes, index = 1) =>
  Array.from({ length: count }, () => entry(version, bytes, index));

test('reference size capability is v10-only and preserves small equality admission', () => {
  const metadata = { kind: 'recovery-root-metadata', sourceVersion: 10 };
  const value = { metadata, text: 'x'.repeat(3 * MiB) };
  assert.equal(normalizeRecoveryReferenceData(value).text, value.text);
  assert.equal(normalizeRecoveryReferenceData({ ...metadata, text: value.text }).text, value.text);
  assert.match(fingerprintRecoveryReference(value), /^[a-f0-9]{64}$/);
  assert.throws(() => fingerprintContextData(value));
  for (const sourceVersion of [1, 9, 11, '10', null]) {
    const legacy = { ...value, metadata: { ...metadata, sourceVersion } };
    assert.throws(() => normalizeRecoveryReferenceData(legacy));
    assert.throws(() => fingerprintRecoveryReference(legacy));
    assert.equal(normalizeRecoveryReferenceData(legacy, 12 * MiB).text, value.text);
  }
  const small = { metadata, text: 'exact🙂' };
  assert.equal(fingerprintRecoveryReference(small), fingerprintContextData(small));
  const overhead = Buffer.byteLength(JSON.stringify({ metadata, text: '' }));
  const exact = { metadata, text: 'x'.repeat(16 * MiB - overhead) };
  assert.equal(normalizeRecoveryReferenceData(exact).text.length, exact.text.length);
  assert.throws(() => normalizeRecoveryReferenceData({ ...exact, text: exact.text + 'x' }));
  assert.throws(() => normalizeRecoveryReferenceData({}, 16 * MiB));
  let touched = 0;
  const accessor = Object.defineProperty({}, 'metadata', {
    enumerable: true,
    get() {
      touched++;
      return undefined;
    },
  });
  assert.throws(() => normalizeRecoveryReferenceData(accessor));
  assert.throws(() =>
    normalizeRecoveryReferenceData({
      metadata,
      toJSON() {
        touched++;
      },
    })
  );
  assert.equal(touched, 0);
});

test('v10 reference load, scan and worker replies carry large private metadata', () => {
  const reference = {
    kind: 'recovery-reference-state',
    version: 1,
    metadata: { kind: 'recovery-root-metadata', sourceVersion: 10 },
    text: 'x'.repeat(13 * MiB),
  };
  for (const [kind, envelope] of [
    ['reference-record', { reference }],
    ['scan-reference', { record: { reference } }],
    ['worker-result', { result: { reference } }],
    ['worker-result', { result: { record: { reference } } }],
  ]) {
    assert.doesNotThrow(() => normalizeStorageEnvelope(envelope, kind));
    const old = { ...reference, metadata: { ...reference.metadata, sourceVersion: 9 } };
    const legacy =
      kind === 'reference-record'
        ? { reference: old }
        : kind === 'scan-reference'
          ? { record: { reference: old } }
          : { result: { reference: old } };
    assert.throws(() => normalizeStorageEnvelope(legacy, kind));
  }
  assert.throws(() => normalizeStorageEnvelope({ reference }, 'unknown'));
});

test('private history versions retain explicit immutable limits and retention', () => {
  assert.equal(privateHistoryCapacity(1), privateHistoryCapacity(2));
  assert.equal(Object.isFrozen(privateHistoryCapacity(3)), true);
  assert.deepEqual(privateHistoryCapacity(3), {
    maxEntries: 512,
    maxBytes: 8 * MiB,
    maxCalls: 1024,
    stateBytes: 12 * MiB,
  });
  assert.equal(privateHistoryCapacity(1).maxCalls, 64);
  assert.equal(privateHistoryTtl(1), LEGACY_RECOVERY_TTL_MS);
  assert.equal(privateHistoryTtl(2), RECOVERY_TTL_MS);
  assert.equal(privateHistoryTtl(3), RECOVERY_TTL_MS);
  for (const version of [null, undefined, 0, 4, '3', NaN, Infinity, {}]) {
    assert.throws(() => privateHistoryCapacity(version), /invalid_private_history_capacity/);
    assert.throws(() => privateHistoryTtl(version), /invalid_private_history_capacity/);
  }
});

test('private history accounts exact legacy and four-root limits without eviction', () => {
  assert.deepEqual(validate([]), { entries: 0, bytes: 0 });
  const legacy = entries(1, 256, (4 * MiB) / 256);
  assert.deepEqual(validate(legacy), { entries: 256, bytes: 4 * MiB });
  assert.throws(() => validate([...legacy, entry(2, 0)]));
  assert.throws(() => validate([entry(2, 4 * MiB + 1)], 2));
  const daily = entries(3, 512, (8 * MiB) / 512);
  assert.deepEqual(validate(daily, 2), { entries: 512, bytes: 8 * MiB });
  assert.throws(() => validate(daily));
  assert.throws(() => validate([...daily, entry(3, 0)], 2));
  assert.throws(() => validate([entry(3, 8 * MiB + 1)], 2));
  const four = [1, 2, 3, 4].flatMap((index) => entries(3, 512, (8 * MiB) / 512, index));
  assert.deepEqual(validate(four, 2), { entries: 2048, bytes: 32 * MiB });
  assert.throws(() => validate([...four, entry(3, 0)], 2));
  assert.throws(() =>
    validate(
      [1, 2, 3, 4, 5].map((index) => entry(3, 0, index)),
      2
    )
  );
  assert.throws(() => validate([...four.slice(0, -1), entry(1, 16385)], 2));
  assert.deepEqual(validate([...legacy, entry(3, 8 * MiB)], 2), {
    entries: 257,
    bytes: 12 * MiB,
  });
  assert.throws(() => validate([...legacy, entry(2, 1), entry(3, 0)], 2));
});

test('private history refuses malformed accounting and never executes field accessors', () => {
  let touched = 0;
  const accessor = (key, base = entry(3, 0)) =>
    Object.defineProperty(base, key, {
      enumerable: true,
      get() {
        touched++;
        throw new Error('must not execute');
      },
    });
  const arrayAccessor = [entry(3, 0)];
  Object.defineProperty(arrayAccessor, '0', {
    enumerable: true,
    get() {
      touched++;
      return undefined;
    },
  });
  const inherited = Object.create(entry(3, 0));
  const hidden = Object.defineProperty(entry(3, 0), 'bytes', { enumerable: false });
  for (const value of [
    null,
    {},
    new Array(1),
    arrayAccessor,
    Object.assign([], { extra: 1 }),
    [inherited],
    [hidden],
    [accessor('version')],
    [accessor('bytes')],
    [accessor('rootId')],
    [entry(3, -1)],
    [entry(3, 0.5)],
    [entry(3, Infinity)],
    [entry(3, Number.MAX_SAFE_INTEGER + 1)],
    [entry(3, '1')],
    [entry(4, 0)],
    [{ version: 3, bytes: 0 }],
    [entry(3, 0, 1), { version: 3, bytes: 0, rootId: 'hbs_invalid' }],
  ]) {
    assert.throws(() => validate(value, 2), /invalid_private_history_capacity/);
  }
  for (const version of [0, 3, '2', null]) assert.throws(() => validate([], version));
  assert.equal(isPrivateHistoryRootId(id(1)), true);
  for (const value of [null, {}, 'hbs_' + 'A'.repeat(32), id(1) + '\n'])
    assert.equal(isPrivateHistoryRootId(value), false);
  assert.equal(touched, 0);
  const harmless = entry(3, 0);
  Object.defineProperty(harmless, 'output', {
    get() {
      touched++;
      return undefined;
    },
  });
  assert.deepEqual(validate([harmless], 2), { entries: 1, bytes: 0 });
  assert.equal(touched, 0);
});
