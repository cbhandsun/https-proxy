'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const {
  createWorkBuddyContextPreparation,
  createBackgroundOperation,
} = require('../lib/proxy/workbuddy-context-preparation');
const { applyResponsesHistoryPolicy } = require('../lib/proxy/responses-history-policy');
const {
  TASK_STATE_SCHEMA,
  TASK_STATE_DIRECTIVE,
  TASK_STATE_INTERNED_DIRECTIVE,
} = require('../lib/proxy/context-task-state');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');

function workload() {
  const messages = [
    { role: 'system', content: 'Never leak credentials.' },
    { role: 'user', content: 'Preserve constraints and unverified work.' },
  ];
  for (let i = 0; i < 20; i++)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: 'old-' + i, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'old-' + i, content: 'evidence '.repeat(1500) },
      { role: 'assistant', content: 'Unverified historical progress. '.repeat(100) }
    );
  return { model: 'fixture', messages };
}
function completion(content) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content:
              content ??
              JSON.stringify({
                schema: TASK_STATE_SCHEMA,
                version: 1,
                objectives: [
                  {
                    text: 'Preserve constraints',
                    sources: [{ sourceId: 'm_1', quote: 'Preserve constraints' }],
                  },
                ],
                requirements: [],
                decisions: [],
                work: [],
                blockers: [],
                nextSteps: [],
                files: [],
              }),
          },
        },
      ],
    }),
  };
}
function fixture(extra = {}) {
  const body = workload();
  extra.mutate?.(body);
  const store = createContextArtifactStore();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
  const controller = new globalThis.AbortController();
  const errors = [],
    requests = [];
  let time = 1;
  const preparation = createWorkBuddyContextPreparation({
    clock: () => time++,
    diagnosticLog: { error: (...values) => errors.push(values) },
  });
  const options = {
    targetBodyBytes: 360000,
    preflightBodyBytes: 70000,
    growthReserveBytes: 64000,
    minimumCleanupBytes: 1024,
    operationalInputTokens: 300000,
    artifactStore: store,
    artifactOwner: 'owner',
    artifactScope: 'scope',
    ...extra.options,
  };
  const runtime = {
    historyBranch: history,
    policyKey: 'private-route',
    signal: controller.signal,
    requestSummary: async (request, opts) => {
      requests.push(request);
      assert.equal(
        request.messages[0].content,
        Array.isArray(JSON.parse(request.messages[1].content).quoteTable)
          ? TASK_STATE_INTERNED_DIRECTIVE
          : TASK_STATE_DIRECTIVE
      );
      assert.equal(request.tools, undefined);
      return extra.summary ? extra.summary(history, opts) : completion();
    },
  };
  return {
    body,
    store,
    history,
    controller,
    preparation,
    options,
    runtime,
    errors,
    requests,
    close() {
      history.close();
      store.close();
    },
  };
}

test('background admission is original, explicitly started once, and commits only at a safe point', async () => {
  const during = { role: 'assistant', content: 'Append while summarizing.' };
  const after = { role: 'user', content: 'Revised constraint after summary.' };
  const f = fixture({
    summary: (history) => {
      assert.equal(history.append([during], history.stats().version).ok, true);
      return completion();
    },
  });
  let operation;
  try {
    const result = await f.preparation.prepare(f.body, f.options, f.runtime);
    operation = result.background;
    assert.ok(operation);
    assert.equal(result.plan.changed, false);
    assert.deepEqual(result.plan.body, f.body);
    assert.equal(f.requests.length, 0);
    assert.equal(operation.take().ok, false);
    assert.equal(operation.start(), true);
    assert.equal(operation.start(), false);
    assert.equal((await operation.ready).ok, true);
    assert.equal(f.store.stats().entries, 0);
    assert.equal(f.history.snapshot().body.messages.length, f.body.messages.length + 1);
    assert.equal(f.history.append([after], f.history.stats().version).ok, true);
    const committed = operation.take();
    assert.equal(committed.ok, true);
    assert.ok(f.store.stats().entries > 0);
    assert.deepEqual(committed.plan.body.messages.slice(-2), [during, after]);
    assert.strictEqual(operation.take(), committed);
    assert.equal(f.requests.length, 1);
    assert.ok(!JSON.stringify(f.errors).includes('Unverified historical'));
  } finally {
    operation?.close();
    f.close();
  }
});

test('explicitly protected narration survives snapshot remapping and summary replacement', async () => {
  const protectedMessage = { role: 'assistant', content: 'Protected narration. '.repeat(100) };
  const f = fixture({
    mutate: (body) => body.messages.splice(2, 0, protectedMessage),
    options: { protectedMessages: new Set([protectedMessage]) },
  });
  let operation;
  try {
    operation = (await f.preparation.prepare(f.body, f.options, f.runtime)).background;
    operation.start();
    assert.equal((await operation.ready).ok, true);
    const committed = operation.take();
    assert.equal(committed.ok, true);
    assert.ok(committed.plan.body.messages.some((m) => m.content === protectedMessage.content));
  } finally {
    operation?.close();
    f.close();
  }
});

test('invalid, rate limited, thrown and truncated summaries retain original without publication', async () => {
  for (const mode of ['invalid', 'rate', 'throw', 'truncated']) {
    const f = fixture({
      summary: () => {
        if (mode === 'throw') throw new Error('PRIVATE_PROVIDER_CONTENT');
        if (mode === 'rate') return { ok: true, status: 429, body: 'PRIVATE_PROVIDER_CONTENT' };
        if (mode === 'truncated') return { ok: true, status: 200, body: '{bad' };
        return completion('{}');
      },
    });
    let operation;
    try {
      operation = (await f.preparation.prepare(f.body, f.options, f.runtime)).background;
      operation.start();
      assert.equal((await operation.ready).ok, false, mode);
      assert.equal(operation.take().ok, false);
      assert.deepEqual(f.history.snapshot().body, f.body);
      assert.equal(f.store.stats().entries, 0);
      assert.ok(!JSON.stringify(f.errors).includes('PRIVATE_PROVIDER_CONTENT'));
    } finally {
      operation?.close();
      f.close();
    }
  }
});

test('close, cancellation and late results never publish or retain a pending history writer', async () => {
  for (const mode of ['close-before', 'abort-before', 'close-during', 'abort-ready']) {
    let resolveSummary;
    const f = fixture({
      summary: () =>
        new Promise((resolve) => {
          resolveSummary = resolve;
        }),
    });
    let operation;
    try {
      operation = (await f.preparation.prepare(f.body, f.options, f.runtime)).background;
      if (mode === 'close-before') operation.close();
      if (mode === 'abort-before') f.controller.abort();
      const started = operation.start();
      if (mode.endsWith('before')) assert.equal(started, false);
      else {
        await new Promise((resolve) => setImmediate(resolve));
        if (mode === 'close-during') operation.close();
        resolveSummary(completion());
        if (mode === 'abort-ready') {
          await operation.ready;
          f.controller.abort();
        }
      }
      await operation.ready;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(operation.take().ok, false);
      assert.equal(f.store.stats().entries, 0);
      assert.equal(f.history.stats().stagedEntries, 0);
      assert.deepEqual(f.history.snapshot().body, f.body);
      assert.equal(operation.close(), false);
    } finally {
      operation?.close();
      f.close();
    }
  }
});

test('required overflow, disabled truncation, empty and invalid budgets cannot bypass foreground admission', async () => {
  for (const mode of ['required', 'disabled', 'zero', 'empty', 'forced']) {
    const f = fixture({
      mutate: (body) => {
        if (mode === 'disabled') applyResponsesHistoryPolicy(body, { truncation: 'disabled' });
        if (mode === 'empty') body.messages = [];
      },
      options:
        mode === 'required'
          ? { targetBodyBytes: 70000 }
          : mode === 'zero'
            ? { operationalInputTokens: 0 }
            : mode === 'forced'
              ? { force: true }
              : {},
    });
    try {
      const result = await f.preparation.prepare(f.body, f.options, f.runtime);
      assert.equal(result.background, null, mode);
      if (mode === 'zero') assert.equal(result.plan.fits, false);
      if (mode === 'required') assert.equal(result.plan.changed, true);
      if (mode === 'disabled' || mode === 'empty') assert.equal(result.plan.changed, false);
    } finally {
      f.close();
    }
  }
});

test('preparation constructor rejects hostile injection without evaluating getters', () => {
  let accessed = 0;
  const getter = Object.defineProperty({}, 'clock', {
    get() {
      accessed++;
      return Date.now;
    },
  });
  for (const input of [
    null,
    [],
    1,
    getter,
    Object.create({ clock: Date.now }),
    { extra: 1 },
    { clock: 1 },
    { schedule: {} },
    { diagnosticLog: {} },
  ])
    assert.throws(() => createWorkBuddyContextPreparation(input), TypeError);
  const scheduleGetter = Object.defineProperty({}, 'decide', {
    get() {
      accessed++;
      return () => ({});
    },
  });
  assert.throws(() => createWorkBuddyContextPreparation({ schedule: scheduleGetter }), TypeError);
  assert.equal(accessed, 0);
});

test('slow summary timeout is observed and keeps the original canonical window', async () => {
  const f = fixture({
    summary: (_history, { signal }) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ ok: false, status: 'cancelled' }), {
          once: true,
        })
      ),
  });
  const coordinator = createContextCompactionCoordinator({ deadlineMs: 10 });
  let operation;
  try {
    operation = (await f.preparation.prepare(f.body, f.options, { ...f.runtime, coordinator }))
      .background;
    operation.start();
    assert.equal((await operation.ready).ok, false);
    assert.deepEqual(f.history.snapshot().body, f.body);
    assert.equal(f.store.stats().entries, 0);
  } finally {
    operation?.close();
    coordinator.close();
    f.close();
  }
});

test('insufficient gain defers optional work without a summary call or visible evidence', async () => {
  const f = fixture({ options: { minimumCleanupBytes: 1000000 } });
  let operation;
  try {
    operation = (await f.preparation.prepare(f.body, f.options, f.runtime)).background;
    operation.start();
    assert.equal((await operation.ready).ok, false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.stats().entries, 0);
    assert.deepEqual(f.history.snapshot().body, f.body);
  } finally {
    operation?.close();
    f.close();
  }
});

test('entire background processing chain observes thrown callbacks and cleanup failures without raw logs', async () => {
  const unhandled = [],
    diagnostics = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    for (const mode of [
      'fulfillment',
      'rollback',
      'commit',
      'invalid-commit',
      'cancel-running',
      'late-result',
    ]) {
      let rolls = 0,
        resolve;
      let accessed = 0;
      const capability = {
        commit() {
          if (mode === 'invalid-commit') return null;
          throw new Error('PRIVATE_COMMIT');
        },
        rollback() {
          rolls++;
          throw new Error('PRIVATE_ROLLBACK');
        },
      };
      const result = { fits: true, changed: true, pendingCommit: capability, diagnostics: {} };
      if (mode === 'fulfillment')
        Object.defineProperty(result, 'fits', {
          get() {
            accessed++;
            throw new Error('PRIVATE_RESULT');
          },
        });
      if (mode === 'rollback') result.fits = false;
      let calls = 0;
      const operation = createBackgroundOperation(
        () => {
          calls++;
          return mode === 'late-result'
            ? new Promise((settle) => {
                resolve = settle;
              })
            : result;
        },
        undefined,
        { error: (...values) => diagnostics.push(values) }
      );
      operation.start();
      if (mode === 'cancel-running') operation.close();
      if (mode === 'late-result') {
        await new Promise((settle) => setImmediate(settle));
        operation.close();
        resolve(result);
      }
      const ready = await operation.ready;
      if (mode === 'commit' || mode === 'invalid-commit') {
        assert.equal(ready.ok, true);
        assert.equal(operation.take().ok, false);
      } else assert.equal(ready.ok, false);
      operation.close();
      await new Promise((settle) => setImmediate(settle));
      if (mode === 'cancel-running') assert.equal(calls, 0);
      else assert.equal(rolls, 1, mode);
      assert.equal(accessed, 0, 'Candidate validation must not invoke result getters');
    }
    assert.deepEqual(unhandled, []);
    assert.ok(diagnostics.length > 0);
    assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_'));
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
});
