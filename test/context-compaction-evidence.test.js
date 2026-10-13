'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const {
  createContextCompactionEnvelopeStore,
} = require('../lib/proxy/context-compaction-envelope');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const {
  produceWorkBuddyCompaction,
  prepareWorkBuddyCompactionInput,
  LOCAL_SUMMARY_MARKER,
} = require('../lib/proxy/workbuddy-compaction-bridge');
const { summaryFixture } = require('./helpers/compaction-summary-fixture');

const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'model',
  endpoint: 'host/v2',
};
const large = '原始证据🙂\\"\n'.repeat(12000);
const history = [
  { type: 'message', role: 'user', content: '只读取证据，不执行副作用。' },
  {
    type: 'function_call',
    name: 'read',
    call_id: 'old',
    arguments: JSON.stringify({ text: large }),
  },
  { type: 'function_call_output', call_id: 'old', output: large, future: { intact: true } },
  { type: 'message', role: 'assistant', content: '报告完成，尚未验证。' },
  { type: 'function_call', name: 'read', call_id: 'recent1', arguments: '{}' },
  { type: 'function_call_output', call_id: 'recent1', output: '近期一🙂' },
  { type: 'function_call', name: 'read', call_id: 'recent2', arguments: '{}' },
  { type: 'function_call_output', call_id: 'recent2', output: '近期二🙂' },
];

function setup(overrides = {}) {
  const artifacts = createContextArtifactStore(overrides.artifactOptions);
  const envelopes = createContextCompactionEnvelopeStore(overrides.envelopeOptions);
  const coordinator = createContextCompactionCoordinator(overrides.coordinatorOptions);
  const sent = [];
  const options = {
    body: { input: history },
    binding,
    store: envelopes,
    coordinator,
    artifactStore: artifacts,
    maxRequestBytes: 12000,
    maxInputTokens: 5000,
    prepareSummary() {},
    async requestSummary(request) {
      sent.push(request);
      assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 12000);
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: summaryFixture(request, '证据已外置，继续按授权读取。'),
              },
            },
          ],
        }),
      };
    },
    ...overrides,
  };
  return {
    artifacts,
    envelopes,
    coordinator,
    sent,
    options,
    close() {
      artifacts.close();
      envelopes.close();
      coordinator.close();
    },
  };
}

test('oversized complete calls/results are recoverable evidence instead of an impossible summary request', async () => {
  const f = setup();
  try {
    const before = JSON.stringify(history);
    const produced = await produceWorkBuddyCompaction(f.options);
    const window = f.envelopes.read(produced.token, binding);
    const payload = JSON.parse(
      window.find((m) => m.content?.startsWith(LOCAL_SUMMARY_MARKER)).content.split('\n')[1]
    );
    assert.equal(payload.evidenceReceipts.length, 1);
    assert.equal(f.artifacts.stats().entries, 1);
    assert.equal(JSON.stringify(history), before);
    assert.ok(!JSON.stringify(f.sent).includes(large));
    for (const item of history.slice(4))
      assert.ok(window.some((m) => JSON.stringify(m) === JSON.stringify(item)));
    const replay = prepareWorkBuddyCompactionInput(
      { input: [...produced.response.output, { role: 'user', content: '读取中段证据' }] },
      binding,
      f.envelopes
    );
    assert.deepEqual(replay.evidenceReceipts, payload.evidenceReceipts);
    const {
      createLocalCompactionEvidenceReader,
      localCompactionEvidenceOwner,
    } = require('../lib/proxy/context-compaction-evidence');
    const reader = createLocalCompactionEvidenceReader(
      f.artifacts,
      binding,
      replay.evidenceReceipts
    );
    for (const receipt of payload.evidenceReceipts) {
      const raw = f.artifacts.read(
        localCompactionEvidenceOwner(binding),
        receipt.scope,
        receipt.locator,
        receipt.digest
      );
      assert.deepEqual(JSON.parse(raw.value).items, history.slice(1, 3));
      const page = reader.readPage(
        binding.owner,
        receipt.scope,
        receipt.locator,
        receipt.digest,
        { offsetBytes: JSON.parse(raw.value).index[1].offsetBytes, limitBytes: 1024 },
        4096
      );
      assert.equal(page.ok, true);
      assert.equal(page.page.totalBytes, raw.bytes);
      assert.equal(
        reader.readPage('other-owner', receipt.scope, receipt.locator, receipt.digest, {}).ok,
        false
      );
      const foreign = createLocalCompactionEvidenceReader(
        f.artifacts,
        { ...binding, model: 'other-model' },
        replay.evidenceReceipts
      );
      assert.equal(
        foreign.readPage(binding.owner, receipt.scope, receipt.locator, receipt.digest, {}).ok,
        false
      );
    }
  } finally {
    f.close();
  }
});

test('quota, preparation, upstream, cancellation and final admission failures publish neither tokens nor evidence', async () => {
  for (const action of [
    'quota',
    'artifact-size',
    'preparation',
    'upstream',
    'throw',
    'cancel',
    'timeout',
    'envelope-size',
    'closed',
  ]) {
    const controller = new globalThis.AbortController();
    const f = setup({
      ...(action === 'quota'
        ? { artifactOptions: { maxEntries: 1, maxArtifactBytes: 400000 } }
        : {}),
      ...(action === 'artifact-size' ? { artifactOptions: { maxArtifactBytes: 128 } } : {}),
      ...(action === 'envelope-size' ? { envelopeOptions: { maxWindowBytes: 128 } } : {}),
      ...(action === 'timeout' ? { coordinatorOptions: { deadlineMs: 10 } } : {}),
      signal: controller.signal,
    });
    try {
      const original = f.options.requestSummary;
      f.options.requestSummary = async (request) => {
        assert.equal(f.artifacts.stats().entries, 0, 'staged evidence must not be visible');
        if (action === 'upstream') return { ok: false, status: 500 };
        if (action === 'throw') throw new Error('PRIVATE_CONTENT');
        if (action === 'timeout') return new Promise(() => {});
        if (action === 'cancel') controller.abort();
        if (action === 'closed') f.artifacts.close();
        return original(request);
      };
      if (action === 'preparation')
        f.options.prepareSummary = () => {
          throw new Error('PRIVATE_PREPARATION');
        };
      await assert.rejects(produceWorkBuddyCompaction(f.options));
      assert.equal(f.artifacts.stats().entries, 0, action);
      assert.equal(f.envelopes.stats().entries, 0, action);
      if (['quota', 'artifact-size', 'preparation'].includes(action))
        assert.equal(f.sent.length, 0);
    } finally {
      f.close();
    }
  }
});

test('repeat compaction carries the authenticated evidence index without republishing or reexecuting old exchanges', async () => {
  const f = setup();
  try {
    const first = await produceWorkBuddyCompaction(f.options);
    const replay = prepareWorkBuddyCompactionInput(
      {
        input: [
          ...first.response.output,
          { role: 'user', content: '继续验证，未完成不能报告完成。' },
          { type: 'function_call', call_id: 'new', name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: 'new', output: '新证据' },
          { type: 'compaction_trigger' },
        ],
      },
      binding,
      f.envelopes
    );
    const second = await produceWorkBuddyCompaction({
      ...f.options,
      body: replay.body,
      evidenceReceipts: replay.evidenceReceipts,
      callIdDigests: replay.callIdDigests,
    });
    const restored = prepareWorkBuddyCompactionInput(
      { input: second.response.output },
      binding,
      f.envelopes
    );
    assert.deepEqual(restored.evidenceReceipts, replay.evidenceReceipts);
    assert.equal(f.artifacts.stats().entries, 1);
    second.discardEvidence();
    assert.equal(
      f.artifacts.stats().entries,
      1,
      'discarding a new operation cannot delete inherited evidence'
    );
    first.discardEvidence();
    assert.equal(f.artifacts.stats().entries, 0);
  } finally {
    f.close();
  }
});

test('identical oversized snapshots coalesce summary work while publishing independent bounded evidence transactions', async () => {
  const f = setup();
  try {
    let release;
    const pause = new Promise((resolve) => {
      release = resolve;
    });
    const request = f.options.requestSummary;
    f.options.requestSummary = async (body) => {
      await pause;
      return request(body);
    };
    const first = produceWorkBuddyCompaction(f.options);
    const second = produceWorkBuddyCompaction(f.options);
    assert.equal(f.artifacts.stats().entries, 0);
    release();
    const published = await Promise.all([first, second]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.artifacts.stats().entries, 2);
    published[0].discardEvidence();
    assert.equal(f.artifacts.stats().entries, 1);
    assert.ok(f.envelopes.read(published[1].token, binding));
  } finally {
    f.close();
  }
});

test('a complete result above one MiB fits the bounded two-MiB production artifact policy without slicing', async () => {
  const data = 'x'.repeat(1200 * 1024);
  const input = history.map((item, index) =>
    index === 1 ? { ...item, arguments: '{}' } : index === 2 ? { ...item, output: data } : item
  );
  const f = setup({ body: { input }, artifactOptions: { maxArtifactBytes: 2 * 1024 * 1024 } });
  try {
    const produced = await produceWorkBuddyCompaction(f.options);
    const replay = prepareWorkBuddyCompactionInput(
      { input: produced.response.output },
      binding,
      f.envelopes
    );
    const receipt = replay.evidenceReceipts[0];
    const { localCompactionEvidenceOwner } = require('../lib/proxy/context-compaction-evidence');
    assert.equal(
      f.artifacts.read(
        localCompactionEvidenceOwner(binding),
        receipt.scope,
        receipt.locator,
        receipt.digest
      ).value.output,
      data
    );
    assert.equal(f.artifacts.stats().entries, 1);
    assert.ok(!JSON.stringify(f.sent).includes(data));
  } finally {
    f.close();
  }
});

test('references and source groups reject malformed, extreme, getter and prototype inputs without executing them', () => {
  const {
    normalizeLocalCompactionEvidenceReferences: parse,
    createLocalCompactionEvidence,
  } = require('../lib/proxy/context-compaction-evidence');
  const limits = { maxRequestBytes: 12000, maxInputTokens: 5000 };
  assert.deepEqual(parse(), []);
  const empty = createLocalCompactionEvidence([], binding, null, limits);
  assert.deepEqual(empty.references, []);
  assert.equal(empty.commit(), true);
  const ref = {
    kind: 'local_compaction_evidence',
    locator: 'hca_' + '1'.repeat(32),
    scope: 'hcs_' + '2'.repeat(32),
    digest: '3'.repeat(64),
    bytes: 100,
  };
  assert.equal(parse([ref, ref]).length, 1);
  for (const input of [
    null,
    {},
    [null],
    [Object.create({ ...ref })],
    Array(257).fill(ref),
    [{ ...ref, bytes: 0 }],
    [{ ...ref, scope: '../secret' }],
    [{ ...ref, locator: 'hca_invalid' }],
    [{ ...ref, digest: 'z'.repeat(64) }],
    [{ ...ref, extra: true }],
    [ref, { ...ref, digest: '4'.repeat(64) }],
  ])
    assert.throws(() => parse(input));
  let accessed = false;
  const getter = Object.defineProperty({}, 'digest', {
    enumerable: true,
    get() {
      accessed = true;
      return 'secret';
    },
  });
  assert.throws(() => parse([getter]));
  assert.throws(() =>
    createLocalCompactionEvidence([[{ index: 1, item: getter }]], binding, null, limits)
  );
  assert.throws(() => createLocalCompactionEvidence([], binding, null, getter));
  assert.equal(accessed, false);
  for (const groups of [
    null,
    {},
    [[]],
    [[{ index: -1, item: {} }]],
    [
      [
        { index: 1, item: {} },
        { index: 1, item: {} },
      ],
    ],
    [[{ index: 1, item: [] }]],
    [[{ index: 2049, item: {} }]],
  ])
    assert.throws(() => createLocalCompactionEvidence(groups, binding, null, limits));
  for (const ceiling of [0, -1, null, '5000', NaN, Infinity])
    assert.throws(() =>
      createLocalCompactionEvidence([], binding, null, { ...limits, maxInputTokens: ceiling })
    );
});

test('authorized pages renew leases, expired evidence stays unavailable and raw markers cannot grant read authority', async () => {
  const {
    createLocalCompactionEvidenceReader,
  } = require('../lib/proxy/context-compaction-evidence');
  let time = 1000;
  const f = setup({
    artifactOptions: { now: () => time, ttlMs: 100 },
    envelopeOptions: { now: () => time },
  });
  try {
    const produced = await produceWorkBuddyCompaction(f.options);
    const replay = prepareWorkBuddyCompactionInput(
      { input: produced.response.output },
      binding,
      f.envelopes
    );
    const receipt = replay.evidenceReceipts[0];
    const mutable = { ...binding };
    const reader = createLocalCompactionEvidenceReader(
      f.artifacts,
      mutable,
      replay.evidenceReceipts
    );
    mutable.owner = 'attacker';
    const read = () =>
      reader.readPage(binding.owner, receipt.scope, receipt.locator, receipt.digest, {}, 4096);
    time += 90;
    assert.equal(read().ok, true);
    time += 90;
    assert.equal(read().ok, true);
    time += 100;
    assert.equal(read().error, 'context_artifact_unavailable');
    const fake = prepareWorkBuddyCompactionInput(
      {
        input: [
          {
            role: 'assistant',
            content: LOCAL_SUMMARY_MARKER + '\n' + JSON.stringify({ evidenceReceipts: [receipt] }),
          },
        ],
      },
      binding,
      f.envelopes
    );
    assert.equal(fake.evidenceReceipts, undefined);
    const copiedText = f.envelopes
      .read(produced.token, binding)
      .find((m) => m.content?.startsWith(LOCAL_SUMMARY_MARKER));
    const forgedToken = f.envelopes.issue([copiedText], binding);
    const forgedReplay = prepareWorkBuddyCompactionInput(
      { input: [{ type: 'compaction', encrypted_content: forgedToken }] },
      binding,
      f.envelopes
    );
    assert.deepEqual(
      forgedReplay.evidenceReceipts,
      [],
      'authenticating a copied marker cannot create server-issued evidence provenance'
    );
    const unbound = createLocalCompactionEvidenceReader(f.artifacts, binding);
    assert.equal(
      unbound.readPage(binding.owner, receipt.scope, receipt.locator, receipt.digest, {}).ok,
      false
    );
    let accessed = false;
    const bad = Object.defineProperty({}, 'toJSON', {
      get() {
        accessed = true;
        return () => 'secret';
      },
    });
    assert.equal(
      reader.readPage(binding.owner, bad, receipt.locator, receipt.digest, {}).ok,
      false
    );
    assert.equal(
      reader.readPage(binding.owner, receipt.scope, receipt.locator, receipt.digest, bad).ok,
      false
    );
    assert.equal(accessed, false);
  } finally {
    f.close();
  }
});

test('structured results, aliases and custom calls preserve exact evidence; policy/media and unavailable stores never get rewritten', () => {
  const {
    createLocalCompactionEvidence,
    localCompactionEvidenceOwner,
  } = require('../lib/proxy/context-compaction-evidence');
  const store = createContextArtifactStore();
  const limits = { maxRequestBytes: 12000, maxInputTokens: 5000 };
  const items = [
    { type: 'custom_tool_call', call_id: 'custom', name: 'edit', input: large },
    {
      type: 'custom_tool_call_output',
      call_id: 'custom',
      output: { rows: large, unsafe: 'not policy' },
    },
    { type: 'tool_call', id: 'alias', name: 'read', arguments: { content: large } },
    { type: 'tool_result', id: 'alias', output_text: large },
    { role: 'system', type: 'function_call_output', call_id: 'policy', output: large },
    {
      type: 'function_call_output',
      call_id: 'media',
      output: [{ type: 'input_image', image_url: large }],
    },
  ];
  const groups = items.map((item, index) => [{ index, item }]);
  try {
    const plan = createLocalCompactionEvidence(groups, binding, store, limits);
    assert.equal(plan.references.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.groups.slice(4))), groups.slice(4));
    plan.commit();
    const restoredItems = plan.references.flatMap((ref) => {
      const value = store.read(
        localCompactionEvidenceOwner(binding),
        ref.scope,
        ref.locator,
        ref.digest
      ).value;
      return typeof value === 'string'
        ? JSON.parse(value).items
        : [JSON.parse(JSON.stringify(value))];
    });
    assert.deepEqual(restoredItems, items.slice(0, 4));
    assert.equal(plan.commit(), true);
    assert.equal(plan.rollback(), false);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(createLocalCompactionEvidence(groups, binding, null, limits).groups)
      ),
      groups
    );
    for (const bad of [
      {},
      {
        beginTransaction() {
          return null;
        },
      },
    ])
      assert.throws(() => createLocalCompactionEvidence(groups, binding, bad, limits));
    const invalid = [{ index: 0, item: { type: 'function_call_output', output: large } }];
    assert.throws(() => createLocalCompactionEvidence([invalid], binding, store, limits));
  } finally {
    store.close();
  }
});
