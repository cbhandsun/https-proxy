'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { collectContextArtifactReferences } = require('../lib/proxy/context-artifact-references');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const { createContextCompactionBackoff } = require('../lib/proxy/context-compaction-backoff');
const { createContextSummaryCheckpoints } = require('../lib/proxy/context-summary-checkpoints');
const { applyResponsesHistoryPolicy } = require('../lib/proxy/responses-history-policy');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const {
  TASK_STATE_SCHEMA,
  TASK_STATE_MARKER,
  createTaskStateSource,
} = require('../lib/proxy/context-task-state');
const {
  prepareWorkBuddyTaskStateContext,
  stateFromCompletion,
} = require('../lib/proxy/workbuddy-task-state-planner');

function workload() {
  const messages = [
    { role: 'system', content: '禁止泄露凭证。' },
    { role: 'user', content: '修复压缩。禁止重启。保留修改。' },
  ];
  for (let index = 0; index < 20; index += 1)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: `call-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: `call-${index}`, content: '证据🙂'.repeat(1500) },
      { role: 'assistant', content: `报告${index}：测试完成仍未验证。` + '历史进展。'.repeat(100) }
    );
  messages.push({ role: 'user', content: '撤销禁止重启，必要时可以重启。' });
  return { model: 'fixture-model', messages };
}
function options(store, extra = {}) {
  return {
    force: true,
    targetBodyBytes: 70000,
    artifactOwner: 'owner',
    artifactScope: 'scope',
    artifactStore: store,
    ...extra,
  };
}
function summary(request, extra = {}) {
  const transcript = JSON.parse(request.messages[1].content).transcript;
  const revision = transcript.findLast((entry) => entry.role === 'user');
  return {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements: [
      {
        id: 'r1',
        text: '禁止重启。',
        status: 'revoked',
        sources: [{ sourceId: 'm_1', quote: '禁止重启。' }],
        revision: { sourceId: revision.id, quote: '撤销禁止重启' },
      },
    ],
    decisions: [],
    work: [
      {
        text: '测试完成仅为报告',
        status: 'reported_complete',
        sources: [{ sourceId: 'm_4', quote: '测试完成仍未验证。' }],
      },
    ],
    blockers: [],
    nextSteps: [],
    files: [],
    ...extra,
  };
}
function completion(value, extra = {}) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: typeof value === 'string' ? value : JSON.stringify(value),
          },
          ...extra,
        },
      ],
    }),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('large tool history and immutable policy do not prevent a bounded task-state summary', async () => {
  const body = workload();
  body.messages[0].content = 'immutable-policy '.repeat(14000);
  body.messages.splice(
    2,
    0,
    ...Array.from({ length: 2100 }, (_value, index) => [
      {
        role: 'assistant',
        tool_calls: [
          { id: `empty-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: `empty-${index}`, content: '' },
    ]).flat()
  );
  const original = JSON.stringify(body);
  let calls = 0;
  const result = await prepareWorkBuddyTaskStateContext(
    body,
    options(null, { targetBodyBytes: 274421 }),
    {
      requestSummary: async (request) => {
        calls++;
        const payload = JSON.parse(request.messages[1].content);
        assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 274421);
        assert.ok(!JSON.stringify(payload).includes('immutable-policy'));
        assert.ok(!JSON.stringify(payload).includes('证据🙂'));
        const firstUser = payload.transcript.find((entry) => entry.role === 'user');
        return completion({
          schema: TASK_STATE_SCHEMA,
          version: 1,
          objectives: [
            { text: '修复压缩', sources: [{ sourceId: firstUser.id, quote: '修复压缩。' }] },
          ],
          requirements: [],
          decisions: [],
          work: [],
          blockers: [],
          nextSteps: [],
          files: [],
        });
      },
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.diagnostics.taskStateStatus, 'applied');
  assert.equal(result.fits, true);
  assert.ok(result.body.messages.includes(body.messages[0]));
  assert.equal(JSON.stringify(body), original);
});

test('33 MB history and oversized required inputs back off an exact reconnect without another model request', async (t) => {
  const messages = [
    ...Array.from({ length: 45 }, (_, index) => ({
      role: 'system',
      content: `Policy ${index}: ` + 'p'.repeat(6000),
    })),
    ...Array.from({ length: 66 }, (_, index) => ({
      role: 'user',
      content: `Constraint ${index}: preserve original. ` + 'u'.repeat(2650),
    })),
  ];
  const toolOutput = 'synthetic tool evidence '.repeat(17000);
  for (let index = 0; index < 80; index++)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: `large_${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: `large_${index}`, content: toolOutput },
      { role: 'assistant', content: `Unverified progress ${index}.` }
    );
  messages.push(
    { role: 'user', content: 'Recent constraint: preserve state.' },
    { role: 'user', content: 'Continue safely.' }
  );
  const body = { model: 'fixture-model', messages };
  const sourceBytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(sourceBytes > 30 * 1024 * 1024);
  const backoff = createContextCompactionBackoff({ now: () => 1000 });
  const coordinator = createContextCompactionCoordinator();
  let calls = 0;
  const measurements = [];
  try {
    for (const [index, scope] of ['first', 'reconnect'].entries()) {
      const store = createContextArtifactStore();
      const history = createContextHistoryBranch(body, {
        owner: 'owner',
        scope,
        // Match the production ingress branch, not its smaller host-send budget.
        maxBytes: 64 * 1024 * 1024,
      });
      try {
        const result = await prepareWorkBuddyTaskStateContext(
          body,
          options(store, {
            artifactScope: scope,
            targetBodyBytes: 393216,
            archiveHistoricalUsers: true,
          }),
          {
            historyBranch: history,
            coordinator,
            compactionScope: scope,
            failureBackoff: backoff,
            compactionRetryBinding: {
              owner: 'owner',
              provider: 'workbuddy-wbipc',
              model: body.model,
              endpoint: 'https://host/v2',
            },
            requestSummary: async () => {
              calls++;
              return completion('{}');
            },
          }
        );
        assert.equal(result.fits, false);
        assert.equal(result.body.messages.length, messages.length);
        assert.ok(result.diagnostics.requiredContextMessageBytes > 393216);
        assert.equal(result.diagnostics.userArchiveStatus, 'selected');
        assert.equal(result.diagnostics.taskStateFailureReason, 'summary_schema_invalid');
        assert.equal(result.diagnostics.taskStateBackoffApplied, index > 0);
        assert.equal(result.diagnostics.taskStateSummaryAttempted, index === 0);
        assert.equal(result.diagnostics.compactionTiming.summaryRequests, index === 0 ? 1 : 0);
        assert.equal(result.diagnostics.archivedUserMessages, 0);
        assert.equal(result.diagnostics.historyTransactionStatus, 'rolled_back');
        assert.equal(store.stats().entries, 0);
        measurements.push({
          requiredBytes: result.diagnostics.requiredContextMessageBytes,
          archivedUsers: result.diagnostics.archivedUserMessages,
          backoffApplied: result.diagnostics.taskStateBackoffApplied,
          timing: result.diagnostics.compactionTiming,
        });
      } finally {
        history.close();
        store.close();
      }
    }
    assert.equal(calls, 1);
    t.diagnostic(JSON.stringify({ sourceBytes, modelRequests: calls, measurements }));
  } finally {
    coordinator.close();
  }
});

function chunkedWorkload() {
  const body = workload();
  for (const [index, message] of body.messages.entries())
    if (message.role === 'assistant' && typeof message.content === 'string')
      message.content = Array.from(
        { length: 100 },
        (_entry, line) => `Progress ${index} line ${line}: unverified. ` + 'data '.repeat(30)
      ).join('\n');
  return body;
}
function chunkedSummary(request) {
  const payload = JSON.parse(request.messages[1].content);
  if (payload.previous) return completion(payload.previous);
  const citation = payload.citations[0];
  return completion({
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [
      {
        text: 'Source-backed task',
        sources: [{ sourceId: citation.sourceId, quote: citation.quote }],
      },
    ],
    requirements: [],
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  });
}

test('committed chunk checkpoints resume across scopes and process new constraints without sharing evidence', async (t) => {
  const checkpoints = createContextSummaryCheckpoints();
  const store = createContextArtifactStore();
  const binding = {
    owner: 'owner',
    provider: 'workbuddy-wbipc',
    model: 'fixture-model',
    endpoint: '/v2',
  };
  const original = chunkedWorkload();
  const scopes = ['first-request', 'reconnect', 'appended-request'];
  const plans = [];
  const seen = [];
  try {
    for (const [index, scope] of scopes.entries()) {
      const body = globalThis.structuredClone(original);
      if (index === 2)
        body.messages.push({ role: 'user', content: 'NEW: retain checkpoint evidence.' });
      const before = JSON.stringify(body);
      const history = createContextHistoryBranch(body, { owner: 'owner', scope });
      let calls = 0;
      try {
        const plan = await prepareWorkBuddyTaskStateContext(
          body,
          options(store, { targetBodyBytes: 170000, artifactScope: scope }),
          {
            historyBranch: history,
            summaryCheckpoints: checkpoints,
            compactionRetryBinding: binding,
            requestSummary: async (request) => {
              calls++;
              const payload = JSON.parse(request.messages[1].content);
              seen.push({ index, sourceIndices: payload.transcript.map((entry) => entry.index) });
              const response = chunkedSummary(request);
              const completionBody = JSON.parse(response.body);
              const state = JSON.parse(completionBody.choices[0].message.content);
              const newConstraint = payload.citations.find((entry) =>
                entry.quote.startsWith('NEW:')
              );
              if (newConstraint)
                state.requirements.push({
                  id: 'new',
                  status: 'active',
                  text: newConstraint.quote,
                  sources: [{ sourceId: newConstraint.sourceId, quote: newConstraint.quote }],
                });
              return completion(state);
            },
          }
        );
        assert.equal(plan.fits, true);
        assert.equal(plan.diagnostics.taskStateStatus, 'applied');
        assert.equal(plan.diagnostics.taskStateCheckpointCommitted, true);
        assert.equal(plan.diagnostics.taskStateSummaryAttempted, calls > 0);
        assert.equal(JSON.stringify(body), before, 'caller history is not mutated');
        assert.deepEqual(
          plan.body.messages.filter((message) => message.role === 'user'),
          body.messages.filter((message) => message.role === 'user')
        );
        plans.push({ calls, diagnostics: plan.diagnostics });
        if (index === 2) {
          const taskMessage = plan.body.messages.find((message) =>
            message.content?.startsWith(TASK_STATE_MARKER)
          );
          const task = JSON.parse(taskMessage.content.slice(TASK_STATE_MARKER.length + 1));
          assert.equal(
            task.state.requirements.find((entry) => entry.id === 'new').text,
            'NEW: retain checkpoint evidence.'
          );
        }
        const receipts = collectContextArtifactReferences(plan.body.messages, scope);
        assert.ok(receipts.length > 0);
        for (const receipt of receipts) {
          assert.equal(store.read('owner', scope, receipt.locator, receipt.digest).ok, true);
          assert.equal(store.read('owner', 'foreign', receipt.locator, receipt.digest).ok, false);
          assert.equal(
            store.read('foreign-owner', scope, receipt.locator, receipt.digest).ok,
            false
          );
        }
      } finally {
        history.close();
      }
    }
    assert.ok(plans[0].calls > 1);
    assert.equal(
      plans[1].calls,
      0,
      'new request-local scope revalidates the furthest committed semantic frontier'
    );
    assert.equal(plans[1].diagnostics.taskStateCheckpointHits, 1);
    assert.equal(plans[1].diagnostics.taskStateFrontierReused, true);
    assert.equal(plans[1].diagnostics.taskStateFrontierSourceMessages, original.messages.length);
    assert.equal(plans[1].diagnostics.compactionTiming.summaryRequests, 0);
    assert.ok(
      plans[2].calls > 0 && plans[2].calls < plans[0].calls,
      'only changed suffix chunks request a model'
    );
    assert.ok(plans[2].diagnostics.taskStateCheckpointHits > 0);
    assert.equal(plans[2].diagnostics.taskStateFrontierSourceMessages, original.messages.length);
    assert.ok(
      seen
        .filter((entry) => entry.index === 2)
        .every((entry) =>
          entry.sourceIndices.every((sourceIndex) => sourceIndex >= original.messages.length)
        )
    );
    t.diagnostic(
      JSON.stringify({
        modelRequests: plans.map((plan) => plan.calls),
        reusedChunks: plans.map((plan) => plan.diagnostics.taskStateCheckpointHits),
      })
    );
  } finally {
    checkpoints.close();
    store.close();
  }
});

test('summary checkpoints publish only after the outer safe-point commit, never after rollback or failed publication', async () => {
  for (const mode of [
    'deferred',
    'rollback',
    'publication_failure',
    'invalid_summary',
    'stale',
    'cancelled',
  ]) {
    const checkpoints = createContextSummaryCheckpoints();
    const body = chunkedWorkload();
    const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
    const store = createContextArtifactStore();
    const controller = new globalThis.AbortController();
    let calls = 0;
    try {
      const plan = await prepareWorkBuddyTaskStateContext(
        body,
        options(
          mode === 'publication_failure'
            ? {
                beginTransaction() {
                  return {
                    put: () => null,
                    stats: () => ({ stagedEntries: 0 }),
                    commit: () => ({ ok: false }),
                    rollback: () => true,
                  };
                },
              }
            : store,
          { targetBodyBytes: 170000 }
        ),
        {
          historyBranch: history,
          signal: controller.signal,
          summaryCheckpoints: checkpoints,
          compactionRetryBinding: {
            owner: 'owner',
            provider: 'workbuddy-wbipc',
            model: 'fixture-model',
            endpoint: '/v2',
          },
          deferCommit: mode === 'deferred' || mode === 'rollback',
          requestSummary: async (request) => {
            calls++;
            if (calls === 2 && mode === 'cancelled') controller.abort();
            if (calls === 2 && mode === 'stale') {
              const snapshot = history.snapshot();
              assert.equal(
                history.replace({ ...snapshot.body, tool_choice: 'none' }, snapshot.version).ok,
                true
              );
            }
            return mode === 'invalid_summary' && calls === 2
              ? completion('{}')
              : chunkedSummary(request);
          },
        }
      );
      assert.equal(checkpoints.stats().entries, 0);
      if (mode === 'deferred') {
        assert.ok(checkpoints.stats().reservedBytes > 0);
        const committed = plan.pendingCommit.commit();
        assert.equal(committed.ok, true);
        assert.equal(committed.plan.diagnostics.taskStateCheckpointCommitted, true);
        assert.ok(checkpoints.stats().entries > 1);
        assert.equal(plan.pendingCommit.commit(), committed, 'safe-point wrapper is idempotent');
      } else if (mode === 'rollback') {
        plan.pendingCommit.rollback();
        assert.equal(plan.pendingCommit.commit().ok, false);
        assert.equal(checkpoints.stats().entries, 0);
      } else {
        assert.equal(plan.diagnostics.taskStateCheckpointCommitted, false);
        assert.equal(checkpoints.stats().active, 0);
      }
      assert.equal(checkpoints.stats().reservedBytes, 0);
    } finally {
      checkpoints.close();
      history.close();
      store.close();
    }
  }
});

test('multi-chunk summaries retain concurrently appended history and retry the complete batch from cache', async () => {
  const body = chunkedWorkload();
  const coordinator = createContextCompactionCoordinator();
  const store = createContextArtifactStore();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
  const tail = { role: 'assistant', content: 'new tail that must not be lost' };
  let calls = 0;
  const runtime = {
    coordinator,
    requestSummary: async (request) => {
      calls++;
      if (calls === 1) assert.equal(history.append([tail], history.stats().version).ok, true);
      return chunkedSummary(request);
    },
  };
  try {
    const first = await prepareWorkBuddyTaskStateContext(
      body,
      options(store, { targetBodyBytes: 170000 }),
      { ...runtime, historyBranch: history }
    );
    assert.equal(first.diagnostics.taskStateStatus, 'applied');
    assert.ok(first.diagnostics.taskStateSummaryChunks > 1);
    assert.equal(calls, first.diagnostics.taskStateSummaryChunks);
    assert.ok(first.body.messages.some((message) => message.content === tail.content));
    const count = calls;
    const retry = await prepareWorkBuddyTaskStateContext(
      body,
      options(null, { targetBodyBytes: 170000 }),
      runtime
    );
    assert.equal(retry.diagnostics.taskStateStatus, 'applied');
    assert.equal(retry.diagnostics.taskStateSummaryReused, true);
    assert.equal(calls, count);
  } finally {
    history.close();
    store.close();
    coordinator.close();
  }
});

test('mid-batch cancellation rolls back owned history and evidence without publishing a partial task state', async () => {
  const body = chunkedWorkload();
  const store = createContextArtifactStore();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
  const controller = new globalThis.AbortController();
  let calls = 0;
  try {
    const result = await prepareWorkBuddyTaskStateContext(
      body,
      options(store, { targetBodyBytes: 170000 }),
      {
        historyBranch: history,
        signal: controller.signal,
        requestSummary: async (request) => {
          calls++;
          controller.abort();
          return chunkedSummary(request);
        },
      }
    );
    assert.equal(calls, 1);
    assert.ok(result.diagnostics.taskStateSummaryChunks > 1);
    assert.equal(result.fits, false);
    assert.equal(result.diagnostics.historyTransactionStatus, 'rolled_back');
    assert.equal(JSON.stringify(history.snapshot().body), JSON.stringify(body));
    assert.equal(store.stats().entries, 0);
    assert.ok(
      !result.body.messages.some((message) => message.content?.startsWith?.(TASK_STATE_MARKER))
    );
  } finally {
    history.close();
    store.close();
  }
});

test('versioned summary snapshots preserve every concurrent tail entry before atomic evidence publication', async () => {
  const store = createContextArtifactStore(),
    body = workload();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
  const tail = Array.from({ length: 8 }, (_value, index) => ({
    role: 'assistant',
    content: `fresh-${index}:` + 'new'.repeat(900),
  }));
  const result = await prepareWorkBuddyTaskStateContext(body, options(store), {
    historyBranch: history,
    requestSummary: async (request) => {
      assert.equal(store.stats().entries, 0);
      assert.equal(history.append(tail, history.stats().version).ok, true);
      return completion(summary(request));
    },
  });
  assert.equal(result.fits, true);
  assert.equal(result.diagnostics.historyTransactionStatus, 'committed');
  assert.equal(result.diagnostics.taskStateStatus, 'applied');
  for (const entry of tail)
    assert.ok(result.body.messages.some((message) => message.content === entry.content));
  assert.equal(JSON.stringify(history.snapshot().body), JSON.stringify(result.body));
  assert.equal(history.stats().version, 3);
  history.close();
  store.close();
});

test('managed model/control replacement rejects asynchronous stale summaries without publishing evidence', async () => {
  const store = createContextArtifactStore(),
    body = workload();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
  const result = await prepareWorkBuddyTaskStateContext(body, options(store), {
    historyBranch: history,
    requestSummary: async (request) => {
      const snapshot = history.snapshot();
      assert.equal(
        history.replace(
          { ...snapshot.body, model: 'new-model', tool_choice: 'none' },
          snapshot.version
        ).ok,
        true
      );
      return completion(summary(request));
    },
  });
  assert.equal(result.fits, false);
  assert.equal(result.diagnostics.taskStateStatus, 'stale_snapshot');
  assert.equal(result.body.model, 'new-model');
  assert.equal(result.body.tool_choice, 'none');
  assert.equal(store.stats().entries, 0);
  assert.equal(store.stats().retainedBytes, 0);
  history.close();
  store.close();
});

test('legacy asynchronous guard also rejects control changes and invalidated messages without throwing or publishing', async () => {
  for (const mutate of [
    (input) => {
      input.model = 'different';
    },
    (input) => {
      input.messages = null;
    },
  ]) {
    const store = createContextArtifactStore(),
      body = workload();
    const result = await prepareWorkBuddyTaskStateContext(body, options(store), {
      requestSummary: async (request) => {
        mutate(body);
        return completion(summary(request));
      },
    });
    assert.equal(result.fits, false);
    assert.equal(result.diagnostics.taskStateStatus, 'stale_snapshot');
    assert.equal(store.stats().entries, 0);
    assert.equal(store.stats().retainedBytes, 0);
    store.close();
  }
});

test('owned history retains concurrent narration through invalid and over-budget summary fallbacks', async () => {
  for (const mode of ['invalid', 'too_large', 'budget']) {
    const store = createContextArtifactStore(),
      body = workload();
    if (mode === 'budget')
      for (const message of body.messages)
        if (message.role === 'assistant' && typeof message.content === 'string')
          message.content = '测试完成仍未验证。' + 'x'.repeat(100);
    const inherited = body.messages[4];
    const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
    const tail = Array.from({ length: 8 }, (_entry, index) => ({
      role: 'assistant',
      content: `new-narration-${index}`,
    }));
    const plan = await prepareWorkBuddyTaskStateContext(
      body,
      options(store, {
        targetBodyBytes: mode === 'budget' ? 25000 : 70000,
        protectedMessages: new Set([inherited]),
      }),
      {
        historyBranch: history,
        requestSummary: async (request) => {
          assert.equal(history.append(tail, history.stats().version).ok, true);
          if (mode === 'invalid') return completion('{}');
          const state = summary(request);
          state.work = Array.from({ length: mode === 'too_large' ? 32 : 30 }, () => ({
            text: 'x'.repeat(650),
            status: 'reported_complete',
            sources:
              mode === 'too_large'
                ? Array(4).fill({ sourceId: 'm_4', quote: '测试完成仍未验证。' })
                : [{ sourceId: 'm_4', quote: '测试完成仍未验证。' }],
          }));
          return completion(state);
        },
      }
    );
    assert.equal(plan.fits, true, mode);
    assert.equal(
      plan.diagnostics.taskStateStatus,
      {
        invalid: 'invalid_compaction_candidate',
        too_large: 'state_too_large',
        budget: 'state_budget_rejected',
      }[mode]
    );
    for (const entry of [inherited, ...tail])
      assert.ok(
        plan.body.messages.some((message) => message.content === entry.content),
        mode
      );
    assert.equal(history.stats().version, 3);
    assert.equal(JSON.stringify(history.snapshot().body), JSON.stringify(plan.body));
    history.close();
    store.close();
  }
});

test('owned async history cancellation, closure and evidence failure publish neither state nor evidence', async () => {
  for (const mode of ['cancelled', 'closed', 'publication']) {
    const store = createContextArtifactStore(),
      body = workload();
    const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
    const controller = new globalThis.AbortController();
    const targetStore =
      mode === 'publication'
        ? {
            beginTransaction(owner, scope) {
              const tx = store.beginTransaction(owner, scope);
              return {
                ...tx,
                commit(references) {
                  store.close();
                  return tx.commit(references);
                },
              };
            },
          }
        : store;
    const result = await prepareWorkBuddyTaskStateContext(body, options(targetStore), {
      historyBranch: history,
      signal: controller.signal,
      requestSummary: async (request) => {
        if (mode === 'cancelled') controller.abort();
        if (mode === 'closed') history.close();
        return completion(summary(request));
      },
    });
    assert.equal(result.fits, false, mode);
    assert.equal(result.changed, false, mode);
    assert.equal(result.diagnostics.historyTransactionStatus, 'rolled_back');
    assert.equal(
      result.diagnostics.taskStateStatus,
      {
        cancelled: 'cancelled',
        closed: 'stale_snapshot',
        publication: 'commit_rejected',
      }[mode]
    );
    assert.equal(result.diagnostics.taskStateRequirements, 0);
    assert.equal(result.diagnostics.finalBodyBytes, Buffer.byteLength(JSON.stringify(result.body)));
    assert.equal(JSON.stringify(result.body), JSON.stringify(body));
    assert.equal(store.stats().entries, 0);
    assert.equal(store.stats().retainedBytes, 0);
    assert.equal(history.stats().stagedEntries, 0);
    assert.equal(history.stats().version, 1);
    history.close();
    store.close();
  }
});

test('replacement immediately before async commit returns current unlossy history on conflict', async () => {
  const store = createContextArtifactStore(),
    body = workload();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
  let replacement = null;
  const targetStore = {
    beginTransaction(owner, scope) {
      const tx = store.beginTransaction(owner, scope);
      return {
        ...tx,
        stats() {
          if (!replacement) {
            replacement = { ...history.snapshot().body, model: 'model-changed-before-commit' };
            assert.equal(history.replace(replacement, history.stats().version).ok, true);
          }
          return tx.stats();
        },
      };
    },
  };
  const result = await prepareWorkBuddyTaskStateContext(body, options(targetStore), {
    historyBranch: history,
    requestSummary: async (request) => completion(summary(request)),
  });
  assert.ok(replacement);
  assert.equal(result.fits, false);
  assert.equal(result.body.model, replacement.model);
  assert.equal(JSON.stringify(result.body), JSON.stringify(history.snapshot().body));
  assert.equal(result.diagnostics.finalBodyBytes, Buffer.byteLength(JSON.stringify(result.body)));
  assert.equal(store.stats().entries, 0);
  assert.equal(store.stats().retainedBytes, 0);
  assert.equal(history.stats().stagedEntries, 0);
  history.close();
  store.close();
});

test('semantic summary is a dedicated operation and only admitted state commits final evidence', async () => {
  const store = createContextArtifactStore();
  const body = workload();
  const original = JSON.stringify(body);
  let calls = 0;
  const plan = await prepareWorkBuddyTaskStateContext(body, options(store), {
    requestSummary: async (request) => {
      calls += 1;
      assert.deepEqual(Object.keys(request).sort(), ['max_tokens', 'messages', 'model', 'stream']);
      assert.equal(
        store.stats().entries,
        0,
        'preflight evidence is not published during summarization'
      );
      return completion(summary(request));
    },
  });
  assert.equal(calls, 1);
  assert.equal(plan.fits, true);
  assert.equal(plan.diagnostics.taskStateStatus, 'applied');
  assert.equal(plan.diagnostics.taskStateRevokedRequirements, 1);
  assert.equal(plan.diagnostics.taskStateTaskCorrectness, 'not_verified');
  const state = plan.body.messages.find((entry) => entry.content?.startsWith?.(TASK_STATE_MARKER));
  assert.equal(state.role, 'assistant');
  assert.ok(state.content.includes('not_verified'));
  for (const entry of body.messages.filter((message) => ['system', 'user'].includes(message.role)))
    assert.ok(plan.body.messages.includes(entry), 'raw policy/user messages remain unchanged');
  assert.equal(JSON.stringify(body), original);
  assert.equal(plan.diagnostics.originalBodyBytes, Buffer.byteLength(original));
  assert.equal(plan.diagnostics.finalBodyBytes, Buffer.byteLength(JSON.stringify(plan.body)));
  const references = collectContextArtifactReferences(plan.body.messages, 'scope');
  assert.equal(store.stats().entries, references.length);
  for (const receipt of references)
    assert.equal(store.read('owner', 'scope', receipt.locator, receipt.digest).ok, true);
  assert.ok(!JSON.stringify(plan.diagnostics).includes('禁止重启'));
});

test('invalid, truncated, empty, tool-calling and failed summaries explicitly fall back, never silently execute tools', async () => {
  for (const response of [
    completion(''),
    completion('{}'),
    completion('null'),
    completion('{}', { finish_reason: 'length' }),
    completion('{}', {
      message: { role: 'assistant', content: '{}', tool_calls: [{ id: 'bad' }] },
    }),
    { ok: false, status: 502 },
    { ok: true, status: 500, body: '{}' },
  ]) {
    const store = createContextArtifactStore();
    const plan = await prepareWorkBuddyTaskStateContext(workload(), options(store), {
      requestSummary: async () => response,
    });
    assert.equal(plan.fits, true);
    assert.equal(plan.diagnostics.taskStateStatus, 'invalid_compaction_candidate');
    assert.equal(plan.diagnostics.taskStateSummaryAttempted, true);
    assert.ok(!plan.body.messages.some((entry) => entry.content?.startsWith?.(TASK_STATE_MARKER)));
  }
});

test('appends survive applied summaries and every non-applied fallback including successful over-budget summaries', async () => {
  for (const mode of ['applied', 'invalid', 'too_large']) {
    const store = createContextArtifactStore();
    const body = workload();
    const tail = { role: 'user', content: '新增约束必须保留原文。' };
    const plan = await prepareWorkBuddyTaskStateContext(body, options(store), {
      requestSummary: async (request) => {
        body.messages.push(tail);
        const state = summary(request);
        if (mode === 'invalid') return completion('{}');
        // Raw summary fits 32 KiB, but host-enriched provenance does not.
        if (mode === 'too_large')
          state.work = Array.from({ length: 32 }, () => ({
            text: 'x'.repeat(650),
            status: 'reported_complete',
            sources: Array(4).fill({ sourceId: 'm_4', quote: '测试完成仍未验证。' }),
          }));
        return completion(state);
      },
    });
    assert.equal(plan.fits, true, mode);
    assert.ok(plan.body.messages.includes(tail), mode);
    assert.equal(
      plan.diagnostics.taskStateStatus,
      mode === 'applied'
        ? 'applied'
        : mode === 'invalid'
          ? 'invalid_compaction_candidate'
          : 'state_too_large'
    );
  }
});

test('otherwise valid task state cannot hide malformed execution or refusal metadata behind falsey values', async () => {
  for (const metadata of [
    { function_call: false },
    { function_call: [] },
    { tool_calls: {} },
    { tool_calls: false },
    { refusal: '' },
  ]) {
    const store = createContextArtifactStore();
    try {
      const plan = await prepareWorkBuddyTaskStateContext(workload(), options(store), {
        requestSummary: async (request) =>
          completion(summary(request), {
            message: { role: 'assistant', content: JSON.stringify(summary(request)), ...metadata },
          }),
      });
      assert.equal(plan.fits, true);
      assert.equal(plan.diagnostics.taskStateStatus, 'invalid_compaction_candidate');
      assert.ok(
        !plan.body.messages.some((entry) => entry.content?.startsWith?.(TASK_STATE_MARKER))
      );
    } finally {
      store.close();
    }
  }
});

test('changed prefixes, cancellation, commit failures and programmer errors cannot publish partial state', async () => {
  for (const mode of ['stale', 'cancelled', 'commit', 'throw']) {
    const store = createContextArtifactStore();
    const body = workload();
    const controller = new globalThis.AbortController();
    const targetStore =
      mode !== 'commit'
        ? store
        : {
            beginTransaction(owner, scope) {
              const tx = store.beginTransaction(owner, scope);
              return {
                ...tx,
                commit: (references) => {
                  store.close();
                  return tx.commit(references);
                },
              };
            },
          };
    const run = prepareWorkBuddyTaskStateContext(body, options(targetStore), {
      signal: controller.signal,
      requestSummary: async (request) => {
        if (mode === 'throw') throw new Error('provider error');
        if (mode === 'stale') body.messages[1] = { role: 'user', content: 'changed' };
        if (mode === 'cancelled') controller.abort();
        return completion(summary(request));
      },
    });
    if (mode === 'throw') await assert.rejects(run, /provider error/);
    else {
      const plan = await run;
      assert.equal(plan.fits, false);
      assert.equal(plan.body, body);
      assert.equal(plan.changed, false);
      assert.equal(
        plan.diagnostics.taskStateStatus,
        { stale: 'stale_snapshot', cancelled: 'cancelled', commit: 'commit_rejected' }[mode]
      );
      assert.equal(plan.diagnostics.taskStateRequirements, 0);
      assert.equal(plan.diagnostics.finalBodyBytes, Buffer.byteLength(JSON.stringify(body)));
    }
    await tick();
    assert.equal(store.stats().entries, 0);
  }
});

test('valid state rejected by final request budget still replans concurrent appends', async () => {
  const body = workload();
  for (const message of body.messages)
    if (message.role === 'assistant' && typeof message.content === 'string')
      message.content = '测试完成仍未验证。' + 'x'.repeat(80);
  const tail = { role: 'user', content: '摘要期间追加的约束。' };
  const plan = await prepareWorkBuddyTaskStateContext(
    body,
    options(createContextArtifactStore(), { targetBodyBytes: 25000 }),
    {
      requestSummary: async (request) => {
        body.messages.push(tail);
        return completion(
          summary(request, {
            work: Array.from({ length: 30 }, () => ({
              text: 'x'.repeat(650),
              status: 'reported_complete',
              sources: [{ sourceId: 'm_4', quote: '测试完成仍未验证。' }],
            })),
          })
        );
      },
    }
  );
  assert.equal(plan.diagnostics.taskStateStatus, 'state_budget_rejected');
  assert.equal(plan.fits, true);
  assert.ok(plan.body.messages.includes(tail));
});

test('older plain conversation narration is summarized without dropping recent turns or raw user requests', async () => {
  const body = { model: 'fixture-model', messages: [{ role: 'system', content: '保留约束。' }] };
  for (let index = 0; index < 16; index += 1)
    body.messages.push(
      { role: 'user', content: `用户要求${index}。` },
      { role: 'assistant', content: `进展${index}。` + '历史报告。'.repeat(80) }
    );
  body.messages.push({ role: 'user', content: '继续。' });
  const plan = await prepareWorkBuddyTaskStateContext(
    body,
    options(null, { targetBodyBytes: 50000 }),
    {
      requestSummary: async () =>
        completion({
          schema: TASK_STATE_SCHEMA,
          version: 1,
          objectives: [
            { text: '保留用户要求', sources: [{ sourceId: 'm_1', quote: '用户要求0。' }] },
          ],
          requirements: [],
          work: [],
          decisions: [],
          blockers: [],
          nextSteps: [],
          files: [],
        }),
    }
  );
  assert.equal(plan.diagnostics.taskStateStatus, 'applied');
  assert.ok(!plan.body.messages.includes(body.messages[2]));
  assert.ok(
    plan.body.messages.includes(body.messages.at(-2)),
    'latest narration stays in the working set'
  );
  for (const message of body.messages.filter((entry) => ['system', 'user'].includes(entry.role)))
    assert.ok(plan.body.messages.includes(message));
});

test('plain narration inside an unfinished or ambiguous tool interval is not semantic archival input', async () => {
  for (const mode of ['unfinished', 'duplicate']) {
    const body = workload();
    body.messages.splice(2, 0, {
      role: 'assistant',
      tool_calls: [
        {
          id: mode === 'duplicate' ? 'call-0' : 'pending',
          type: 'function',
          function: { name: 'write', arguments: '{}' },
        },
      ],
    });
    let calls = 0;
    const plan = await prepareWorkBuddyTaskStateContext(body, options(null), {
      requestSummary: async () => {
        calls += 1;
        throw new Error('unsafe interval must not be summarized');
      },
    });
    assert.equal(calls, 0, mode);
    assert.equal(plan.diagnostics.taskStateSummaryAttempted, false);
  }
});

test('repeated semantic compaction retains previous checkpoint as quoted background with exact retry reuse', async () => {
  const coordinator = createContextCompactionCoordinator();
  const body = workload();
  let calls = 0;
  const runtime = {
    coordinator,
    compactionScope: 'conversation',
    requestSummary: async (request) => {
      calls += 1;
      return completion(summary(request));
    },
  };
  const first = await prepareWorkBuddyTaskStateContext(body, options(null), runtime);
  const retry = await prepareWorkBuddyTaskStateContext(body, options(null), runtime);
  assert.equal(first.diagnostics.taskStateStatus, 'applied');
  assert.equal(retry.diagnostics.taskStateSummaryReused, true);
  assert.equal(calls, 1);
  const next = { ...body, messages: first.body.messages.slice() };
  // Add completed rounds so the prior checkpoint moves into historical progress.
  for (let index = 20; index < 40; index += 1)
    next.messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: `call-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: `call-${index}`, content: 'evidence'.repeat(1000) },
      { role: 'assistant', content: 'later progress '.repeat(100) }
    );
  next.messages.push({ role: 'user', content: '继续，撤销禁止重启但其他约束不变。' });
  const second = await prepareWorkBuddyTaskStateContext(next, options(null), {
    requestSummary: async (request) => {
      const payload = JSON.parse(request.messages[1].content);
      const transcript = payload.transcript.map((entry) => ({
        ...entry,
        text: payload.citations
          .filter((citation) => citation.sourceId === entry.id)
          .map((citation) => citation.quote)
          .join(''),
      }));
      const prior = transcript.find((entry) => entry.text.startsWith(TASK_STATE_MARKER));
      assert.equal(prior.role, 'assistant');
      const user = transcript.find(
        (entry) => entry.role === 'user' && entry.text.includes('修复压缩')
      );
      assert.equal(payload.previous.requirements[0].status, 'revoked');
      const originalRevision = next.messages.findIndex(
        (entry) => entry.content === '撤销禁止重启，必要时可以重启。'
      );
      assert.equal(payload.previous.requirements[0].revision.sourceId, `m_${originalRevision}`);
      return completion({
        schema: TASK_STATE_SCHEMA,
        version: 1,
        objectives: [],
        requirements: [
          {
            id: 'r1',
            text: '禁止重启。',
            status: 'revoked',
            sources: [{ sourceId: user.id, quote: '禁止重启。' }],
            revision: payload.previous.requirements[0].revision,
          },
        ],
        decisions: [],
        work: [],
        blockers: [],
        nextSteps: [],
        files: [],
      });
    },
  });
  assert.equal(second.diagnostics.taskStateStatus, 'applied');
  assert.equal(second.diagnostics.taskStateCarriedRequirements, 1);
  assert.equal(
    second.body.messages.filter((entry) => entry.content?.startsWith?.(TASK_STATE_MARKER)).length,
    1,
    'successive compaction replaces old background state instead of accumulating checkpoints'
  );
  assert.ok(second.body.messages.includes(body.messages[1]));
  coordinator.close();
});

test('cross-cycle requirement loss is rejected and missing originals pin the genuine previous checkpoint', async () => {
  for (const mode of ['drop', 'missing_original']) {
    const body = workload();
    const first = await prepareWorkBuddyTaskStateContext(body, options(null), {
      requestSummary: async (request) => completion(summary(request)),
    });
    assert.equal(first.diagnostics.taskStateStatus, 'applied');
    const prior = first.body.messages.find((message) =>
      message.content?.startsWith(TASK_STATE_MARKER)
    );
    const next = {
      ...body,
      messages: first.body.messages.filter(
        (message) =>
          mode !== 'missing_original' || message.content !== '撤销禁止重启，必要时可以重启。'
      ),
    };
    for (let index = 20; index < 40; index++)
      next.messages.push(
        {
          role: 'assistant',
          tool_calls: [
            { id: `call-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: `call-${index}`, content: 'evidence'.repeat(1000) },
        { role: 'assistant', content: 'new progress '.repeat(100) }
      );
    next.messages.push({ role: 'user', content: 'Keep current input exact.' });
    const history = createContextHistoryBranch(next, { owner: 'owner', scope: 'scope' });
    let calls = 0;
    try {
      const result = await prepareWorkBuddyTaskStateContext(next, options(null), {
        historyBranch: history,
        requestSummary: async (request) => {
          calls++;
          const payload = JSON.parse(request.messages[1].content);
          assert.equal(Boolean(payload.previous?.requirements.length), mode === 'drop');
          const citation = payload.citations.find((entry) => entry.quote.includes('修复压缩'));
          return completion({
            schema: TASK_STATE_SCHEMA,
            version: 1,
            objectives: [{ text: 'Reported task', sources: [{ citationId: citation.citationId }] }],
            requirements: [],
            decisions: [],
            work: [],
            blockers: [],
            nextSteps: [],
            files: [],
          });
        },
      });
      assert.equal(calls, 1, 'no automatic retries or external tool replay');
      assert.ok(
        result.body.messages.some((message) => message.content === prior.content),
        'old exact constraints survive a rejected replacement or unavailable original'
      );
      if (mode === 'drop') {
        assert.equal(result.diagnostics.taskStateStatus, 'invalid_compaction_candidate');
        assert.equal(result.diagnostics.taskStateFailureReason, 'summary_requirement_loss');
        assert.equal(result.diagnostics.taskStateCarriedRequirements, 1);
      } else {
        assert.equal(result.diagnostics.taskStateStatus, 'applied');
        assert.equal(result.diagnostics.taskStatePinnedStates, 1);
        assert.equal(result.diagnostics.taskStateCarriedRequirements, 0);
        assert.ok(
          result.body.messages.some((message) => message.content === 'Keep current input exact.')
        );
        assert.equal(result.diagnostics.historyTransactionStatus, 'committed');
      }
    } finally {
      history.close();
    }
  }
});

test('empty, invalid, disabled and unavailable sources do not dispatch independent model work', async () => {
  let calls = 0;
  const runtime = {
    requestSummary: async () => {
      calls += 1;
      throw new Error('unexpected');
    },
  };
  assert.equal((await prepareWorkBuddyTaskStateContext(null, null, null)).fits, false);
  assert.equal(
    (await prepareWorkBuddyTaskStateContext({ messages: [] }, null, runtime)).fits,
    true
  );
  const body = applyResponsesHistoryPolicy(workload(), { truncation: 'disabled' });
  await prepareWorkBuddyTaskStateContext(body, options(null), runtime);
  assert.equal(calls, 0);
  const noSummarizer = await prepareWorkBuddyTaskStateContext(workload(), options(null));
  assert.equal(noSummarizer.diagnostics.taskStateStatus, 'summarizer_unavailable');
  const huge = workload();
  huge.messages[0].content = 'p'.repeat(200000);
  const unavailable = await prepareWorkBuddyTaskStateContext(huge, options(null), runtime);
  assert.equal(unavailable.diagnostics.taskStateStatus, 'source_unavailable');
  assert.equal(calls, 0);
  assert.equal(
    stateFromCompletion(
      { ok: true, status: 200, body: '{}' },
      createTaskStateSource(workload().messages)
    ).ok,
    false
  );
});

test('tool-loop turns reuse committed frontier across short evicted narration and back off repeated upstream failures until a new user turn', async () => {
  const checkpoints = createContextSummaryCheckpoints();
  const backoff = createContextCompactionBackoff({ now: () => 1000, cooldownMs: 30000 });
  const coordinator = createContextCompactionCoordinator();
  const store = createContextArtifactStore();
  const binding = {
    owner: 'owner',
    provider: 'workbuddy-wbipc',
    model: 'fixture-model',
    endpoint: 'https://host/v2',
  };
  try {
    const body = workload();
    const initialHistory = createContextHistoryBranch(body, { owner: 'owner', scope: 'turn-0' });
    let initialCalls = 0;
    try {
      const first = await prepareWorkBuddyTaskStateContext(
        body,
        options(store, { artifactScope: 'turn-0' }),
        {
          historyBranch: initialHistory,
          coordinator,
          compactionScope: 'turn-0',
          summaryCheckpoints: checkpoints,
          compactionRetryBinding: binding,
          failureBackoff: backoff,
          requestSummary: async (request) => {
            initialCalls += 1;
            return completion(summary(request));
          },
        }
      );
      assert.equal(initialCalls, 1);
      assert.equal(first.diagnostics.taskStateStatus, 'applied');
      assert.equal(first.diagnostics.taskStateCheckpointCommitted, true);
    } finally {
      initialHistory.close();
    }

    // Append a short assistant narration (< 1024 chars) plus 9 completed tool rounds
    // so the short narration slides out of the 8-round window into historicalProgress.
    const shortNarration = '简短中间旁白：先检查文件结构。';
    body.messages.push({ role: 'assistant', content: shortNarration });
    for (let round = 0; round < 9; round += 1) {
      body.messages.push(
        {
          role: 'assistant',
          tool_calls: [
            {
              id: `tail-call-${round}`,
              type: 'function',
              function: { name: 'read', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: `tail-call-${round}`, content: '证据🙂'.repeat(800) }
      );
    }
    const shortTailHistory = createContextHistoryBranch(body, { owner: 'owner', scope: 'turn-1' });
    try {
      const reused = await prepareWorkBuddyTaskStateContext(
        body,
        options(store, { artifactScope: 'turn-1' }),
        {
          historyBranch: shortTailHistory,
          coordinator,
          compactionScope: 'turn-1',
          summaryCheckpoints: checkpoints,
          compactionRetryBinding: binding,
          failureBackoff: backoff,
          requestSummary: async () => {
            throw new Error('short post-frontier assistant narration must not trigger a summary request');
          },
        }
      );
      assert.equal(reused.diagnostics.taskStateStatus, 'applied');
      assert.equal(reused.diagnostics.taskStateFrontierReused, true);
      assert.equal(reused.diagnostics.taskStateSummaryAttempted, false);
      assert.equal(reused.diagnostics.compactionTiming.summaryRequests, 0);
      assert.ok(
        reused.body.messages.some((message) => message.content === shortNarration),
        'deferred post-frontier narration remains in the working set until summarized'
      );
    } finally {
      shortTailHistory.close();
    }

    // Once >= 1024 chars of post-frontier assistant narration accumulates and upstream fails,
    // subsequent tool-loop turns back off without repeating the failing summary request.
    body.messages.splice(
      body.messages.findIndex((message) => message.content === shortNarration),
      1,
      { role: 'assistant', content: '长段进展旁白：'.repeat(200) }
    );
    let failingCalls = 0;
    for (const [turnIndex, scope] of ['fail-turn-1', 'fail-turn-2'].entries()) {
      if (turnIndex > 0) {
        body.messages.push(
          {
            role: 'assistant',
            tool_calls: [
              { id: 'extra-tool', type: 'function', function: { name: 'read', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'extra-tool', content: '证据🙂'.repeat(800) }
        );
      }
      const turnHistory = createContextHistoryBranch(body, { owner: 'owner', scope });
      try {
        const result = await prepareWorkBuddyTaskStateContext(
          body,
          options(store, { artifactScope: scope }),
          {
            historyBranch: turnHistory,
            coordinator,
            compactionScope: scope,
            summaryCheckpoints: checkpoints,
            compactionRetryBinding: binding,
            failureBackoff: backoff,
            requestSummary: async () => {
              failingCalls += 1;
              return { ok: false, status: 502, body: 'upstream failure' };
            },
          }
        );
        assert.equal(result.diagnostics.taskStateStatus, 'invalid_compaction_candidate');
        assert.equal(result.diagnostics.taskStateFailureReason, 'summary_upstream_failure');
        assert.equal(result.diagnostics.taskStateBackoffApplied, turnIndex > 0);
        assert.equal(result.diagnostics.compactionTiming.summaryRequests, turnIndex === 0 ? 1 : 0);
      } finally {
        turnHistory.close();
      }
    }
    assert.equal(failingCalls, 1);
  } finally {
    checkpoints.close();
    coordinator.close();
    store.close();
  }
});
