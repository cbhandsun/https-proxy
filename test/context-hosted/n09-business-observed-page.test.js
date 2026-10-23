'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { buildContextArtifactPage } = require('../../lib/proxy/context-artifact-page');
const { parseObservedPage } = require('../../scripts/context-hosted/n09-business/observed-page');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const bad = /^Error: n09_observed_page_rejected$/;
function fixture(text = 'synthetic 原文🙂') {
  const source = {
    sourceId: 'hce_' + 'a'.repeat(32),
    callId: 'hpa_' + 'b'.repeat(64),
    toolName: 'n09_original',
    argumentsDigest: sha('{}'),
    digest: sha(text),
    bytes: Buffer.byteLength(text),
    expiresAt: 10000,
    trust: 'tool_data_not_instructions',
  };
  const args = { offsetBytes: 0, limitBytes: 8192 };
  const page = {
    ...buildContextArtifactPage(text, 'utf8', source.digest, args),
    source,
    observation: 'client_reported',
    verification: 'not_verified',
  };
  return { page, source, args };
}
test('observed page retains exact empty and Unicode page validation and consumes explicit provenance', () => {
  for (const text of ['', 'synthetic 原文🙂']) {
    const f = fixture(text);
    const read = parseObservedPage(f.page, f.source, f.args);
    assert.equal(read.page.text, text);
    assert.deepEqual(Object.keys(read).sort(), ['ok', 'page', 'source']);
  }
});
test('observed page refuses missing, incorrect or extra provenance, corrupt pages and source/range mismatches', () => {
  const f = fixture();
  for (const key of ['observation', 'verification']) {
    const missing = { ...f.page };
    delete missing[key];
    assert.throws(() => parseObservedPage(missing, f.source, f.args), bad);
    for (const value of [null, '', 'verified', 'PRIVATE'])
      assert.throws(() => parseObservedPage({ ...f.page, [key]: value }, f.source, f.args), bad);
  }
  for (const value of [
    null,
    [],
    {},
    { ...f.page, extra: 'PRIVATE' },
    { ...f.page, ok: false },
    { ...f.page, page: { ...f.page.page, text: 'PRIVATE' } },
  ])
    assert.throws(() => parseObservedPage(value, f.source, f.args), bad);
  assert.throws(() => parseObservedPage(f.page, { ...f.source, expiresAt: 10001 }, f.args), bad);
  assert.throws(() => parseObservedPage(f.page, f.source, { ...f.args, offsetBytes: 1 }), bad);
  for (const args of [
    { offsetBytes: '0', limitBytes: 8192 },
    { offsetBytes: -1, limitBytes: 8192 },
    { offsetBytes: 0, limitBytes: '8192' },
    { offsetBytes: 0, limitBytes: 0 },
    { offsetBytes: 0, limitBytes: 65537 },
    { offsetBytes: 0, limitBytes: NaN },
  ])
    assert.throws(() => parseObservedPage(f.page, f.source, args), bad);
});
test('observed page rejects executable and oversized boundaries without invoking accessors or proxies', () => {
  const f = fixture();
  let traps = 0;
  const accessor = {
    ...f.page,
    get observation() {
      traps++;
      throw Error('PRIVATE');
    },
  };
  const proxy = new Proxy(f.page, {
    ownKeys() {
      traps++;
      throw Error('PRIVATE');
    },
  });
  for (const value of [accessor, proxy, { ...f.page, observation: 'x'.repeat(128 * 1024) }])
    assert.throws(() => parseObservedPage(value, f.source, f.args), bad);
  const nested = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        throw Error('PRIVATE');
      },
    }
  );
  for (const key of ['page', 'source'])
    assert.throws(() => parseObservedPage({ ...f.page, [key]: nested }, f.source, f.args), bad);
  assert.throws(() => parseObservedPage(f.page, nested, f.args), bad);
  assert.throws(() => parseObservedPage(f.page, f.source, nested), bad);
  assert.equal(traps, 0);
});
