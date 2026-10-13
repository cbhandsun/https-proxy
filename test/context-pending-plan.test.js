'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { prepareWorkBuddyTaskStateContext } = require('../lib/proxy/workbuddy-task-state-planner');
const { TASK_STATE_SCHEMA } = require('../lib/proxy/context-task-state');
const { createPendingContextPlan } = require('../lib/proxy/context-pending-plan');

function workload() {
  const messages = [
    { role: 'system', content: 'Do not leak credentials.' },
    { role: 'user', content: 'Keep all current constraints and unverified work.' },
  ];
  for (let index = 0; index < 20; index++)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: 'old-' + index, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'old-' + index, content: 'evidence '.repeat(1500) },
      { role: 'assistant', content: 'Unverified historical progress. '.repeat(100) }
    );
  return { model: 'fixture-model', messages };
}

function completion() {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              schema: TASK_STATE_SCHEMA,
              version: 1,
              objectives: [],
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

async function staged(extra = {}) {
  const store = createContextArtifactStore(extra.storeOptions);
  const body = workload();
  const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
  const controller = new globalThis.AbortController();
  let summaryRequests = 0;
  const result = await prepareWorkBuddyTaskStateContext(
    body,
    {
      force: true,
      targetBodyBytes: 70000,
      artifactOwner: 'owner',
      artifactScope: 'scope',
      artifactStore: store,
    },
    {
      historyBranch: history,
      signal: controller.signal,
      deferCommit: true,
      requestSummary: async (request) => {
        summaryRequests++;
        assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 70000);
        extra.duringSummary?.(history);
        return completion();
      },
    }
  );
  return {
    store,
    history,
    controller,
    result,
    body,
    summaryRequests,
    close() {
      result.pendingCommit?.rollback();
      history.close();
      store.close();
    },
  };
}

test('background candidates publish no evidence or history until the explicit safe-point commit', async () => {
  const during = { role: 'assistant', content: 'Concurrent narration during summary.' };
  const after = { role: 'user', content: 'Later policy revision remains exact and authoritative.' };
  const f = await staged({
    duringSummary(history) {
      assert.equal(history.append([during], history.stats().version).ok, true);
    },
  });
  try {
    assert.equal(f.summaryRequests, 1, 'The unchanged budget must admit the complete source');
    assert.equal(f.result.fits, true);
    assert.ok(f.result.pendingCommit, 'Deferred planning must return a private commit capability');
    assert.equal(f.result.diagnostics.historyTransactionStatus, 'staged');
    assert.equal(f.result.diagnostics.artifactsStored, 0);
    assert.equal(f.store.stats().entries, 0, 'Speculative evidence must remain invisible');
    assert.equal(f.history.snapshot().body.messages.length, f.body.messages.length + 1);
    assert.equal(f.history.append([after], f.history.stats().version).ok, true);
    const committed = f.result.pendingCommit.commit();
    assert.equal(committed.ok, true);
    assert.equal(committed.plan.diagnostics.historyTransactionStatus, 'committed');
    assert.deepEqual(committed.plan.body.messages.at(-1), after);
    assert.ok(committed.plan.body.messages.some((m) => m.content === during.content));
    assert.equal(JSON.stringify(f.history.snapshot().body), JSON.stringify(committed.plan.body));
    assert.equal(
      committed.plan.diagnostics.finalBodyBytes,
      Buffer.byteLength(JSON.stringify(committed.plan.body))
    );
    assert.ok(f.store.stats().entries > 0);
    assert.strictEqual(
      f.result.pendingCommit.commit(),
      committed,
      'Safe-point retries are idempotent'
    );
    assert.equal(f.result.pendingCommit.rollback(), false);
  } finally {
    f.close();
  }
});

test('cancelled, stale, closed, expired and oversized pending plans retain the current canonical context', async () => {
  for (const mode of ['cancel', 'stale', 'closed', 'expired', 'oversized', 'rollback']) {
    let clock = 100;
    const f = await staged({ storeOptions: { now: () => clock, ttlMs: 50 } });
    try {
      assert.ok(f.result.pendingCommit);
      assert.equal(f.store.stats().entries, 0);
      if (mode === 'cancel') f.controller.abort();
      if (mode === 'stale') {
        const s = f.history.snapshot();
        assert.equal(f.history.replace({ ...s.body, model: 'changed-model' }, s.version).ok, true);
      }
      if (mode === 'closed') f.history.close();
      if (mode === 'expired') clock = 151;
      if (mode === 'oversized')
        assert.equal(
          f.history.append(
            [{ role: 'user', content: 'new'.repeat(100000) }],
            f.history.stats().version
          ).ok,
          true
        );
      if (mode === 'rollback') assert.equal(f.result.pendingCommit.rollback(), true);
      const before = f.history.snapshot();
      const result = f.result.pendingCommit.commit();
      assert.equal(result.ok, false, mode);
      assert.equal(f.store.stats().entries, 0, mode);
      if (mode !== 'closed')
        assert.equal(JSON.stringify(f.history.snapshot().body), JSON.stringify(before.body), mode);
      assert.strictEqual(f.result.pendingCommit.commit(), result);
    } finally {
      f.close();
    }
  }
});

test('deferred planning without an owned history cannot accidentally publish a foreground candidate', async () => {
  const store = createContextArtifactStore();
  try {
    await assert.rejects(
      prepareWorkBuddyTaskStateContext(
        workload(),
        {
          force: true,
          targetBodyBytes: 70000,
          artifactOwner: 'owner',
          artifactScope: 'scope',
          artifactStore: store,
        },
        { deferCommit: true, requestSummary: async () => completion() }
      ),
      /Deferred context planning requires owned history/
    );
    assert.equal(store.stats().entries, 0);
  } finally {
    store.close();
  }
});

test('pending capability captures transaction methods and always closes history staging on commit or rollback exceptions', () => {
  for (const mode of ['capture', 'commit-error', 'rollback-error']) {
    const body = {
      model: 'fixture',
      messages: [{ role: 'user', content: 'Keep original constraint.' }],
    };
    const history = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
    const snapshot = history.snapshot();
    let commits = 0,
      rollbacks = 0;
    const transaction = {
      commit() {
        commits++;
        if (mode === 'commit-error') throw new Error('PRIVATE_COMMIT');
        return { ok: true };
      },
      rollback() {
        rollbacks++;
        if (mode === 'rollback-error') throw new Error('PRIVATE_ROLLBACK');
      },
    };
    const pending = createPendingContextPlan({
      history,
      snapshot,
      scope: 'scope',
      transaction,
      sourceMessages: 1,
      plan: {
        body,
        changed: false,
        fits: true,
        diagnostics: { hardBodyBytes: 10000, operationalInputTokens: 10000 },
      },
    });
    try {
      if (mode === 'capture') {
        Object.defineProperty(transaction, 'commit', {
          get() {
            throw new Error('MUTATED_GETTER');
          },
        });
        assert.equal(pending.commit().ok, true);
        assert.equal(commits, 1);
      } else if (mode === 'commit-error') {
        assert.throws(() => pending.commit(), /PRIVATE_COMMIT/);
        assert.equal(rollbacks, 1);
        assert.equal(pending.commit().ok, false);
      } else {
        assert.throws(() => pending.rollback(), /PRIVATE_ROLLBACK/);
        assert.equal(pending.commit().reason, 'pending_context_rollback_failed');
      }
      assert.equal(history.stats().stagedEntries, 0);
      assert.deepEqual(history.snapshot().body, body);
    } finally {
      pending.rollback();
      history.close();
    }
  }
});
