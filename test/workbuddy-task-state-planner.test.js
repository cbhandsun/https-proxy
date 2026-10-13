'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { collectContextArtifactReferences } = require('../lib/proxy/context-artifact-references');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
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
      const revision = transcript.findLast((entry) => entry.role === 'user');
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
            revision: { sourceId: revision.id, quote: '撤销禁止重启' },
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
  assert.equal(
    second.body.messages.filter((entry) => entry.content?.startsWith?.(TASK_STATE_MARKER)).length,
    1,
    'successive compaction replaces old background state instead of accumulating checkpoints'
  );
  assert.ok(second.body.messages.includes(body.messages[1]));
  coordinator.close();
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
