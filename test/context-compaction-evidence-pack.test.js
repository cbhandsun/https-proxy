'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const {
  EVIDENCE_PACK_KIND,
  packLocalCompactionEvidenceEntries: pack,
} = require('../lib/proxy/context-compaction-evidence-pack');
const {
  createLocalCompactionEvidence,
  createLocalCompactionEvidenceReader,
  localCompactionEvidenceOwner,
} = require('../lib/proxy/context-compaction-evidence');

const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'model',
  endpoint: 'host/v2',
};
const limits = { maxRequestBytes: 1024, maxInputTokens: 1024 };
const sha = (value) => createHash('sha256').update(value).digest('hex');
function entries(count, prefix = 'call', content = 'x'.repeat(800)) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    item: {
      type: 'function_call_output',
      call_id: prefix + index,
      output: content,
      future: { preserved: true },
    },
  }));
}
function groups(source) {
  return source.map((entry) => [entry]);
}
function checkPack(bundle, expected) {
  assert.equal(bundle.packed, true);
  assert.equal(bundle.bytes, Buffer.byteLength(bundle.value));
  const parsed = JSON.parse(bundle.value);
  assert.equal(parsed.kind, EVIDENCE_PACK_KIND);
  assert.equal(parsed.version, 1);
  assert.deepEqual(
    parsed.items,
    expected.map((entry) => entry.item)
  );
  const bytes = Buffer.from(bundle.value);
  assert.deepEqual(parsed.index, bundle.members);
  for (const [index, member] of parsed.index.entries()) {
    const content = bytes.subarray(member.offsetBytes, member.endOffsetBytes);
    assert.equal(content.length, member.bytes);
    assert.equal(sha(content), member.digest);
    assert.equal(member.sourceIndex, expected[index].index);
    assert.equal(member.callId, expected[index].item.call_id);
    assert.equal(member.type, expected[index].item.type);
    assert.deepEqual(JSON.parse(content.toString('utf8')), expected[index].item);
  }
}

test('lossless indexed packs preserve UTF-8, escaping, order and unknown fields at exact byte offsets', () => {
  const source = entries(65, 'id', '中文🙂\\"\n'.repeat(100));
  const before = JSON.stringify(source);
  const bundles = pack(source, 2 * 1024 * 1024);
  assert.equal(bundles.length, 1);
  checkPack(bundles[0], source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(pack([], 1024), []);
  const single = pack(source.slice(0, 1), 4096)[0];
  assert.equal(single.packed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(single.value)), source[0].item);
  assert.equal(single.members[0].offsetBytes, 0);
  assert.equal(single.bytes, Buffer.byteLength(JSON.stringify(source[0].item)));
});

test('exact artifact admission splits without slicing and accepts an exactly full singleton', () => {
  const source = entries(4);
  const combined = pack(source.slice(0, 2), 4096)[0].bytes;
  assert.equal(pack(source.slice(0, 2), combined).length, 1);
  assert.equal(pack(source.slice(0, 2), combined - 1).length, 2);
  const bundles = pack(source, combined);
  assert.equal(bundles.length, 2);
  checkPack(bundles[0], source.slice(0, 2));
  checkPack(bundles[1], source.slice(2));
  assert.ok(bundles.every((bundle) => bundle.bytes <= combined));
  const itemBytes = Buffer.byteLength(JSON.stringify(source[0].item));
  assert.equal(pack(source.slice(0, 1), itemBytes)[0].bytes, itemBytes);
  assert.throws(() => pack(source.slice(0, 1), itemBytes - 1), {
    code: 'compaction_evidence_unavailable',
  });
});

test('index identities are quoted data; aliases work and oversized optional labels do not lose original fields', () => {
  const source = [
    { index: 0, item: { type: 'tool_result', id: '中文"\\\n', output: 'first' } },
    { index: 1, item: { type: 'x'.repeat(129), call_id: 'x'.repeat(4097), output: 'second' } },
    { index: 2, item: { output: 'third' } },
  ];
  const bundle = pack(source, 16384)[0];
  const data = JSON.parse(bundle.value);
  assert.deepEqual(
    data.items,
    source.map((entry) => entry.item)
  );
  assert.equal(data.index[0].callId, source[0].item.id);
  assert.equal(data.index[0].type, 'tool_result');
  assert.equal(Object.hasOwn(data.index[1], 'callId'), false);
  assert.equal(Object.hasOwn(data.index[1], 'type'), false);
  assert.equal(Object.hasOwn(data.index[2], 'callId'), false);
  assert.equal(Object.hasOwn(data.index[2], 'type'), false);
  const payload = Buffer.from(bundle.value);
  for (const [index, member] of data.index.entries())
    assert.deepEqual(
      JSON.parse(payload.subarray(member.offsetBytes, member.endOffsetBytes).toString()),
      source[index].item
    );
});

test('invalid, extreme, circular, prototype and accessor inputs fail without executing user hooks', () => {
  const one = entries(1)[0];
  for (const value of [
    null,
    {},
    [[]],
    [{ ...one, index: -1 }],
    [one, one],
    [{ ...one, index: 2049 }],
    [{ ...one, item: [] }],
    [{ ...one, extra: true }],
    Array(2049).fill(one),
    [Object.create(one)],
    [{ ...one, item: { output: 'x'.repeat(4 * 1024 * 1024) } }],
  ])
    assert.throws(() => pack(value, 1024));
  for (const ceiling of [0, -1, null, '1024', NaN, Infinity, 2 * 1024 * 1024 + 1])
    assert.throws(() => pack([], ceiling));
  let accessed = false;
  const item = Object.defineProperty({}, 'toJSON', {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error('PRIVATE_CONTENT');
    },
  });
  assert.throws(() => pack([{ index: 0, item }], 1024));
  assert.equal(accessed, false);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => pack([{ index: 0, item: cyclic }], 1024));
});

test('65 evidence items occupy one unreadable reservation until atomic commit; indexed pages stay authorized', () => {
  const store = createContextArtifactStore({ maxArtifactBytes: 2 * 1024 * 1024 });
  try {
    const source = entries(65, 'id', '中文🙂\\"\n'.repeat(100));
    const plan = createLocalCompactionEvidence(groups(source), binding, store, limits);
    assert.equal(plan.references.length, 1);
    assert.equal(store.stats().entries, 0);
    const ref = plan.references[0];
    const reader = createLocalCompactionEvidenceReader(store, binding, plan.references);
    const read = (offsetBytes, limitBytes) =>
      reader.readPage(
        binding.owner,
        ref.scope,
        ref.locator,
        ref.digest,
        { offsetBytes, limitBytes },
        4096
      );
    assert.equal(read(0, 1024).ok, false);
    assert.equal(plan.commit(), true);
    assert.equal(store.stats().entries, 1);
    const raw = store.read(
      localCompactionEvidenceOwner(binding),
      ref.scope,
      ref.locator,
      ref.digest
    );
    checkPack(
      { value: raw.value, bytes: raw.bytes, packed: true, members: JSON.parse(raw.value).index },
      source
    );
    const member = JSON.parse(raw.value).index[42];
    const itemBytes = Buffer.from(JSON.stringify(source[42].item));
    const multiByteIndex = itemBytes.findIndex((byte) => byte >= 0xc0);
    assert.equal(
      read(member.offsetBytes + multiByteIndex + 1, 300).error,
      'context_artifact_invalid_range'
    );
    let offset = member.offsetBytes;
    let text = '';
    while (offset < member.endOffsetBytes) {
      const page = read(offset, Math.min(300, member.endOffsetBytes - offset));
      assert.equal(page.ok, true);
      assert.equal(page.page.chunkDigest, sha(Buffer.from(page.page.text)));
      text += page.page.text;
      offset = page.page.endOffsetBytes;
    }
    assert.deepEqual(JSON.parse(text), source[42].item);
    assert.equal(sha(text), member.digest);
    for (const candidate of [
      createLocalCompactionEvidenceReader(store, binding),
      createLocalCompactionEvidenceReader(store, { ...binding, model: 'foreign' }, plan.references),
    ])
      assert.equal(
        candidate.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}, 4096).ok,
        false
      );
    assert.equal(
      reader.readPage('foreign', ref.scope, ref.locator, ref.digest, {}, 4096).ok,
      false
    );
    assert.equal(
      reader.readPage(binding.owner, ref.scope, ref.locator, '0'.repeat(64), {}, 4096).ok,
      false
    );
    assert.equal(plan.commit(), true);
    assert.equal(plan.rollback(), false);
    assert.equal(plan.discard(), true);
    assert.equal(read(0, 1024).ok, false);
  } finally {
    store.close();
  }
});

test('128 rounds of 16 items fit unchanged quotas; next round rolls back without invalidating earlier checkpoints', () => {
  const store = createContextArtifactStore({ maxArtifactBytes: 2 * 1024 * 1024 });
  try {
    let references = [];
    const first = createLocalCompactionEvidence(
      groups(entries(16, 'round0')),
      binding,
      store,
      limits
    );
    first.commit();
    references = first.references;
    const original = references[0];
    for (let index = 1; index < 128; index++) {
      const plan = createLocalCompactionEvidence(
        groups(entries(16, 'round' + index)),
        binding,
        store,
        limits,
        references
      );
      plan.commit();
      references = plan.references;
    }
    assert.equal(references.length, 128);
    assert.equal(store.stats().entries, 128);
    assert.equal(store.lifecyclePolicy().maxOwnerEntries, 128);
    assert.equal(store.lifecyclePolicy().maxSessionEntries, 64);
    assert.ok(store.stats().retainedBytes < store.lifecyclePolicy().maxOwnerBytes);
    assert.throws(
      () =>
        createLocalCompactionEvidence(
          groups(entries(16, 'overflow')),
          binding,
          store,
          limits,
          references
        ),
      { code: 'compaction_evidence_unavailable' }
    );
    const reader = createLocalCompactionEvidenceReader(store, binding, [original]);
    assert.equal(
      reader.readPage(binding.owner, original.scope, original.locator, original.digest, {}, 4096)
        .ok,
      true
    );
    assert.equal(store.stats().entries, 128);
    first.discard();
    const retry = createLocalCompactionEvidence(
      groups(entries(16, 'retry')),
      binding,
      store,
      limits,
      references.slice(1)
    );
    retry.commit();
    assert.equal(store.stats().entries, 128);
  } finally {
    store.close();
  }
});

test('partial multi-pack quota failure releases reservations and preserves legacy single-item receipts', () => {
  const source = entries(4);
  const maxArtifactBytes = pack(source.slice(0, 2), 4096)[0].bytes;
  const store = createContextArtifactStore({ maxEntries: 2, maxArtifactBytes });
  try {
    const legacy = createLocalCompactionEvidence(
      groups(entries(1, 'legacy')),
      binding,
      store,
      limits
    );
    legacy.commit();
    assert.throws(
      () =>
        createLocalCompactionEvidence(groups(source), binding, store, limits, legacy.references),
      { code: 'compaction_evidence_unavailable' }
    );
    assert.equal(store.stats().entries, 1);
    const ref = legacy.references[0];
    const reader = createLocalCompactionEvidenceReader(store, binding, legacy.references);
    const page = reader.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}, 4096);
    assert.deepEqual(JSON.parse(page.page.text), entries(1, 'legacy')[0].item);
    const retry = createLocalCompactionEvidence(
      groups(source.slice(0, 2)),
      binding,
      store,
      limits,
      legacy.references
    );
    retry.commit();
    assert.equal(store.stats().entries, 2);
    retry.discard();
    assert.equal(
      reader.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}, 4096).ok,
      true
    );
  } finally {
    store.close();
  }
});

test('expiration, clock rollback and store closure cannot publish or resurrect packed evidence', () => {
  for (const mode of ['expired', 'clock', 'closed']) {
    let now = 1000;
    const store = createContextArtifactStore({ now: () => now, ttlMs: 100, maxLifetimeMs: 200 });
    try {
      const plan = createLocalCompactionEvidence(groups(entries(65)), binding, store, limits);
      if (mode === 'expired') now += 100;
      if (mode === 'clock') {
        store.stats();
        now -= 1;
      }
      if (mode === 'closed') store.close();
      assert.throws(() => plan.commit(), { code: 'compaction_evidence_unavailable' });
      assert.equal(store.stats().entries, 0);
      if (mode === 'expired') {
        const retry = createLocalCompactionEvidence(groups(entries(65)), binding, store, limits);
        retry.commit();
        const ref = retry.references[0];
        const reader = createLocalCompactionEvidenceReader(store, binding, retry.references);
        now += 90;
        assert.equal(
          reader.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}, 4096).ok,
          true
        );
        now += 90;
        assert.equal(
          reader.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}, 4096).ok,
          true
        );
        now += 20;
        assert.equal(
          reader.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}, 4096).ok,
          false
        );
      }
    } finally {
      store.close();
    }
  }
});
