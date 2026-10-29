'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  parseStoredEvidenceSource,
  parseStoredEvidencePage,
} = require('../lib/proxy/context-evidence-stored-page');
const {
  buildContextArtifactPage,
  serializedContentBytes,
} = require('../lib/proxy/context-artifact-page');
const { storageRequest } = require('../lib/proxy/context-recovery-storage-contract');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const clone = (value) => globalThis.structuredClone(value);
const invalid = { message: 'invalid_stored_evidence_page' };
function fixture(text = '原文\r\nélève🙂') {
  const source = {
    sourceId: 'hce_' + 'a'.repeat(32),
    digest: sha(text),
    bytes: Buffer.byteLength(text),
    callId: 'call',
    toolName: 'lookup',
    argumentsDigest: sha('{}'),
    expiresAt: 86400100,
    trust: 'tool_data_not_instructions',
  };
  const args = { sourceId: source.sourceId, digest: source.digest };
  const page = (range = {}) => ({
    ...buildContextArtifactPage(text, 'utf8', source.digest, range),
    source,
  });
  return { source, args, page };
}

test('stored pages preserve Unicode, empty and end-of-source ranges with exact envelope budgets', () => {
  for (const text of ['', '原文\r\nélève🙂', '\u0000"\\\n'.repeat(400)]) {
    const f = fixture(text);
    const full = f.page();
    assert.equal(parseStoredEvidencePage(full, f.source, f.args).page.text, text);
    const bytes = serializedContentBytes(full);
    assert.equal(parseStoredEvidencePage(full, f.source, f.args, bytes).page.text, text);
    assert.throws(() => parseStoredEvidencePage(full, f.source, f.args, bytes - 1), invalid);
    const end = { offsetBytes: Buffer.byteLength(text) };
    assert.equal(parseStoredEvidencePage(f.page(end), f.source, end).page.text, '');
  }
  const f = fixture('原文🙂'.repeat(100));
  let offsetBytes = 0;
  let restored = '';
  do {
    const args = { ...f.args, offsetBytes, limitBytes: 13 };
    const parsed = parseStoredEvidencePage(f.page({ offsetBytes, limitBytes: 13 }), f.source, args);
    restored += parsed.page.text;
    offsetBytes = parsed.page.nextOffsetBytes;
  } while (offsetBytes !== null);
  assert.equal(sha(restored), f.source.digest);
});

test('source descriptors retain the ledger identity contract and reject malformed bounds', () => {
  const { source } = fixture();
  // The ledger permits non-ASCII spacing inside identities, but no ASCII controls/spaces.
  assert.equal(
    parseStoredEvidenceSource({ ...source, callId: 'call\u00a0id' }).callId,
    'call\u00a0id'
  );
  for (const change of [
    { sourceId: 'hce_' + 'A'.repeat(32) },
    { digest: 'z'.repeat(64) },
    { argumentsDigest: '' },
    { bytes: -1 },
    { bytes: 2 * 1024 * 1024 + 1 },
    { bytes: 0.5 },
    { expiresAt: 0 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { callId: 'a b' },
    { callId: 'a\u007fb' },
    { callId: 'x'.repeat(257) },
    { toolName: '' },
    { toolName: 'x'.repeat(129) },
    { trust: 'instructions' },
    { extra: true },
  ])
    assert.throws(() => parseStoredEvidenceSource({ ...source, ...change }), invalid);
});

test('stored page parsing rejects tampered identity, UTF8, content, offsets and continuation', () => {
  const f = fixture();
  for (const change of [
    { text: 'tampered' },
    { text: '\ud800' },
    { encoding: 'json' },
    { chunkDigest: 'b'.repeat(64) },
    { digest: 'b'.repeat(64) },
    { totalBytes: 0 },
    { offsetBytes: -1 },
    { offsetBytes: 0.5 },
    { offsetBytes: 1 },
    { endOffsetBytes: f.source.bytes + 1 },
    { endOffsetBytes: -1 },
    { nextOffsetBytes: 0 },
    { extra: 'private' },
  ]) {
    const value = clone(f.page());
    Object.assign(value.page, change);
    assert.throws(() => parseStoredEvidencePage(value, f.source, f.args), invalid);
  }
  for (const field of Object.keys(f.source)) {
    const value = clone(f.page());
    value.source[field] =
      field === 'bytes' || field === 'expiresAt' ? value.source[field] + 1 : 'bad';
    assert.throws(() => parseStoredEvidencePage(value, f.source, f.args), invalid);
  }
  const partial = f.page({ limitBytes: 6 });
  partial.page.nextOffsetBytes++;
  assert.throws(() => parseStoredEvidencePage(partial, f.source, f.args), invalid);
  assert.throws(
    () => parseStoredEvidencePage(f.page(), f.source, { ...f.args, limitBytes: 1 }),
    invalid
  );
  const forged = fixture('forged');
  forged.source.digest = sha('other');
  const value = forged.page();
  value.page.digest = forged.source.digest;
  assert.throws(() => parseStoredEvidencePage(value, forged.source, forged.args), invalid);
});

test('stored page parser allows only fixed failures and never executes hostile data hooks', () => {
  const f = fixture();
  for (const error of [
    'context_artifact_invalid_range',
    'context_artifact_budget_exceeded',
    'context_evidence_unavailable',
  ])
    assert.equal(parseStoredEvidencePage({ ok: false, error }, f.source, f.args, 0).error, error);
  let invoked = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'ok', {
    enumerable: true,
    get() {
      invoked++;
      return true;
    },
  });
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    null,
    [],
    {},
    accessor,
    cycle,
    1n,
    Symbol('private'),
    { ok: false, error: 'private exception' },
    { ok: false, error: 'context_evidence_unavailable', private: true },
    { ...f.page(), [Symbol('private')]: 1 },
    Object.create(f.page()),
    {
      ...f.page(),
      toJSON() {
        invoked++;
        return {};
      },
    },
    { ...f.page(), page: { ...f.page().page, text: 'x'.repeat(128 * 1024) } },
  ])
    assert.throws(() => parseStoredEvidencePage(value, f.source, f.args), invalid);
  assert.throws(() => parseStoredEvidenceSource(accessor), invalid);
  for (const maximum of [-1, 0.5, NaN, Infinity, 65537])
    assert.throws(() => parseStoredEvidencePage(f.page(), f.source, f.args, maximum), invalid);
  assert.equal(invoked, 0);
});

test('storage source requests bind revision, scope, source and range without coercion or hooks', () => {
  const f = fixture();
  const request = {
    operation: 'read-source',
    scope: 'b'.repeat(64),
    expectedRevision: 1,
    source: f.source,
    arguments: f.args,
    maxResultBytes: 16384,
  };
  assert.equal(storageRequest(request).source.digest, f.source.digest);
  for (const change of [
    { expectedRevision: 0 },
    { expectedRevision: '1' },
    { expectedRevision: Infinity },
    { scope: '' },
    { maxResultBytes: -1 },
    { maxResultBytes: 65537 },
    { extra: true },
    { arguments: { ...f.args, sourceId: 'hce_' + 'b'.repeat(32) } },
    { arguments: { ...f.args, digest: 'b'.repeat(64) } },
    { arguments: { ...f.args, offsetBytes: -1 } },
    { arguments: { ...f.args, limitBytes: 0 } },
    { arguments: { ...f.args, limitBytes: 65537 } },
    { arguments: { ...f.args, outputRef: 'private' } },
  ])
    assert.throws(() => storageRequest({ ...request, ...change }), {
      code: 'context_recovery_storage_unavailable',
    });
  let invoked = 0;
  const hostile = { ...request };
  Object.defineProperty(hostile, 'source', {
    enumerable: true,
    get() {
      invoked++;
      return f.source;
    },
  });
  assert.throws(() => storageRequest(hostile), { code: 'context_recovery_storage_unavailable' });
  assert.equal(invoked, 0);
});
