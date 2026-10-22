'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TASK_STATE_SCHEMA,
  MAX_TASK_STATE_BYTES,
  createTaskStateSource,
  selectTaskStateSource,
  parseTaskStateSummary,
} = require('../lib/proxy/context-task-state');
const {
  planWorkBuddyTaskStateSummary,
  runWorkBuddyTaskStateSummary,
  parseWorkBuddyTaskStateSummary,
  stateFromCompletion,
  produceWorkBuddyTaskStateSummary,
} = require('../lib/proxy/workbuddy-task-state-summary');
const {
  createCompactionTiming,
  snapshotCompactionTiming,
} = require('../lib/proxy/context-compaction-timing');
const { createContextSummaryCheckpoints } = require('../lib/proxy/context-summary-checkpoints');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { compactionFailureReason } = require('../lib/proxy/context-compaction-failure');

const settings = { maxBytes: 274421, maxTokens: 98304 };
function workload(count = 2200) {
  const messages = [
    { role: 'system', content: 'fixed immutable policy '.repeat(11000) },
    { role: 'user', content: 'Do not restart.' },
  ];
  const progress = [];
  for (let index = 0; index < count; index++) {
    messages.push({ role: 'tool', content: 'private-tool-evidence' });
    const narration = {
      role: 'assistant',
      content: `Progress ${index}. ` + 'unverified work. '.repeat(15),
    };
    progress.push(narration);
    messages.push(narration);
  }
  messages.push({ role: 'user', content: 'Restart allowed.' });
  return { body: { model: 'fixture-model', messages }, progress };
}
function completion(state) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(state) } },
      ],
    }),
  };
}
function fixtureState(request) {
  const payload = JSON.parse(request.messages[1].content);
  const state = payload.previous ?? {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements: [],
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
  const first = payload.citations.find((entry) => entry.quote === 'Do not restart.');
  if (first)
    state.requirements = [
      {
        id: 'restart',
        status: 'active',
        text: first.quote,
        sources: [{ sourceId: first.sourceId, quote: first.quote }],
      },
    ];
  const revision = payload.citations.find((entry) => entry.quote === 'Restart allowed.');
  if (revision) {
    state.requirements[0].status = 'revoked';
    state.requirements[0].revision = { sourceId: revision.sourceId, quote: revision.quote };
  }
  const progress = payload.citations.findLast((entry) => entry.quote.startsWith('Progress '));
  if (progress)
    state.work = [
      {
        text: 'Reported progress only',
        status: 'unverified',
        sources: [{ sourceId: progress.sourceId, quote: progress.quote }],
      },
    ];
  return state;
}

function checkpointOperation(store, body, scope) {
  const history = createContextHistoryBranch(body, { owner: 'fixture', scope });
  const operation = store.begin({
    history,
    snapshot: history.snapshot(),
    binding: { owner: 'fixture', provider: 'workbuddy-wbipc', model: body.model, endpoint: '/v2' },
  });
  return { history, operation };
}

test('semantic frontier survives one-to-many repartitioning and summarizes only suffix constraints and revisions', async (t) => {
  const first = workload(240);
  first.body.messages.pop();
  const frontierIndex = first.body.messages.length - 1;
  const initialPlan = planWorkBuddyTaskStateSummary(first.body, first.progress, settings);
  assert.equal(initialPlan.chunkCount, 1);
  const store = createContextSummaryCheckpoints();
  const initial = checkpointOperation(store, first.body, 'initial');
  try {
    let initialCalls = 0;
    const initialText = await produceWorkBuddyTaskStateSummary(
      initialPlan,
      async (request) => {
        initialCalls++;
        return completion(fixtureState(request));
      },
      new globalThis.AbortController().signal,
      undefined,
      initial.operation
    );
    assert.ok(initialText);
    assert.equal(initialCalls, 1);
    initial.operation.commit();

    const tail = workload(900);
    const body = {
      ...first.body,
      messages: [
        ...first.body.messages,
        ...tail.body.messages.slice(2),
        { role: 'user', content: 'NEW: preserve backups.' },
      ],
    };
    const plan = planWorkBuddyTaskStateSummary(
      body,
      [...first.progress, ...tail.progress],
      settings
    );
    assert.ok(plan.chunkCount > 1);
    const second = checkpointOperation(store, body, 'repartitioned');
    const timing = createCompactionTiming();
    const seen = [];
    try {
      const text = await produceWorkBuddyTaskStateSummary(
        plan,
        async (request) => {
          const payload = JSON.parse(request.messages[1].content);
          seen.push(...payload.transcript.map((entry) => entry.index));
          assert.ok(payload.transcript.every((entry) => entry.index > frontierIndex));
          assert.equal(payload.previous.requirements[0].text, 'Do not restart.');
          const state = fixtureState(request);
          const added = payload.citations.find((entry) => entry.quote === 'NEW: preserve backups.');
          if (added)
            state.requirements.push({
              id: 'new',
              status: 'active',
              text: added.quote,
              sources: [{ sourceId: added.sourceId, quote: added.quote }],
            });
          return completion(state);
        },
        new globalThis.AbortController().signal,
        timing,
        second.operation
      );
      const result = parseWorkBuddyTaskStateSummary(text, plan);
      assert.equal(result.state.requirements[0].status, 'revoked');
      assert.equal(result.state.requirements[0].revision.quote, 'Restart allowed.');
      assert.equal(result.state.requirements[1].text, 'NEW: preserve backups.');
      assert.equal(result.state.requirements[0].sources[0].sourceIndex, 1);
      assert.equal(result.state.work[0].verification, 'not_verified');
      assert.equal(second.operation.stats().frontierSourceMessages, frontierIndex + 1);
      assert.equal(second.operation.stats().frontierReused, true);
      assert.equal(new Set(seen).size, tail.progress.length + 2);
      assert.equal(snapshotCompactionTiming(timing).summaryRequests, plan.chunkCount);
      assert.equal(second.operation.commit(), true);

      const reconnect = checkpointOperation(store, body, 'third-scope');
      try {
        const resumed = await produceWorkBuddyTaskStateSummary(
          plan,
          async () => {
            assert.fail('Fully covered reconnect must not dispatch a model or an external tool');
          },
          new globalThis.AbortController().signal,
          undefined,
          reconnect.operation
        );
        assert.deepEqual(parseWorkBuddyTaskStateSummary(resumed, plan).state, result.state);
        assert.equal(reconnect.operation.stats().frontierSourceMessages, body.messages.length);
      } finally {
        reconnect.operation.rollback();
        reconnect.history.close();
      }
      t.diagnostic(
        JSON.stringify({
          initialChunks: initialPlan.chunkCount,
          changedChunks: plan.chunkCount,
          resumedSourceMessages: frontierIndex + 1,
          newlyProcessedTextEntries: seen.length,
        })
      );
    } finally {
      second.operation.rollback();
      second.history.close();
    }
  } finally {
    initial.operation.rollback();
    initial.history.close();
    store.close();
  }
});

test('frontier semantic text is revalidated against fresh sources and cannot cite a future revision', async () => {
  const body = {
    model: 'fixture',
    messages: [
      { role: 'user', content: 'Do not restart.' },
      { role: 'user', content: 'Restart allowed.' },
    ],
  };
  const plan = planWorkBuddyTaskStateSummary(body, [], settings);
  const valid = {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements: [
      {
        id: 'r',
        status: 'active',
        text: 'Do not restart.',
        sources: [{ sourceId: 'm_0', quote: 'Do not restart.' }],
      },
    ],
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
  const future = globalThis.structuredClone(valid);
  future.requirements[0].status = 'revoked';
  future.requirements[0].revision = { sourceId: 'm_1', quote: 'Restart allowed.' };
  const mismatch = globalThis.structuredClone(valid);
  mismatch.requirements[0].sources[0].quote = 'SECRET';
  for (const [seed, reason] of [
    [{ sourceIndex: 0, text: 'SECRET invalid JSON' }, 'summary_json_invalid'],
    [{ sourceIndex: 0, text: JSON.stringify(future) }, 'summary_reference_invalid'],
    [{ sourceIndex: 1, text: JSON.stringify(mismatch) }, 'summary_reference_invalid'],
    [{ sourceIndex: 2, text: JSON.stringify(valid) }, 'summary_source_invalid'],
    [{ sourceIndex: 0, text: 'x'.repeat(MAX_TASK_STATE_BYTES + 1) }, 'summary_source_invalid'],
  ]) {
    let requests = 0;
    await assert.rejects(
      produceWorkBuddyTaskStateSummary(
        plan,
        async () => {
          requests++;
        },
        new globalThis.AbortController().signal,
        createCompactionTiming(),
        { prepareFrontier: () => seed }
      ),
      (error) => {
        assert.equal(compactionFailureReason(error), reason);
        assert.ok(!error.message.includes('SECRET'));
        return true;
      }
    );
    assert.equal(requests, 0);
  }
});

test('reused frontier still rejects a suffix summary that loses a retained requirement', async () => {
  const body = {
    model: 'fixture',
    messages: [
      { role: 'user', content: 'Do not restart.' },
      { role: 'user', content: 'New constraint.' },
    ],
  };
  const plan = planWorkBuddyTaskStateSummary(body, [], settings);
  const previous = {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements: [
      {
        id: 'r',
        status: 'active',
        text: 'Do not restart.',
        sources: [{ sourceId: 'm_0', quote: 'Do not restart.' }],
      },
    ],
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
  let calls = 0;
  await assert.rejects(
    produceWorkBuddyTaskStateSummary(
      plan,
      async () => {
        calls++;
        return completion({
          ...previous,
          requirements: [],
          objectives: [
            { text: 'New goal', sources: [{ sourceId: 'm_1', quote: 'New constraint.' }] },
          ],
        });
      },
      new globalThis.AbortController().signal,
      undefined,
      {
        prepareFrontier: () => ({ sourceIndex: 0, text: JSON.stringify(previous) }),
        key: () => ({}),
        read: () => null,
        stage() {
          assert.fail('Lossy summaries cannot be staged');
        },
      }
    ),
    (error) => compactionFailureReason(error) === 'summary_requirement_loss'
  );
  assert.equal(calls, 1);
});

test('changing archival selection invalidates semantic frontier even with identical originals', async () => {
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'Do not restart.' }] };
  const store = createContextSummaryCheckpoints();
  try {
    for (const [index, archiveSourceIndices] of [[], [0]].entries()) {
      const current = checkpointOperation(store, body, `scope-${index}`);
      try {
        let calls = 0;
        const plan = planWorkBuddyTaskStateSummary(body, [], { ...settings, archiveSourceIndices });
        await produceWorkBuddyTaskStateSummary(
          plan,
          async (request) => {
            calls++;
            return completion(fixtureState(request));
          },
          new globalThis.AbortController().signal,
          undefined,
          current.operation
        );
        assert.equal(calls, 1, 'archive eligibility changes require fresh summarization');
        assert.equal(current.operation.stats().frontierReused, false);
        current.operation.commit();
      } finally {
        current.operation.rollback();
        current.history.close();
      }
    }
  } finally {
    store.close();
  }
});

test('summary progress pinpoints a later failed chunk without changing rollback or retry behavior', async () => {
  const { body, progress } = workload();
  const original = JSON.stringify(body);
  const plan = planWorkBuddyTaskStateSummary(body, progress, settings);
  assert.ok(plan.chunkCount > 1);
  for (const mode of ['invalid', 'throw', 'cancel']) {
    const timing = createCompactionTiming();
    const controller = new globalThis.AbortController();
    const failure = new Error('SECRET provider error');
    let calls = 0;
    const pending = produceWorkBuddyTaskStateSummary(
      plan,
      async (request) => {
        calls++;
        const active = snapshotCompactionTiming(timing);
        assert.equal(active.summaryLastChunk, calls);
        assert.equal(active.summaryLastStage, 'request');
        assert.equal(active.summaryPendingRequests, 1);
        if (calls === 2) {
          if (mode === 'throw') throw failure;
          if (mode === 'cancel') controller.abort();
          if (mode === 'invalid') return completion({ schema: 'SECRET' });
        }
        return completion(fixtureState(request));
      },
      controller.signal,
      timing
    );
    if (mode === 'cancel') assert.equal(await pending, null);
    else
      await assert.rejects(pending, (error) =>
        mode === 'throw' ? error === failure : error instanceof TypeError
      );
    const snapshot = snapshotCompactionTiming(timing);
    assert.equal(calls, 2);
    assert.equal(snapshot.summaryLastChunk, 2);
    assert.equal(snapshot.summaryLastStage, mode === 'invalid' ? 'validation' : 'request');
    assert.equal(snapshot.summaryLastChunkReused, false);
    assert.equal(snapshot.summaryPendingRequests, 0);
    assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
    assert.equal(JSON.stringify(body), original);
  }
});

test('cache-only summary validation reports the chunk rather than inventing a provider request', async () => {
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'Do not restart.' }] };
  const plan = planWorkBuddyTaskStateSummary(body, [], settings);
  const timing = createCompactionTiming();
  await assert.rejects(
    produceWorkBuddyTaskStateSummary(
      plan,
      async () => {
        throw new Error('No provider request expected');
      },
      new globalThis.AbortController().signal,
      timing,
      { key: () => ({}), read: () => 'SECRET invalid cached text' }
    ),
    TypeError
  );
  const snapshot = snapshotCompactionTiming(timing);
  assert.equal(snapshot.summaryLastChunk, 1);
  assert.equal(snapshot.summaryLastStage, 'validation');
  assert.equal(snapshot.summaryLastChunkReused, true);
  assert.equal(snapshot.summaryRequests, 0);
});

test('completed cached summaries and pre-dispatch cancellation have distinct progress', async () => {
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'Do not restart.' }] };
  const plan = planWorkBuddyTaskStateSummary(body, [], settings);
  const timing = createCompactionTiming();
  const text = JSON.stringify({
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements: [{ id: 'r', status: 'active', sources: [{ citationId: 'm_0.c_0' }] }],
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  });
  const request = async () => {
    throw new Error('No provider request expected');
  };
  assert.equal(
    await produceWorkBuddyTaskStateSummary(
      plan,
      request,
      new globalThis.AbortController().signal,
      timing,
      { key: () => ({}), read: () => text }
    ),
    text
  );
  const snapshot = snapshotCompactionTiming(timing);
  assert.equal(snapshot.summaryLastChunk, 1);
  assert.equal(snapshot.summaryLastStage, 'completed');
  assert.equal(snapshot.summaryLastChunkReused, true);
  assert.equal(snapshot.summaryRequests, 0);
  const cancelled = createCompactionTiming();
  const controller = new globalThis.AbortController();
  controller.abort();
  assert.equal(
    await produceWorkBuddyTaskStateSummary(plan, request, controller.signal, cancelled),
    null
  );
  assert.equal(snapshotCompactionTiming(cancelled).summaryLastChunk, undefined);
});

test('coordinator timeout exposes an in-flight chunk, not a completed validation or tool replay', async () => {
  const {
    createContextCompactionCoordinator,
  } = require('../lib/proxy/context-compaction-coordinator');
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'Do not restart.' }] };
  const plan = planWorkBuddyTaskStateSummary(body, [], settings);
  const timing = createCompactionTiming();
  const coordinator = createContextCompactionCoordinator({ deadlineMs: 10 });
  let release;
  let pending;
  let calls = 0;
  try {
    const result = await coordinator.run({
      owner: 'fixture',
      scope: 'timeout',
      operationId: plan.digest,
      snapshotDigest: plan.digest,
      produce: (signal) => {
        pending = produceWorkBuddyTaskStateSummary(
          plan,
          async () => {
            calls++;
            return new Promise((resolve) => {
              release = resolve;
            });
          },
          signal,
          timing
        );
        return pending;
      },
      validate: () => true,
    });
    assert.equal(result.reason, 'compaction_timeout');
    const snapshot = snapshotCompactionTiming(timing);
    assert.equal(snapshot.summaryLastChunk, 1);
    assert.equal(snapshot.summaryLastStage, 'request');
    assert.equal(snapshot.summaryPendingRequests, 1);
    assert.equal(calls, 1);
  } finally {
    release?.({ ok: false, status: 'cancelled' });
    await pending;
    coordinator.close();
  }
  assert.equal(snapshotCompactionTiming(timing).summaryPendingRequests, 0);
  assert.equal(snapshotCompactionTiming(timing).summaryLastStage, 'request');
});

test('checkpoint text is freshly source-validated and cannot bypass summary parsing or dispatch tools', async () => {
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'Do not restart.' }] };
  const plan = planWorkBuddyTaskStateSummary(body, [], settings);
  for (const value of [
    'SECRET',
    '{"schema":"SECRET"}',
    JSON.stringify({
      schema: TASK_STATE_SCHEMA,
      version: 1,
      objectives: [],
      requirements: [
        { id: 'r', status: 'active', sources: [{ sourceId: 'm_999', quote: 'SECRET' }] },
      ],
      decisions: [],
      work: [],
      blockers: [],
      nextSteps: [],
      files: [],
    }),
  ]) {
    let requests = 0;
    await assert.rejects(
      produceWorkBuddyTaskStateSummary(
        plan,
        async () => {
          requests++;
          throw new Error('No model request expected');
        },
        new globalThis.AbortController().signal,
        undefined,
        {
          key: () => ({}),
          read: () => value,
          stage() {
            throw new Error('Invalid text cannot be staged');
          },
        }
      ),
      (error) => error instanceof TypeError && !error.message.includes('SECRET')
    );
    assert.equal(requests, 0);
  }
});

test('summary rejection diagnostics distinguish envelope, terminal, schema, provenance and constraint failures without content', () => {
  const source = createTaskStateSource([{ role: 'user', content: 'Do not restart.' }]);
  const valid = {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements: [{ id: 'r', status: 'active', sources: [{ citationId: 'm_0.c_0' }] }],
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
  const change = (mutate) => {
    const value = globalThis.structuredClone(valid);
    mutate(value);
    return completion(value);
  };
  const envelope = (message, finish_reason = 'stop') => ({
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [{ finish_reason, message: { role: 'assistant', ...message } }],
    }),
  });
  const cases = [
    [{ ok: false, status: 502, body: 'SECRET' }, 'summary_upstream_failure'],
    [{ ok: true, status: 200, body: 'SECRET' }, 'summary_completion_invalid'],
    [envelope({ content: '' }), 'summary_completion_invalid'],
    [envelope({ content: 'SECRET' }, 'length'), 'summary_incomplete'],
    [envelope({ content: 'SECRET', function_call: {} }), 'summary_tool_or_refusal'],
    [envelope({ content: 'SECRET', refusal: '' }), 'summary_tool_or_refusal'],
    [envelope({ content: 'SECRET' }), 'summary_json_invalid'],
    [completion({ schema: 'SECRET' }), 'summary_schema_invalid'],
    [
      change((value) => {
        value.objectives = ['SECRET'];
      }),
      'summary_entry_invalid',
    ],
    [
      change((value) => {
        value.requirements[0].sources = [{ citationId: 'm_999.c_0' }];
      }),
      'summary_reference_invalid',
    ],
    [
      change((value) => {
        value.requirements[0].text = 'SECRET';
      }),
      'summary_exact_quote_mismatch',
    ],
    [
      change((value) => {
        value.requirements[0].revision = { citationId: 'm_0.c_0' };
      }),
      'summary_revision_invalid',
    ],
    [envelope({ content: 'x'.repeat(MAX_TASK_STATE_BYTES + 1) }), 'summary_size_limit'],
  ];
  assert.equal(stateFromCompletion(completion(valid), source).ok, true);
  for (const [response, reason] of cases) {
    const result = stateFromCompletion(response, source);
    assert.deepEqual(result, { ok: false, reason });
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('bounded incremental summary covers over 2048 textual entries with stable original positions and revocations', async () => {
  const { body, progress } = workload();
  const original = JSON.stringify(body);
  const archiveSourceIndices = [1, body.messages.length - 1];
  const plan = planWorkBuddyTaskStateSummary(body, progress, { ...settings, archiveSourceIndices });
  assert.ok(plan.chunkCount > 1 && plan.chunkCount <= 16);
  const seen = [];
  let requests = 0;
  const text = await runWorkBuddyTaskStateSummary(
    plan,
    async (request, { signal }) => {
      requests++;
      assert.equal(signal.aborted, false);
      assert.ok(Buffer.byteLength(JSON.stringify(request)) <= settings.maxBytes);
      assert.deepEqual(Object.keys(request).sort(), ['max_tokens', 'messages', 'model', 'stream']);
      assert.equal(request.stream, true);
      const payload = JSON.parse(request.messages[1].content);
      const archivalDirective = request.messages[0].content.match(
        /Historical user messages selected for recoverable archival: ([^.]+)\./
      );
      const selected = payload.transcript.filter((entry) =>
        archiveSourceIndices.includes(entry.index)
      );
      assert.deepEqual(
        archivalDirective ? archivalDirective[1].split(', ') : [],
        selected.map((entry) => entry.id),
        'a chunk cannot request citations to unavailable future sources'
      );
      assert.ok(!JSON.stringify(payload).includes('fixed immutable policy'));
      assert.ok(!JSON.stringify(payload).includes('private-tool-evidence'));
      seen.push(...payload.transcript.map((entry) => entry.index));
      return completion(fixtureState(request));
    },
    new globalThis.AbortController().signal
  );
  assert.equal(requests, plan.chunkCount);
  assert.equal(new Set(seen).size, progress.length + 2);
  assert.ok(seen.at(-1) > 2048);
  const result = parseWorkBuddyTaskStateSummary(text, plan);
  assert.equal(result.state.requirements[0].status, 'revoked');
  assert.equal(result.state.requirements[0].sources[0].sourceIndex, 1);
  assert.equal(result.state.requirements[0].revision.sourceIndex, body.messages.length - 1);
  assert.equal(result.state.work[0].verification, 'not_verified');
  assert.equal(JSON.stringify(body), original);
  assert.ok(Buffer.byteLength(text) <= MAX_TASK_STATE_BYTES);
});

test('invalid summaries, forgotten requirements, inaccessible references and cancellation stop without retries', async () => {
  for (const mode of ['invalid', 'forgotten', 'future', 'revision_order', 'cancelled', 'http']) {
    const { body, progress } = workload();
    const plan = planWorkBuddyTaskStateSummary(body, progress, settings);
    const controller = new globalThis.AbortController();
    let calls = 0;
    const result = await runWorkBuddyTaskStateSummary(
      plan,
      async (request) => {
        calls++;
        const state = fixtureState(request);
        if (mode === 'invalid') return completion({ bogus: true });
        if (mode === 'http') return { ok: false, status: 500, body: 'private error' };
        if (mode === 'future') state.requirements[0].sources[0].sourceId = 'm_999999';
        if (mode === 'cancelled') controller.abort();
        if (calls > 1 && mode === 'forgotten') state.requirements = [];
        if (calls > 1 && mode === 'revision_order') {
          state.requirements[0].status = 'revoked';
          state.requirements[0].revision = { sourceId: 'm_1', quote: 'Do not restart.' };
        }
        return completion(state);
      },
      controller.signal
    );
    assert.equal(result, null, mode);
    assert.ok(calls <= 2, mode);
  }
});

test('oversized indivisible input, total source overflow and invalid budgets dispatch no summary plan', () => {
  const { body, progress } = workload(2);
  progress[0].content = 'x'.repeat(200000);
  assert.equal(planWorkBuddyTaskStateSummary(body, progress, settings), null);
  const oversized = workload(9000);
  assert.equal(planWorkBuddyTaskStateSummary(oversized.body, oversized.progress, settings), null);
  for (const budget of [0, -1, NaN, Infinity, '274421', {}, null])
    assert.equal(
      planWorkBuddyTaskStateSummary(body, progress, { maxBytes: budget, maxTokens: 98304 }),
      null
    );
  assert.equal(planWorkBuddyTaskStateSummary(null, null, null), null);
  assert.equal(planWorkBuddyTaskStateSummary({ messages: [] }, [], settings), null);
  const chunkLimited = workload();
  assert.equal(
    planWorkBuddyTaskStateSummary(chunkLimited.body, chunkLimited.progress, {
      ...settings,
      maxBytes: 80000,
    }),
    null,
    'all chunks must be admitted within the 16-request bound'
  );
});

test('revoked carry requirements cannot be reactivated or lose the original revision', async () => {
  for (const mode of ['reactivate', 'replace_revision']) {
    const { body, progress } = workload();
    body.messages.splice(2, 0, { role: 'user', content: 'Restart allowed.' });
    const plan = planWorkBuddyTaskStateSummary(body, progress, settings);
    let calls = 0;
    const result = await runWorkBuddyTaskStateSummary(
      plan,
      async (request) => {
        calls++;
        const state = fixtureState(request);
        if (calls > 1) {
          if (mode === 'reactivate') {
            state.requirements[0].status = 'active';
            delete state.requirements[0].revision;
          } else state.requirements[0].revision.quote = 'Restart';
        }
        return completion(state);
      },
      new globalThis.AbortController().signal
    );
    assert.equal(result, null, mode);
    assert.equal(calls, 2);
  }
});

test('source selection preserves capability identity and cannot invent source roles or trigger accessors', () => {
  const source = createTaskStateSource([{ role: 'user', content: 'Do not restart.' }], {
    sourceIndices: [4400],
  });
  const selected = selectTaskStateSource([source], ['m_4400']);
  assert.equal(selected.transcript[0].index, 4400);
  assert.equal(selected.transcript[0].role, 'user');
  for (const ids of [[], ['m_99999'], ['m_01'], ['m_-1'], [null], ['m_4400', 'm_99999']])
    assert.throws(() => selectTaskStateSource([source], ids));
  assert.throws(() => selectTaskStateSource([{ ...source }], ['m_4400']));
  let hooks = 0;
  const sources = [];
  Object.defineProperty(sources, '0', {
    get() {
      hooks++;
      return source;
    },
  });
  assert.throws(() => selectTaskStateSource(sources, ['m_4400']));
  assert.equal(hooks, 0);
  const candidate = {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements: [
      {
        id: 'r',
        status: 'active',
        text: 'Do not restart.',
        sources: [{ sourceId: 'm_4400', quote: 'Do not restart.' }],
      },
    ],
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
  assert.equal(
    parseTaskStateSummary(JSON.stringify(candidate), selected).requirements[0].text,
    'Do not restart.'
  );
});

test('capability plans reject lookalikes and malformed cached values; producer errors remain visible', async () => {
  const { body, progress } = workload();
  const plan = planWorkBuddyTaskStateSummary(body, progress, settings);
  for (const value of [
    '{',
    'null',
    '{}',
    JSON.stringify({ requirements: [{ sources: [{ citationId: {} }] }] }),
  ])
    assert.throws(() => parseWorkBuddyTaskStateSummary(value, plan), {
      code: 'invalid_task_state',
    });
  assert.throws(() => parseWorkBuddyTaskStateSummary('{}', { ...plan }), {
    code: 'invalid_task_state',
  });
  const failure = new Error('original provider failure');
  await assert.rejects(
    runWorkBuddyTaskStateSummary(
      plan,
      async () => {
        throw failure;
      },
      new globalThis.AbortController().signal
    ),
    (error) => error === failure
  );
  await assert.rejects(
    runWorkBuddyTaskStateSummary(
      plan,
      async () => {
        throw failure;
      },
      null
    ),
    { code: 'invalid_task_state' }
  );
});
