'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-compaction-user-archive-'));
Object.assign(process.env, createIsolatedTestEnv(process.env, runtime));

const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const {
  createContextCompactionEnvelopeStore,
} = require('../lib/proxy/context-compaction-envelope');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const { selectLocalCompactionWindow } = require('../lib/proxy/context-compaction-retention');
const { planLocalCompactionSummary } = require('../lib/proxy/context-compaction-summary');
const {
  createLocalCompactionEvidence,
  createLocalCompactionEvidenceReader,
  localCompactionEvidenceOwner,
} = require('../lib/proxy/context-compaction-evidence');
const {
  produceWorkBuddyCompaction,
  prepareWorkBuddyCompactionInput,
  LOCAL_SUMMARY_MARKER,
} = require('../lib/proxy/workbuddy-compaction-bridge');
const { localCompactionSummarySnapshots } = require('../lib/proxy/context-compaction-state-bundle');
const {
  selectHistoricalUserArchive,
  stageHistoricalUserArchive,
  historicalUserArchiveMatches,
  TASK_STATE_SCHEMA,
} = {
  ...require('../lib/proxy/context-user-archive'),
  ...require('../lib/proxy/context-task-state'),
};

const binding = {
  owner: 'archive-fixture',
  provider: 'workbuddy-wbipc',
  model: 'fixture',
  endpoint: 'fixture/v2',
};
const comparable = (value) => JSON.parse(JSON.stringify(value));
function history() {
  return [
    { type: 'message', role: 'system', content: '保护系统策略。' },
    { role: 'developer', content: '不得泄露认证，不得重跑外部工具。', future: true },
    { type: 'message', role: 'user', content: '首次请求保持原文。' },
    { type: 'message', role: 'user', content: '保留约束甲：禁止重启。' + '长背景🙂。'.repeat(250) },
    { role: 'user', content: '保留约束乙：禁止删除。' + '引用数据\\"🙂。'.repeat(250) },
    { type: 'message', role: 'user', content: '最近一轮。' },
    { type: 'message', role: 'user', content: '当前请求。' },
  ];
}
function completion(request, { omit, invalid = false } = {}) {
  const payload = JSON.parse(request.messages[1].content);
  assert.equal(request.tools, undefined);
  assert.equal(request.tool_choice, undefined);
  const requirements = [...(payload.previous?.state?.requirements ?? [])];
  for (const source of payload.sources.filter(
    (entry) => entry.role === 'user' && entry.id !== omit
  )) {
    if (requirements.some((entry) => entry.id === 'r_' + source.id)) continue;
    const citation = payload.citations.find((entry) => entry.sourceId === source.id);
    requirements.push({
      id: 'r_' + source.id,
      status: 'active',
      sources: [{ citationId: citation.citationId }],
    });
  }
  const state = {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements,
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: invalid
              ? '{}'
              : JSON.stringify({ summary: '仅本地合成摘要，不是质量验收。', state }),
          },
        },
      ],
    }),
  };
}
function setup(options = {}) {
  const artifacts = createContextArtifactStore(options.artifactOptions);
  const envelopes = createContextCompactionEnvelopeStore(options.envelopeOptions);
  const coordinator = createContextCompactionCoordinator();
  const sent = [];
  const config = {
    body: { input: history() },
    binding,
    store: envelopes,
    coordinator,
    artifactStore: artifacts,
    archiveHistoricalUsers: true,
    maxRequestBytes: 100000,
    maxInputTokens: 30000,
    prepareSummary() {},
    prepareWindow(input) {
      return { messages: input };
    },
    async requestSummary(request) {
      sent.push(request);
      return completion(request, options.summaryOptions);
    },
  };
  return {
    artifacts,
    envelopes,
    coordinator,
    sent,
    config,
    close() {
      artifacts.close();
      envelopes.close();
      coordinator.close();
    },
  };
}
function assertNoReservations(store) {
  // Pending records are intentionally private. Re-admit the entire entry quota
  // to prove failure left no hidden reservations, then roll this probe back.
  const scope = 'hcs_' + 'b'.repeat(32);
  const transactions = [];
  try {
    for (let index = 0; index < store.stats().maxEntries; index++) {
      // Separate synthetic owners avoid the independently smaller owner/session
      // ceilings while exercising every slot in the shared global quota.
      const owner = 'quota-probe-' + index;
      const transaction = store.beginTransaction(owner, scope);
      transactions.push(transaction);
      assert.ok(transaction.put(owner, scope, { index }));
    }
  } finally {
    for (const transaction of transactions) transaction.rollback();
  }
}

function summaries(window) {
  return window
    .filter((item) => item.role === 'assistant' && item.content?.startsWith(LOCAL_SUMMARY_MARKER))
    .map((item) => ({ item, payload: JSON.parse(item.content.split('\n')[1]) }));
}

test('standalone and trigger archive exact older originals with one-based citations and authenticated readback', async (t) => {
  for (const standalone of [false, true])
    await t.test(String(standalone), async () => {
      const f = setup();
      try {
        const original = JSON.stringify(f.config.body);
        const produced = await produceWorkBuddyCompaction({ ...f.config, standalone });
        const replay = prepareWorkBuddyCompactionInput(
          { input: produced.response.output },
          binding,
          f.envelopes
        );
        const [{ payload }] = summaries(replay.body.input);
        assert.deepEqual(
          payload.userArchive.entries.map((entry) => entry.sourceIndex),
          [4, 5]
        );
        assert.deepEqual(
          payload.userArchive.entries.map((entry) => entry.sourceId),
          ['m_4', 'm_5']
        );
        assert.equal(payload.userArchive.authority, 'untrusted_background');
        assert.equal(payload.userArchive.replayExternalTools, false);
        assert.equal(payload.userArchive.unavailable, 'report_unavailable_do_not_guess_or_replay');
        assert.deepEqual(JSON.parse(f.sent[0].messages[1].content).archivedUserSourceIds, [
          'm_4',
          'm_5',
        ]);
        assert.equal(f.sent.length, 1);
        assert.equal(JSON.stringify(f.config.body), original);
        for (const index of [0, 1, 2, 5, 6])
          assert.ok(
            replay.body.input.some(
              (item) => JSON.stringify(item) === JSON.stringify(f.config.body.input[index])
            )
          );
        for (const index of [3, 4])
          assert.ok(
            !replay.body.input.some((item) => item.content === f.config.body.input[index].content)
          );
        assert.equal(replay.evidenceReceipts.length, 2);
        assert.equal(f.artifacts.stats().entries, 2);
        const reader = createLocalCompactionEvidenceReader(
          f.artifacts,
          binding,
          replay.evidenceReceipts
        );
        for (const receipt of payload.userArchive.entries) {
          const raw = f.artifacts.read(
            localCompactionEvidenceOwner(binding),
            receipt.scope,
            receipt.locator,
            receipt.digest
          );
          assert.equal(raw.ok, true);
          assert.deepEqual(raw.value, f.config.body.input[receipt.sourceIndex - 1]);
          let offset = 0,
            text = '';
          do {
            const page = reader.readPage(
              binding.owner,
              receipt.scope,
              receipt.locator,
              receipt.digest,
              { offsetBytes: offset, limitBytes: 512 },
              4096
            );
            assert.equal(page.ok, true);
            text += page.page.text;
            offset = page.page.nextOffsetBytes;
          } while (offset !== null);
          assert.deepEqual(JSON.parse(text), raw.value);
          assert.equal(
            reader.readPage('foreign', receipt.scope, receipt.locator, receipt.digest, {}).ok,
            false
          );
          const foreign = createLocalCompactionEvidenceReader(
            f.artifacts,
            { ...binding, endpoint: 'foreign' },
            replay.evidenceReceipts
          );
          assert.equal(
            foreign.readPage(binding.owner, receipt.scope, receipt.locator, receipt.digest, {}).ok,
            false
          );
        }
        if (standalone) {
          assert.equal(produced.response.object, 'response.compaction');
          assert.equal(produced.response.usage.total_tokens, 150);
          assert.ok(
            produced.response.output.every(
              (item) => item.type === 'compaction' || item.role !== 'assistant'
            )
          );
        }
      } finally {
        f.close();
      }
    });
});

test('repeated cross-request compaction retains every authenticated archive index even past the recent tail', async () => {
  const f = setup();
  try {
    const first = await produceWorkBuddyCompaction({ ...f.config, standalone: true });
    const replay = prepareWorkBuddyCompactionInput(
      {
        input: [
          ...first.response.output,
          ...Array.from({ length: 5 }, (_, index) => ({
            role: 'assistant',
            content: `later answer ${index}`,
          })),
          { role: 'user', content: '新输入一。' },
          { role: 'user', content: '新输入二。' },
        ],
      },
      binding,
      f.envelopes
    );
    const oldSummary = summaries(replay.body.input)[0].item;
    const second = await produceWorkBuddyCompaction({
      ...f.config,
      standalone: true,
      body: replay.body,
      authenticatedSummaryTexts: replay.summaryTexts,
      evidenceReceipts: replay.evidenceReceipts,
      callIdDigests: replay.callIdDigests,
    });
    const secondReplay = prepareWorkBuddyCompactionInput(
      { input: second.response.output },
      binding,
      f.envelopes
    );
    assert.equal(summaries(secondReplay.body.input).length, 1);
    const retainedSnapshots = localCompactionSummarySnapshots(
      summaries(secondReplay.body.input)[0].item
    );
    assert.equal(retainedSnapshots.length, 2);
    assert.ok(
      retainedSnapshots.some(
        (state) =>
          JSON.stringify(comparable(state)) ===
          JSON.stringify(comparable(localCompactionSummarySnapshots(oldSummary)[0]))
      )
    );
    assert.equal(secondReplay.evidenceReceipts.length, 4);
    const oldReceipts = JSON.parse(oldSummary.content.split('\n')[1]).userArchive.entries;
    const reader = createLocalCompactionEvidenceReader(
      f.artifacts,
      binding,
      secondReplay.evidenceReceipts
    );
    for (const ref of oldReceipts)
      assert.equal(reader.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}).ok, true);
    assert.equal(f.sent.length, 2, 'no automatic retry or external tool execution');
  } finally {
    f.close();
  }
});

test('multiple standalone/trigger cycles keep one root, separate colliding citations and restore every archived original', async (t) => {
  for (const standalone of [false, true])
    await t.test(String(standalone), async () => {
      const f = setup();
      try {
        let produced = await produceWorkBuddyCompaction({ ...f.config, standalone });
        const expectedSnapshots = [];
        const expectedOriginals = new Map();
        for (let cycle = 0; cycle < 4; cycle++) {
          const replay = prepareWorkBuddyCompactionInput(
            { input: produced.response.output },
            binding,
            f.envelopes
          );
          const generated = summaries(replay.body.input);
          assert.equal(generated.length, 1);
          const snapshots = localCompactionSummarySnapshots(generated[0].item);
          assert.equal(snapshots.length, cycle + 1);
          for (const previous of expectedSnapshots)
            assert.ok(
              snapshots.some(
                (state) =>
                  JSON.stringify(comparable(state)) === JSON.stringify(comparable(previous))
              )
            );
          expectedSnapshots.splice(0, expectedSnapshots.length, ...snapshots);
          const reader = createLocalCompactionEvidenceReader(
            f.artifacts,
            binding,
            replay.evidenceReceipts
          );
          for (const state of snapshots)
            for (const receipt of state.userArchive.entries) {
              const restored = f.artifacts.read(
                localCompactionEvidenceOwner(binding),
                receipt.scope,
                receipt.locator,
                receipt.digest
              );
              assert.equal(restored.ok, true);
              if (expectedOriginals.has(receipt.locator))
                assert.deepEqual(restored.value, expectedOriginals.get(receipt.locator));
              else expectedOriginals.set(receipt.locator, restored.value);
              const page = reader.readPage(
                binding.owner,
                receipt.scope,
                receipt.locator,
                receipt.digest,
                {}
              );
              assert.equal(page.ok, true);
              assert.equal(page.page.text, JSON.stringify(restored.value));
            }
          const denied = createLocalCompactionEvidenceReader(
            f.artifacts,
            { ...binding, model: 'foreign' },
            replay.evidenceReceipts
          );
          const ref = replay.evidenceReceipts[0];
          assert.equal(
            denied.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}).ok,
            false
          );
          if (cycle < 3) {
            const expanded = prepareWorkBuddyCompactionInput(
              {
                input: [
                  ...produced.response.output,
                  { role: 'user', content: `轮次${cycle}：保留新的约束。` },
                  { role: 'user', content: `轮次${cycle}：撤销此前重启许可，禁止工具重跑。` },
                ],
              },
              binding,
              f.envelopes
            );
            produced = await produceWorkBuddyCompaction({
              ...f.config,
              standalone,
              body: expanded.body,
              authenticatedSummaryTexts: expanded.summaryTexts,
              evidenceReceipts: expanded.evidenceReceipts,
              callIdDigests: expanded.callIdDigests,
            });
          }
        }
        assert.equal(expectedOriginals.size, 8);
        assert.equal(f.sent.length, 4);
        assert.ok(expectedSnapshots.every((state) => state.taskState.requirements.length > 0));
      } finally {
        f.close();
      }
    });
});

test('root consolidation preserves prior tokens and evidence on later cancellation or publication failure', async (t) => {
  for (const mode of ['cancel', 'publish', 'admission'])
    await t.test(mode, async () => {
      const f = setup();
      try {
        const first = await produceWorkBuddyCompaction({ ...f.config, standalone: true });
        const replay = prepareWorkBuddyCompactionInput(
          {
            input: [
              ...first.response.output,
              { role: 'user', content: '追加一。' },
              { role: 'user', content: '追加二。' },
            ],
          },
          binding,
          f.envelopes
        );
        const beforeEntries = f.artifacts.stats().entries;
        const beforeEnvelopes = f.envelopes.stats().entries;
        const controller = new globalThis.AbortController();
        const store =
          mode === 'publish'
            ? {
                ...f.envelopes,
                issue() {
                  throw new Error('SYNTHETIC_PUBLICATION_FAILURE');
                },
              }
            : f.envelopes;
        await assert.rejects(
          produceWorkBuddyCompaction({
            ...f.config,
            standalone: true,
            body: replay.body,
            authenticatedSummaryTexts: replay.summaryTexts,
            evidenceReceipts: replay.evidenceReceipts,
            callIdDigests: replay.callIdDigests,
            signal: controller.signal,
            store,
            prepareWindow(input) {
              const states = localCompactionSummarySnapshots(summaries(input)[0].item);
              assert.equal(
                states.length,
                2,
                'failure occurs after a consolidated root is prepared'
              );
              if (mode === 'cancel') controller.abort();
              return mode === 'admission' ? { padding: 'x'.repeat(120000) } : { messages: input };
            },
          })
        );
        assert.equal(f.artifacts.stats().entries, beforeEntries);
        assert.equal(f.envelopes.stats().entries, beforeEnvelopes);
        const previous = prepareWorkBuddyCompactionInput(
          { input: first.response.output },
          binding,
          f.envelopes
        );
        const reader = createLocalCompactionEvidenceReader(
          f.artifacts,
          binding,
          previous.evidenceReceipts
        );
        for (const ref of previous.evidenceReceipts)
          assert.equal(
            reader.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}).ok,
            true
          );
        assert.equal(f.sent.length, 2);
      } finally {
        f.close();
      }
    });
});

test('a consolidated root does not extend hard evidence lifetime or grant recovery after process-store replacement', async () => {
  let now = 100;
  const f = setup({
    artifactOptions: { now: () => now, ttlMs: 1000, maxLifetimeMs: 1000 },
    envelopeOptions: { now: () => now, ttlMs: 1000, maxLifetimeMs: 1000 },
  });
  try {
    const first = await produceWorkBuddyCompaction({ ...f.config, standalone: true });
    const expanded = prepareWorkBuddyCompactionInput(
      {
        input: [
          ...first.response.output,
          { role: 'user', content: '追加一。' },
          { role: 'user', content: '追加二。' },
        ],
      },
      binding,
      f.envelopes
    );
    now += 500;
    const second = await produceWorkBuddyCompaction({
      ...f.config,
      standalone: true,
      body: expanded.body,
      authenticatedSummaryTexts: expanded.summaryTexts,
      evidenceReceipts: expanded.evidenceReceipts,
      callIdDigests: expanded.callIdDigests,
    });
    const replay = prepareWorkBuddyCompactionInput(
      { input: second.response.output },
      binding,
      f.envelopes
    );
    assert.equal(localCompactionSummarySnapshots(summaries(replay.body.input)[0].item).length, 2);
    const reader = createLocalCompactionEvidenceReader(
      f.artifacts,
      binding,
      replay.evidenceReceipts
    );
    const ref = replay.evidenceReceipts[0];
    now = 1100;
    assert.equal(reader.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}).ok, false);
    const replacement = createContextArtifactStore();
    const replacementEnvelopes = createContextCompactionEnvelopeStore();
    try {
      const missing = createLocalCompactionEvidenceReader(
        replacement,
        binding,
        replay.evidenceReceipts
      );
      assert.equal(
        missing.readPage(binding.owner, ref.scope, ref.locator, ref.digest, {}).ok,
        false
      );
      assert.throws(() =>
        prepareWorkBuddyCompactionInput(
          { input: second.response.output },
          binding,
          replacementEnvelopes
        )
      );
    } finally {
      replacement.close();
      replacementEnvelopes.close();
    }
    assert.equal(f.sent.length, 2, 'no reacquisition or replay');
  } finally {
    f.close();
  }
});

test('missing citation coverage, storage and quota keep all original users without partial evidence', async (t) => {
  for (const mode of ['coverage', 'storage', 'quota', 'receipt'])
    await t.test(mode, async () => {
      const f = setup(
        mode === 'quota'
          ? { artifactOptions: { maxEntries: 1 } }
          : mode === 'coverage'
            ? { summaryOptions: { omit: 'm_5' } }
            : {}
      );
      try {
        let artifactStore = f.artifacts;
        if (mode === 'storage') artifactStore = undefined;
        if (mode === 'receipt')
          artifactStore = {
            beginTransaction(owner, scope) {
              const transaction = f.artifacts.beginTransaction(owner, scope);
              return {
                ...transaction,
                put(...args) {
                  const receipt = transaction.put(...args);
                  return { ...receipt, digest: 'f'.repeat(64) };
                },
              };
            },
          };
        const produced = await produceWorkBuddyCompaction({ ...f.config, artifactStore });
        const window = f.envelopes.read(produced.token, binding);
        for (const original of f.config.body.input.filter((item) => item.role === 'user'))
          assert.ok(window.some((item) => JSON.stringify(item) === JSON.stringify(original)));
        assert.equal(summaries(window)[0].payload.userArchive, undefined);
        assert.equal(f.artifacts.stats().entries, 0);
        assertNoReservations(f.artifacts);
      } finally {
        f.close();
      }
    });
});

test('native incremental requirement loss leaves the prior authenticated branch and evidence intact', async (t) => {
  for (const mode of ['revision-source', 'revision-quote', 'certainty'])
    await t.test(mode, async () => {
      const f = setup();
      try {
        const first = await produceWorkBuddyCompaction({ ...f.config, standalone: true });
        const replay = prepareWorkBuddyCompactionInput(
          { input: first.response.output },
          binding,
          f.envelopes
        );
        const restrictionText = 'Do not restart the service.';
        const revisionText = 'Revoke the restart restriction. Keep changes.';
        const laterText = 'A different later user revision.';
        const narration = (ordinal) => ({
          role: 'assistant',
          content: `Unverified branch report ${ordinal}. ` + 'Reported, not verified. '.repeat(500),
        });
        const body = {
          input: [
            ...replay.body.input,
            { role: 'user', content: restrictionText },
            narration(0),
            narration(1),
            { role: 'user', content: revisionText },
            narration(2),
            narration(3),
            { role: 'user', content: laterText },
            { role: 'assistant', content: 'Recent report one.' },
            { role: 'assistant', content: 'Recent report two.' },
            { role: 'user', content: 'Current input must remain exact.' },
          ],
        };
        const before = JSON.stringify(body);
        const oldWindow = comparable(f.envelopes.read(first.token, binding));
        const oldEnvelopeStats = f.envelopes.stats();
        const oldArtifactStats = f.artifacts.stats();
        let calls = 0;
        let changed = false;
        await assert.rejects(
          produceWorkBuddyCompaction({
            ...f.config,
            body,
            standalone: true,
            maxRequestBytes: 45000,
            maxInputTokens: 15000,
            authenticatedSummaryTexts: replay.summaryTexts,
            evidenceReceipts: replay.evidenceReceipts,
            callIdDigests: replay.callIdDigests,
            async requestSummary(request) {
              calls++;
              const payload = JSON.parse(request.messages[1].content);
              const response = completion(request);
              const wire = JSON.parse(response.body);
              const value = JSON.parse(wire.choices[0].message.content);
              const findSource = (text) => {
                const entry = payload.transcript.find(
                  (item) => item.item.role === 'user' && item.item.content === text
                );
                return entry && payload.sources.find((item) => item.index === entry.index);
              };
              const original = findSource(restrictionText);
              if (original)
                value.state.requirements.push({
                  id: 'branch_restart',
                  text: restrictionText,
                  status: mode === 'certainty' ? 'uncertain' : 'active',
                  sources: [{ sourceId: original.id, quote: restrictionText }],
                });
              const retained = value.state.requirements.find(
                (entry) => entry.id === 'branch_restart'
              );
              const revocation = findSource(revisionText);
              if (retained && revocation && mode !== 'certainty') {
                retained.status = 'revoked';
                retained.revision = {
                  sourceId: revocation.id,
                  quote: 'Revoke the restart restriction.',
                };
              }
              const later = findSource(laterText);
              if (retained && later) {
                assert.equal(
                  payload.previous.state.requirements.find((entry) => entry.id === 'branch_restart')
                    .status,
                  mode === 'certainty' ? 'uncertain' : 'revoked'
                );
                changed = true;
                if (mode === 'certainty') retained.status = 'active';
                else if (mode === 'revision-source')
                  retained.revision = { sourceId: later.id, quote: laterText };
                else retained.revision.quote = 'Keep changes.';
              }
              wire.choices[0].message.content = JSON.stringify(value);
              return { ...response, body: JSON.stringify(wire) };
            },
          }),
          { code: 'invalid_compaction_summary' }
        );
        assert.equal(
          changed,
          true,
          'exercise a source-valid lossy candidate, not a planning rejection'
        );
        assert.ok(calls >= 3 && calls <= 16, 'bounded callbacks; no automatic retry');
        assert.equal(JSON.stringify(body), before);
        assert.deepEqual(f.envelopes.stats(), oldEnvelopeStats);
        assert.deepEqual(f.artifacts.stats(), oldArtifactStats);
        assert.deepEqual(comparable(f.envelopes.read(first.token, binding)), oldWindow);
        const reader = createLocalCompactionEvidenceReader(
          f.artifacts,
          binding,
          replay.evidenceReceipts
        );
        for (const receipt of replay.evidenceReceipts)
          assert.equal(
            reader.readPage(binding.owner, receipt.scope, receipt.locator, receipt.digest, {}).ok,
            true
          );
      } finally {
        f.close();
      }
    });
});

test('invalid summary, cancellation, expired reservation and final admission roll back archive and token', async (t) => {
  for (const mode of ['invalid', 'cancel', 'expiry', 'budget', 'commit'])
    await t.test(mode, async () => {
      let now = 0;
      const f = setup(
        mode === 'invalid'
          ? { summaryOptions: { invalid: true } }
          : mode === 'expiry'
            ? {
                artifactOptions: { now: () => now, ttlMs: 20 },
                envelopeOptions: { now: () => now },
              }
            : {}
      );
      const controller = new globalThis.AbortController();
      const original = JSON.stringify(f.config.body);
      try {
        const prepareWindow = (input) => {
          if (mode === 'expiry') now = 21;
          return { messages: input, ...(mode === 'budget' ? { padding: 'x'.repeat(120000) } : {}) };
        };
        let artifactStore = f.artifacts;
        if (mode === 'commit')
          artifactStore = {
            beginTransaction(owner, scope) {
              const transaction = f.artifacts.beginTransaction(owner, scope);
              return {
                ...transaction,
                commit() {
                  return { ok: false, reason: 'fixture' };
                },
              };
            },
          };
        await assert.rejects(
          produceWorkBuddyCompaction({
            ...f.config,
            artifactStore,
            standalone: true,
            prepareWindow,
            signal: controller.signal,
            async requestSummary(request) {
              if (mode === 'cancel') controller.abort();
              return completion(request, { invalid: mode === 'invalid' });
            },
          })
        );
        assert.equal(f.envelopes.stats().entries, 0);
        assert.equal(f.artifacts.stats().entries, 0);
        assertNoReservations(f.artifacts);
        assert.equal(JSON.stringify(f.config.body), original);
      } finally {
        f.close();
      }
    });
});

test('native selection preserves malformed, unknown, media, pinned and unsafe inputs, with bounded quotas', () => {
  const source = history();
  const extra = [
    { role: 'user', content: '', type: 'message' },
    { role: 'user', content: 'unknown', future: true },
    { type: 'future', role: 'user', content: 'future type' },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'mixed' },
        { type: 'input_image', image_url: 'fixture' },
      ],
    },
    { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' },
    { role: 'user', content: 'unsafe user' },
  ];
  source.splice(5, 0, ...extra);
  const selected = selectLocalCompactionWindow(source, {
    archiveHistoricalUsers: true,
    protectedMessageIndices: [3],
  });
  assert.deepEqual(selected.userArchiveSelection.indices, [4]);
  assert.deepEqual(
    comparable(selected.retained.filter((item) => item.role === 'user')),
    source.filter((item) => item.role === 'user'),
    'selection alone never removes original users'
  );
  assert.equal(
    selectHistoricalUserArchive(source, {
      enabled: true,
      protectedIntervals: [],
      inputFormat: 'invalid',
    }).messageCount,
    0
  );
  for (const options of [
    { archiveHistoricalUsers: 'yes' },
    { protectedMessageIndices: [9999] },
    { protectedMessageIndices: [0.5] },
  ])
    assert.throws(() => selectLocalCompactionWindow(history(), options));
  let hooks = 0;
  const getter = {
    role: 'user',
    get content() {
      hooks++;
      throw new Error('must not run');
    },
  };
  assert.throws(() => selectLocalCompactionWindow([getter], { archiveHistoricalUsers: true }));
  assert.equal(hooks, 0);
  const many = Array.from({ length: 100 }, (_, index) => ({
    type: 'message',
    role: 'user',
    content: 'user' + index,
  }));
  assert.equal(
    selectLocalCompactionWindow(many, { archiveHistoricalUsers: true }).userArchiveSelection
      .messageCount,
    64
  );
});

test('native removal capability is source-array bound and ordinary Chat still rejects native message types', () => {
  const source = history();
  const selection = selectHistoricalUserArchive(source, {
    enabled: true,
    protectedIntervals: [],
    inputFormat: 'responses',
  });
  const state = {
    objectives: selection.indices.map((index) => ({
      sources: [
        {
          sourceRole: 'user',
          sourceIndex: index + 1,
          sourceId: `m_${index + 1}`,
          quote: source[index].content.slice(0, 10),
        },
      ],
    })),
    requirements: [],
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
  const artifacts = createContextArtifactStore();
  const scope = 'hcs_' + 'a'.repeat(32);
  const transaction = artifacts.beginTransaction(binding.owner, scope);
  try {
    const archive = stageHistoricalUserArchive(selection, state, transaction, binding.owner, scope);
    assert.ok(archive);
    assert.equal(
      historicalUserArchiveMatches(archive, 3, source[3], binding.owner, scope, source),
      true
    );
    assert.equal(
      historicalUserArchiveMatches(archive, 3, source[3], binding.owner, scope, [...source]),
      false
    );
    const chatSelection = selectHistoricalUserArchive(source, {
      enabled: true,
      protectedIntervals: [],
    });
    assert.deepEqual(chatSelection.indices, [4]);
    const evidence = createLocalCompactionEvidence(
      [[{ index: 1, item: source[0] }]],
      binding,
      artifacts,
      { maxRequestBytes: 10000, maxInputTokens: 3000 }
    );
    assert.equal(evidence.stageUserArchive({ ...selection }, state, source), null);
    assert.equal(evidence.stageUserArchive(selection, state, [...source]), null);
    let hooks = 0;
    assert.equal(
      evidence.stageUserArchive(
        {
          get messageCount() {
            hooks++;
            return 1;
          },
        },
        state,
        source
      ),
      null
    );
    const poisoned = [...source];
    Object.defineProperty(poisoned, '3', {
      get() {
        hooks++;
        return source[3];
      },
    });
    assert.equal(evidence.stageUserArchive(selection, state, poisoned), null);
    assert.equal(hooks, 0);
    evidence.rollback();
  } finally {
    transaction.rollback();
    artifacts.close();
  }
});

test('native summary archive controls reject invalid indices/hooks and participate in single-flight identity', () => {
  const groups = history().map((item, index) => [{ index: index + 1, item }]);
  const config = {
    model: binding.model,
    maxRequestBytes: 100000,
    maxInputTokens: 30000,
    prepareSummary() {},
  };
  for (const indices of [
    null,
    [0],
    [2049],
    [4, 4],
    [5, 4],
    [1.5],
    Array.from({ length: 65 }, (_, index) => index + 1),
  ])
    assert.throws(() =>
      planLocalCompactionSummary(groups, { ...config, archiveUserSourceIndices: indices })
    );
  let hooks = 0;
  assert.throws(() =>
    planLocalCompactionSummary(groups, {
      ...config,
      get archiveUserSourceIndices() {
        hooks++;
        return [4];
      },
    })
  );
  assert.equal(hooks, 0);
  const first = planLocalCompactionSummary(groups, config);
  const second = planLocalCompactionSummary(groups, {
    ...config,
    archiveUserSourceIndices: [4, 5],
  });
  assert.notEqual(first.digest, second.digest);
});

test('archival is explicit opt-in and cannot repair oversized current/policy input', async () => {
  const f = setup();
  try {
    const unchanged = await produceWorkBuddyCompaction({
      ...f.config,
      archiveHistoricalUsers: false,
    });
    assert.deepEqual(comparable(f.envelopes.read(unchanged.token, binding)), f.config.body.input);
    assert.equal(f.sent.length, 0);
    const body = {
      input: [
        { role: 'system', content: 'x'.repeat(120000) },
        { role: 'user', content: 'current' },
      ],
    };
    await assert.rejects(produceWorkBuddyCompaction({ ...f.config, body, standalone: true }), {
      code: 'compaction_source_too_large',
    });
    assert.equal(f.sent.length, 0, 'no futile summary for protected-only history');
  } finally {
    f.close();
  }
});

test('malformed bridge input fails at the local input boundary before summary or storage work', async () => {
  const f = setup();
  try {
    for (const body of [
      null,
      {},
      [],
      { input: null },
      { input: 'text' },
      { input: [] },
      { input: [null] },
      { input: [42] },
      { input: [[]] },
    ]) {
      await assert.rejects(produceWorkBuddyCompaction({ ...f.config, body }), {
        code: 'empty_compaction_input',
      });
    }
    assert.equal(f.sent.length, 0);
    assert.equal(f.artifacts.stats().entries, 0);
    assert.equal(f.envelopes.stats().entries, 0);
  } finally {
    f.close();
  }
});

test('known native text blocks archive the complete original structure, never unknown or mixed blocks', async () => {
  const f = setup();
  try {
    const original = {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '禁止重启，保持认证。' },
        { type: 'text', text: '缺证据不猜测。🙂' },
      ],
    };
    const body = { input: history() };
    body.input[3] = original;
    const produced = await produceWorkBuddyCompaction({ ...f.config, body });
    const replay = prepareWorkBuddyCompactionInput(
      { input: produced.response.output },
      binding,
      f.envelopes
    );
    const archive = summaries(replay.body.input)[0].payload.userArchive;
    assert.deepEqual(
      archive.entries.map((entry) => entry.sourceIndex),
      [4, 5]
    );
    const receipt = archive.entries[0];
    const raw = f.artifacts.read(
      localCompactionEvidenceOwner(binding),
      receipt.scope,
      receipt.locator,
      receipt.digest
    );
    assert.deepEqual(raw.value, original);
    assert.equal(f.sent.length, 1);
    const variants = [
      [],
      [{ type: 'input_text', text: ' ' }],
      [{ type: 'output_text', text: 'unsupported' }],
      [{ type: 'input_text', text: 'unknown annotation', annotations: [] }],
      [...original.content, { type: 'input_image', image_url: 'fixture' }],
      ['unknown'],
      [null],
      Array.from({ length: 257 }, () => ({ type: 'input_text', text: 'limit' })),
    ];
    for (const content of variants) {
      const input = history();
      input[3] = { role: 'user', content };
      const selection = selectLocalCompactionWindow(input, { archiveHistoricalUsers: true });
      assert.deepEqual(selection.userArchiveSelection.indices, [4]);
    }
    const chat = history();
    chat[3] = { role: 'user', content: original.content };
    assert.deepEqual(
      selectHistoricalUserArchive(chat, { enabled: true, protectedIntervals: [] }).indices,
      [4]
    );
  } finally {
    f.close();
  }
});
