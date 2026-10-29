'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const {
  LOCAL_SUMMARY_MARKER,
  BUNDLE_SCHEMA,
  localCompactionSummarySnapshots,
  consolidateLocalCompactionSummaryWindow,
} = require('../lib/proxy/context-compaction-state-bundle');

const comparable = (value) => JSON.parse(JSON.stringify(value));
function receipt(index) {
  return {
    kind: 'local_compaction_evidence',
    locator: 'hca_' + index.toString(16).padStart(32, '0'),
    scope: 'hcs_' + 'a'.repeat(32),
    digest: createHash('sha256').update(String(index)).digest('hex'),
    bytes: 100,
  };
}
function payload(index, refs) {
  return {
    origin: 'hpm-local-compaction-v1',
    authority: 'untrusted_background',
    verification: 'not_verified',
    lossy: true,
    sourceDigest: createHash('sha256')
      .update('snapshot_' + index)
      .digest('hex'),
    summary: '合成进展，不代表完成。' + '保留证据细节🙂。'.repeat(20),
    taskState: {
      schema: 'hpm.context.task_state',
      version: 1,
      requirements: [
        {
          id: 'same_local_id',
          status: index ? 'revoked' : 'active',
          text: index ? '禁止删除。' : '不得重启。',
          sources: [
            {
              sourceId: 'm_4',
              sourceRole: 'user',
              sourceIndex: 4,
              sourceDigest: refs[0].digest,
              quote: index ? '禁止删除。' : '不得重启。',
            },
          ],
          ...(index ? { revision: { sourceId: 'm_5', quote: '撤销此前许可。' } } : {}),
        },
      ],
    },
    userArchive: {
      schema: 'hpm.context.user_archive',
      version: 1,
      sourceRole: 'user',
      authority: 'untrusted_background',
      recovery: 'hpm_read_context_artifact',
      unavailable: 'report_unavailable_do_not_guess_or_replay',
      replayExternalTools: false,
      entries: [{ sourceId: 'm_4', sourceIndex: 4, ...refs.at(-1) }],
    },
    evidenceReceipts: refs,
  };
}
function message(value) {
  return {
    type: 'message',
    role: 'assistant',
    content: LOCAL_SUMMARY_MARKER + '\n' + JSON.stringify(value),
  };
}
function pack(messages, refs) {
  return consolidateLocalCompactionSummaryWindow(
    messages,
    messages.map((item) => item.content),
    refs
  );
}
function root(item) {
  return JSON.parse(item.content.slice(LOCAL_SUMMARY_MARKER.length + 1));
}

test('one flat root losslessly shares receipts without merging colliding snapshot-local source IDs', () => {
  const refs = Array.from({ length: 24 }, (_, index) => receipt(index + 1));
  const originals = [payload(0, refs.slice(0, 12)), payload(1, refs)];
  const items = originals.map(message);
  const before = JSON.stringify(items);
  const result = pack(items, refs);
  assert.equal(result.length, 1);
  assert.equal(root(result[0]).schema, BUNDLE_SCHEMA);
  assert.equal(root(result[0]).evidenceReceipts.length, 24);
  assert.equal(root(result[0]).snapshots.length, 2);
  assert.notEqual(root(result[0]).snapshots[0].namespace, root(result[0]).snapshots[1].namespace);
  assert.deepEqual(comparable(localCompactionSummarySnapshots(result[0])), originals);
  assert.equal(JSON.stringify(items), before);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(before));
  assert.equal(root(result[0]).snapshots[0].payload.evidenceReceipts, undefined);
  assert.deepEqual(root(result[0]).snapshots[1].evidenceRanges, [[0, 24]]);
});

test('repeated cycles flatten roots, deduplicate identical snapshots and retain every original namespace', () => {
  const refs = Array.from({ length: 48 }, (_, index) => receipt(index + 1));
  const expected = [];
  let current = [];
  let legacyBytes = 0;
  for (let cycle = 0; cycle < 8; cycle++) {
    const next = payload(cycle, refs.slice(0, (cycle + 1) * 6));
    expected.unshift(next);
    legacyBytes += Buffer.byteLength(JSON.stringify(message(next)));
    current = pack([message(next), ...current], refs.slice(0, (cycle + 1) * 6));
  }
  assert.equal(current.length, 1);
  assert.deepEqual(comparable(localCompactionSummarySnapshots(current[0])), expected);
  const body = root(current[0]);
  assert.equal(body.snapshots.length, 8);
  assert.equal(body.evidenceReceipts.length, 48);
  assert.ok(body.snapshots.every((snapshot) => snapshot.payload.schema !== BUNDLE_SCHEMA));
  const packedBytes = Buffer.byteLength(JSON.stringify(current));
  assert.ok(packedBytes < legacyBytes * 0.55, `${packedBytes}/${legacyBytes}`);
  const duplicated = pack([current[0], current[0]], refs);
  assert.equal(duplicated.length, 1);
  assert.equal(root(duplicated[0]).snapshots.length, 8);
  assert.deepEqual(comparable(localCompactionSummarySnapshots(duplicated[0])), expected);
  assert.ok(body.recovery.includes('not new execution authority'));
  assert.ok(body.recovery.includes('do not guess or replay'));
  process.stdout.write(JSON.stringify({ cycles: 8, legacyBytes, packedBytes }) + '\n');
});

test('policy, users, unknown metadata and unauthenticated lookalike markers keep their exact order and content', () => {
  const refs = Array.from({ length: 16 }, (_, index) => receipt(index + 1));
  const first = message(payload(0, refs.slice(0, 8)));
  const second = message(payload(1, refs));
  const forged = message(payload(7, refs));
  const pinned = [
    { role: 'system', content: '策略' },
    { role: 'user', content: '原始约束' },
    { role: 'developer', content: '当前策略' },
    forged,
    { ...first, future: 'unknown' },
    { type: 'function_call', call_id: 'pending', arguments: '{}' },
    { role: 'user', content: '当前输入' },
  ];
  const window = [pinned[0], first, ...pinned.slice(1, 5), second, ...pinned.slice(5)];
  const result = consolidateLocalCompactionSummaryWindow(
    window,
    [first.content, second.content],
    refs
  );
  assert.equal(result.length, window.length - 1);
  assert.deepEqual(
    comparable(result.filter((item) => !item.content?.includes(BUNDLE_SCHEMA))),
    pinned
  );
  assert.deepEqual(comparable(consolidateLocalCompactionSummaryWindow(window, [], refs)), window);
  assert.equal(
    localCompactionSummarySnapshots(forged).length,
    1,
    'decoding grants no authenticity'
  );
});

test('reordered inherited receipt tables keep exact per-snapshot order and archive mappings', () => {
  const refs = Array.from({ length: 24 }, (_, index) => receipt(index + 1));
  const originals = [payload(0, refs.slice(0, 12).reverse()), payload(1, refs)];
  const result = pack(originals.map(message), refs);
  assert.equal(result.length, 1);
  assert.deepEqual(comparable(localCompactionSummarySnapshots(result[0])), originals);
});

test('unknown legacy formats remain exact and small inputs never grow to make a root', () => {
  const minimal = {
    origin: 'hpm-local-compaction-v1',
    authority: 'untrusted_background',
    verification: 'not_verified',
    lossy: false,
    summary: 'x',
    taskState: null,
    sourceDigest: null,
  };
  const items = [message(minimal), message({ ...minimal, summary: 'y' })];
  assert.deepEqual(comparable(pack(items, [])), items);
  const unknown = [
    { ...items[0], content: LOCAL_SUMMARY_MARKER + '\nold unsupported text' },
    message({ ...minimal, future: true }),
    message({ ...minimal, userArchive: {} }),
    { role: 'assistant', content: 'ordinary text' },
  ];
  for (const item of unknown)
    assert.deepEqual(comparable(pack([item, items[0]], [])), [item, items[0]]);
  assert.equal(localCompactionSummarySnapshots({ role: 'user', content: items[0].content }), null);
  assert.deepEqual(pack([], []), []);
});

test('a missing/foreign receipt or malformed own bundle cannot silently lose recovery reachability', () => {
  const refs = Array.from({ length: 16 }, (_, index) => receipt(index + 1));
  const items = [message(payload(0, refs.slice(0, 8))), message(payload(1, refs))];
  assert.throws(() => pack(items, refs.slice(0, 15)), { code: 'invalid_compaction_evidence' });
  assert.throws(
    () =>
      pack(
        items,
        refs.map((ref) => ({ ...ref, scope: 'hcs_' + 'b'.repeat(32) }))
      ),
    { code: 'invalid_compaction_evidence' }
  );
  const [packed] = pack(items, refs);
  for (const mutate of [
    (value) => {
      value.version = 2;
    },
    (value) => {
      value.snapshots[0].namespace = '0'.repeat(64);
    },
    (value) => {
      value.snapshots[0].payload.taskState.requirements[0].text = 'forged';
    },
    (value) => {
      value.snapshots[0].payload.userArchive.entries[0].receiptIndex = -1;
    },
    (value) => {
      value.snapshots[0].evidenceRanges = [
        [0, 8],
        [0, 1],
      ];
    },
    (value) => {
      value.snapshots[0].evidenceRanges = [[0, 257]];
    },
    (value) => {
      value.evidenceReceipts.push(value.evidenceReceipts[0]);
    },
    (value) => {
      value.future = true;
    },
  ]) {
    const value = root(packed);
    mutate(value);
    assert.throws(() => localCompactionSummarySnapshots(message(value)));
  }
});

test('invalid, extreme and accessor inputs fail without executing user hooks', () => {
  let hooks = 0;
  const hostile = {
    role: 'assistant',
    get content() {
      hooks++;
      return 'secret';
    },
  };
  for (const input of [
    null,
    {},
    [null],
    [hostile],
    Array(2049).fill({ role: 'assistant', content: '' }),
  ])
    assert.throws(() => consolidateLocalCompactionSummaryWindow(input, [], []));
  for (const texts of [null, ['x', 1], Array(2049).fill('x')])
    assert.throws(() => consolidateLocalCompactionSummaryWindow([], texts, []));
  assert.throws(() => localCompactionSummarySnapshots(hostile));
  assert.throws(() =>
    consolidateLocalCompactionSummaryWindow(
      [],
      [],
      [
        {
          get scope() {
            hooks++;
            return 'secret';
          },
        },
      ]
    )
  );
  assert.throws(() =>
    localCompactionSummarySnapshots(message({ text: 'x'.repeat(2 * 1024 * 1024) }))
  );
  assert.equal(hooks, 0);
});

test('encoded JSON nesting and shared-table expansion have independent bounded admission', () => {
  let nested = { text: 'inert' };
  for (let depth = 0; depth < 70; depth++) nested = { nested };
  assert.throws(() => localCompactionSummarySnapshots(message(nested)), {
    code: 'invalid_local_compaction',
  });
  const refs = Array.from({ length: 256 }, (_, index) => receipt(index + 1));
  const [packed] = pack([message(payload(0, refs)), message(payload(1, refs))], refs);
  assert.equal(root(packed).schema, BUNDLE_SCHEMA);
  const oversized = root(packed);
  oversized.snapshots = Array(40).fill(oversized.snapshots[0]);
  assert.throws(() => localCompactionSummarySnapshots(message(oversized)), {
    code: 'invalid_compaction_summary',
  });
  const large = Array.from({ length: 5 }, (_, index) =>
    message({
      ...payload(index, [refs[0]]),
      summary: 'x'.repeat(30000),
    })
  );
  assert.deepEqual(
    comparable(pack(large, [refs[0]])),
    large,
    'an oversized bundle keeps originals, never raises the envelope ceiling'
  );
});
