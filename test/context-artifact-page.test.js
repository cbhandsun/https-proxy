'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  buildContextArtifactPage,
  serializedContentBytes,
  MAX_ARTIFACT_PAGE_BYTES,
} = require('../lib/proxy/context-artifact-page');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');

const sha = (text) => createHash('sha256').update(text).digest('hex');
// EOF uses null rather than a six-digit continuation offset. The largest page
// can fit even when a shorter candidate exceeds the same exact wire budget.
const eofTransitionText = 'x'.repeat(100001);
const eofTransitionRange = { offsetBytes: 99990, limitBytes: 11 };
const eofTransitionFull = buildContextArtifactPage(
  eofTransitionText,
  'utf8',
  sha(eofTransitionText),
  eofTransitionRange
);
const eofTransitionBudget = serializedContentBytes(eofTransitionFull);
assert.equal(
  buildContextArtifactPage(
    eofTransitionText,
    'utf8',
    sha(eofTransitionText),
    eofTransitionRange,
    eofTransitionBudget
  ).page.endOffsetBytes,
  100001
);

// Compare page selection to exhaustive valid UTF-8 boundaries, including exact
// budgets, escaped controls and the terminal continuation-size discontinuity.
for (const sample of [
  '',
  'plain é🙂',
  '\u0000\n"\\é🙂',
  '汉字🙂'.repeat(8),
  Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join(''),
]) {
  const payload = 'x'.repeat(100000) + sample;
  const bytes = Buffer.from(payload);
  const start = 100000;
  const digest = sha(payload);
  const candidates = [];
  for (let end = start; end <= bytes.length; end++) {
    if (end < bytes.length && (bytes[end] & 0xc0) === 0x80) continue;
    const chunk = bytes.subarray(start, end);
    const candidate = {
      ok: true,
      page: {
        encoding: 'utf8',
        text: chunk.toString('utf8'),
        offsetBytes: start,
        endOffsetBytes: end,
        totalBytes: bytes.length,
        nextOffsetBytes: end < bytes.length ? end : null,
        digest,
        chunkDigest: sha(chunk),
      },
    };
    candidates.push(candidate);
  }
  const maximum = serializedContentBytes(candidates[candidates.length - 1]);
  for (let budget = 0; budget <= maximum + 1; budget++) {
    const expected = candidates.filter((value) => serializedContentBytes(value) <= budget).at(-1);
    const actual = buildContextArtifactPage(
      payload,
      'utf8',
      digest,
      { offsetBytes: start },
      budget
    );
    if (!expected || (sample && expected.page.endOffsetBytes === start)) {
      assert.deepEqual(actual, { ok: false, error: 'context_artifact_budget_exceeded' });
    } else {
      assert.deepEqual(actual, expected);
      assert.ok(serializedContentBytes(actual) <= budget);
    }
  }
}

for (const text of [
  'plain text',
  '汉字🙂é'.repeat(150),
  '\u0000\n"\\'.repeat(300),
  JSON.stringify({ nested: ['汉🙂'.repeat(400)] }),
]) {
  let offsetBytes = 0;
  let reconstructed = '';
  let rounds = 0;
  do {
    const value = buildContextArtifactPage(
      text,
      'utf8',
      sha(text),
      { offsetBytes, limitBytes: 29 },
      900
    );
    assert.equal(value.ok, true);
    assert.ok(serializedContentBytes(value) <= 900);
    assert.equal(JSON.parse(JSON.stringify(value)).page.text, value.page.text);
    assert.equal(value.page.chunkDigest, sha(value.page.text));
    assert.equal(value.page.digest, sha(text));
    assert.equal(Buffer.byteLength(value.page.text), value.page.endOffsetBytes - offsetBytes);
    reconstructed += value.page.text;
    offsetBytes = value.page.nextOffsetBytes;
    assert.ok(++rounds < 1000, 'pagination must progress');
  } while (offsetBytes !== null);
  assert.equal(reconstructed, text);
}

const text = '汉🙂abc';
for (const range of [
  null,
  [],
  'bad',
  { offsetBytes: -1 },
  { offsetBytes: 1.1 },
  { offsetBytes: '0' },
  { offsetBytes: Infinity },
  { offsetBytes: Number.MAX_SAFE_INTEGER },
  { offsetBytes: 1 },
  { limitBytes: 0 },
  { limitBytes: -1 },
  { limitBytes: '3' },
  { limitBytes: MAX_ARTIFACT_PAGE_BYTES + 1 },
  JSON.parse('{"__proto__":{"polluted":true}}'),
]) {
  assert.equal(buildContextArtifactPage(text, 'utf8', sha(text), range).ok, false);
}
assert.equal({}.polluted, undefined);
assert.equal(
  buildContextArtifactPage(text, 'utf8', sha(text), { limitBytes: 1 }).error,
  'context_artifact_budget_exceeded'
);
assert.equal(
  buildContextArtifactPage(text, 'utf8', sha(text), {}, 0).error,
  'context_artifact_budget_exceeded'
);
for (const budget of [NaN, Infinity, -1, 1.1, '900', MAX_ARTIFACT_PAGE_BYTES + 1]) {
  assert.equal(buildContextArtifactPage(text, 'utf8', sha(text), {}, budget).ok, false);
}
for (const value of [null, {}, 42, Symbol('bad')]) {
  assert.equal(buildContextArtifactPage(value, 'utf8', sha(text)).ok, false);
  assert.equal(buildContextArtifactPage(text, 'utf8', value).ok, false);
}
const eof = buildContextArtifactPage(text, 'utf8', sha(text), {
  offsetBytes: Buffer.byteLength(text),
});
assert.equal(eof.page.text, '');
assert.equal(eof.page.nextOffsetBytes, null);
assert.equal(buildContextArtifactPage('', 'utf8', sha('')).page.nextOffsetBytes, null);

let now = 100;
const store = createContextArtifactStore({ now: () => now, ttlMs: 20 });
const receipt = store.put('owner', 'scope', { data: '😀'.repeat(10000) });
const page = store.readPage(
  'owner',
  'scope',
  receipt.locator,
  receipt.digest,
  { offsetBytes: Buffer.byteLength('{"data":"') },
  1024
);
assert.equal(page.ok, true);
assert.equal(page.page.encoding, 'json');
assert.ok(serializedContentBytes(page) <= 1024);
for (const [owner, scope, locator, digest] of [
  ['other', 'scope', receipt.locator, receipt.digest],
  ['owner', 'other', receipt.locator, receipt.digest],
  ['owner', 'scope', 'hca_' + '0'.repeat(32), receipt.digest],
  ['owner', 'scope', receipt.locator, '0'.repeat(64)],
  ['owner', 'scope', {}, receipt.digest],
  ['owner', 'scope', receipt.locator, Symbol('bad')],
])
  assert.equal(
    store.readPage(owner, scope, locator, digest, {}, 1024).error,
    'context_artifact_unavailable'
  );
now += 20;
assert.equal(
  store.readPage('owner', 'scope', receipt.locator, receipt.digest, {}, 1024).error,
  'context_artifact_unavailable'
);
console.log('[context-artifact-page.test] ok');
