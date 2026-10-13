'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decideContextCleanup } = require('../lib/proxy/context-cleanup-decision');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { prepareWorkBuddyTaskStateContext } = require('../lib/proxy/workbuddy-task-state-planner');

const input = {
  originalBodyBytes: 10000,
  finalBodyBytes: 4000,
  originalEstimatedTokens: 3000,
  finalEstimatedTokens: 1000,
  targetBodyBytes: 12000,
  operationalInputTokens: 4000,
  minimumCleanupBytes: 6000,
  forced: false,
  candidateFits: true,
};

test('minimum net gain admits equality, defers small savings and does not grow token usage', () => {
  assert.equal(decideContextCleanup(input).apply, true);
  assert.equal(decideContextCleanup(input).reason, 'minimum_gain');
  const small = decideContextCleanup({ ...input, finalBodyBytes: 4001 });
  assert.equal(small.apply, false);
  assert.equal(small.required, false);
  assert.equal(small.savedBytes, 5999);
  assert.equal(small.minimumCleanupSatisfied, false);
  for (const extra of [
    { finalBodyBytes: 10001 },
    { finalEstimatedTokens: 3001 },
    { candidateFits: false },
  ])
    assert.equal(decideContextCleanup({ ...input, ...extra }).apply, false);
  assert.equal(
    decideContextCleanup({ ...input, finalBodyBytes: 12001, forced: true }).apply,
    false
  );
  assert.equal(
    decideContextCleanup({ ...input, finalEstimatedTokens: 4001, forced: true }).apply,
    false
  );
});

test('required byte/token recovery and explicit forced recovery cannot be deferred for low gain', () => {
  for (const extra of [
    { targetBodyBytes: 9999 },
    { operationalInputTokens: 2999 },
    { forced: true },
  ]) {
    const result = decideContextCleanup({ ...input, finalBodyBytes: 9900, ...extra });
    assert.equal(result.required, true);
    assert.equal(result.apply, true);
    assert.equal(result.minimumCleanupSatisfied, false);
    assert.equal(decideContextCleanup({ ...input, ...extra, candidateFits: false }).apply, false);
  }
});

test('empty, invalid, extreme and hostile decision inputs are bounded and never invoke accessors', () => {
  assert.equal(
    decideContextCleanup({ ...input, originalBodyBytes: 0, finalBodyBytes: 0 }).apply,
    false
  );
  assert.equal(decideContextCleanup({ ...input, minimumCleanupBytes: 0 }).apply, true);
  for (const value of [
    null,
    undefined,
    [],
    {},
    Object.create(input),
    { ...input, content: 'secret' },
  ])
    assert.throws(() => decideContextCleanup(value), /Invalid context cleanup decision/);
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10000', {}, 1n])
    assert.throws(() => decideContextCleanup({ ...input, originalBodyBytes: value }));
  for (const key of ['targetBodyBytes', 'operationalInputTokens'])
    assert.throws(() => decideContextCleanup({ ...input, [key]: 0 }));
  for (const key of ['forced', 'candidateFits'])
    assert.throws(() => decideContextCleanup({ ...input, [key]: 'true' }));
  let accessed = false;
  const hostile = { ...input };
  Object.defineProperty(hostile, 'finalBodyBytes', {
    get() {
      accessed = true;
      throw new Error('secret');
    },
  });
  assert.throws(() => decideContextCleanup(hostile), /Invalid context cleanup decision/);
  assert.equal(accessed, false);
  assert.equal(
    decideContextCleanup({ ...input, originalBodyBytes: Number.MAX_SAFE_INTEGER }).required,
    true
  );
});

function history() {
  return {
    messages: [
      { role: 'system', content: '不可修改策略。' },
      { role: 'user', content: '仅读取，保留证据。' },
      ...Array.from({ length: 5 }, (_, index) => [
        {
          role: 'assistant',
          tool_calls: [
            { id: `call-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: `call-${index}`,
          content: `original-${index}-` + 'x'.repeat(1500),
        },
      ]).flat(),
      { role: 'user', content: '继续。' },
    ],
  };
}

test('a zero WorkBuddy token ceiling rejects before cleanup or speculative evidence writes', () => {
  const body = history();
  const before = JSON.stringify(body);
  let result;
  assert.doesNotThrow(() => {
    result = planWorkBuddyWbipcRequest(body, {
      operationalInputTokens: 0,
      preflightBodyBytes: 1,
      targetBodyBytes: 1000000,
      artifactOwner: 'owner',
      artifactScope: 'scope',
      artifactStore: {
        put() {
          assert.fail('Disabled input admission must not allocate evidence');
        },
      },
    });
  });
  assert.equal(result.fits, false);
  assert.equal(result.diagnostics.reason, 'invalid_token_budget');
  assert.equal(JSON.stringify(result.body), before);
});

test('production planner returns exact original context and releases prospective evidence on low gain', () => {
  const store = createContextArtifactStore();
  try {
    const body = history();
    const before = JSON.stringify(body);
    const plan = planWorkBuddyWbipcRequest(body, {
      preflightBodyBytes: 1,
      targetBodyBytes: 10000,
      keepCompletedToolRounds: 1,
      minimumCleanupBytes: 64000,
      artifactStore: store,
      artifactOwner: 'owner',
      artifactScope: 'scope',
    });
    assert.equal(plan.fits, true);
    assert.equal(plan.changed, false);
    assert.strictEqual(plan.body, body);
    assert.equal(plan.diagnostics.cleanupDeferred, true);
    assert.equal(plan.diagnostics.cleanupDecision, 'insufficient_gain');
    assert.equal(plan.diagnostics.cleanupSavedBytes, 0);
    assert.equal(plan.diagnostics.finalBodyBytes, Buffer.byteLength(before));
    assert.equal(store.stats().entries, 0);
    assert.equal(JSON.stringify(body), before);
    assert.ok(!JSON.stringify(plan.diagnostics).includes('original-'));
    const forced = planWorkBuddyWbipcRequest(body, {
      force: true,
      targetBodyBytes: 10000,
      keepCompletedToolRounds: 1,
      minimumCleanupBytes: 64000,
      artifactStore: store,
      artifactOwner: 'owner',
      artifactScope: 'scope',
    });
    assert.equal(forced.fits, true);
    assert.equal(forced.changed, true);
    assert.equal(forced.diagnostics.cleanupRequired, true);
    assert.ok(store.stats().entries > 0);
  } finally {
    store.close();
  }
});

test('sufficient optional gain is published; required capacity failures remain failures', () => {
  const body = history();
  const accepted = planWorkBuddyWbipcRequest(body, {
    preflightBodyBytes: 1,
    targetBodyBytes: 10000,
    minimumCleanupBytes: 1,
  });
  assert.equal(accepted.fits, true);
  assert.equal(accepted.changed, true);
  assert.equal(accepted.diagnostics.cleanupRequired, false);
  assert.equal(accepted.diagnostics.cleanupDecision, 'minimum_gain');
  const rejected = planWorkBuddyWbipcRequest(body, { targetBodyBytes: 1 });
  assert.equal(rejected.fits, false);
  assert.equal(rejected.diagnostics.cleanupRequired, true);
});

test('optional candidates never consume legacy evidence quota without rollback support', () => {
  let writes = 0;
  const body = history();
  const plan = planWorkBuddyWbipcRequest(body, {
    preflightBodyBytes: 1,
    targetBodyBytes: 10000,
    keepCompletedToolRounds: 1,
    minimumCleanupBytes: 1,
    artifactStore: {
      put() {
        writes += 1;
        throw new Error('unrecoverable speculative admission');
      },
    },
    artifactOwner: 'owner',
    artifactScope: 'scope',
  });
  assert.strictEqual(plan.body, body);
  assert.equal(plan.fits, true);
  assert.equal(plan.changed, false);
  assert.equal(plan.diagnostics.cleanupDecision, 'evidence_staging_unavailable');
  assert.equal(writes, 0);
});

test('deferred cleanup never makes an unnecessary task-state model call', async () => {
  const body = {
    messages: [
      { role: 'system', content: 'immutable' },
      { role: 'user', content: 'continue safely' },
      { role: 'assistant', content: 'progress-'.repeat(250) },
      { role: 'user', content: 'continue' },
    ],
  };
  let calls = 0;
  const plan = await prepareWorkBuddyTaskStateContext(
    body,
    {
      preflightBodyBytes: 1,
      targetBodyBytes: 20000,
      minimumCleanupBytes: 64000,
    },
    {
      async requestSummary() {
        calls += 1;
        throw new Error('unnecessary summary');
      },
    }
  );
  assert.equal(plan.fits, true);
  assert.equal(plan.changed, false);
  assert.equal(calls, 0);
  assert.deepEqual(plan.body.messages, body.messages);
});
