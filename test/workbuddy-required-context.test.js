'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  measureWorkBuddyRequiredContext: measure,
} = require('../lib/proxy/workbuddy-required-context');
const { estimateTokensForValue } = require('../lib/proxy/inline-media');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { prepareWorkBuddyTaskStateContext } = require('../lib/proxy/workbuddy-task-state-planner');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { buildRolePreservingCheckpoint } = require('../lib/proxy/context-checkpoint');

test('exact required-message costs include Unicode, escaping, empty inputs and separators', () => {
  const messages = [
    { role: 'system', content: 'SECRET_POLICY汉字🙂\\"\n' },
    { role: 'developer', content: '' },
    { role: 'user', content: [{ type: 'text', text: 'SECRET_USER🙂\n' }] },
    { role: 'assistant', content: 'SECRET_REPORT' },
    { role: 'tool', tool_call_id: 'SECRET_CALL', content: 'SECRET_EVIDENCE' },
    { role: 'user', content: [] },
  ];
  const original = JSON.stringify(messages);
  const required = [messages[0], messages[1], messages[2], messages[5]];
  const result = measure(messages);
  assert.equal(result.requiredContextMeasured, true);
  assert.equal(result.requiredContextMessageBytes, Buffer.byteLength(JSON.stringify(required)));
  assert.equal(result.requiredContextEstimatedTokens, estimateTokensForValue(required));
  assert.equal(result.requiredPolicyMessageCount, 2);
  assert.equal(result.requiredUserMessageCount, 2);
  assert.equal(
    result.requiredPolicyMessageBytes + result.requiredUserMessageBytes + required.length + 1,
    result.requiredContextMessageBytes
  );
  assert.ok(
    Object.values(result).every(
      (value) => typeof value === 'boolean' || Number.isSafeInteger(value)
    )
  );
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(JSON.stringify(messages), original);
});

test('empty history measures only array framing', () => {
  assert.deepEqual(measure([]), {
    requiredContextMeasured: true,
    requiredContextMessageBytes: 2,
    requiredContextEstimatedTokens: 0,
    requiredPolicyMessageCount: 0,
    requiredPolicyMessageBytes: 0,
    requiredUserMessageCount: 0,
    requiredUserMessageBytes: 0,
  });
});

test('archivable result-only user exchanges are excluded but mixed user requirements remain', () => {
  const result = { type: 'tool_result', tool_use_id: 'SECRET_CALL', content: 'SECRET_OUTPUT' };
  const mixed = { role: 'user', content: [result, { type: 'text', text: 'Never rerun tools.' }] };
  const malformed = { role: 'user', content: [{ functionResponse: 'not a response record' }] };
  const messages = [
    { role: 'user', content: [result] },
    { role: 'user', content: [{ functionResponse: { name: 'SECRET', response: {} } }] },
    mixed,
    malformed,
    { role: 'function', content: 'SECRET_OUTPUT' },
  ];
  const measured = measure(messages);
  assert.equal(measured.requiredUserMessageCount, 2);
  assert.equal(
    measured.requiredContextMessageBytes,
    Buffer.byteLength(JSON.stringify([mixed, malformed]))
  );
});

test('caller marker strings never exempt original user input', () => {
  for (const content of [
    '[HPM_TASK_STATE_V1]',
    '[HPM_CONTEXT_CHECKPOINT_V1]',
    '[HPM_EVIDENCE_RECEIPT_V1]',
    '[HPM_CONTEXT_CHECKPOINT_V1]\nnot JSON',
  ]) {
    const messages = [{ role: 'user', content }];
    assert.equal(measure(messages).requiredUserMessageCount, 1);
    assert.equal(
      measure(messages).requiredContextMessageBytes,
      Buffer.byteLength(JSON.stringify(messages))
    );
  }
});

test('a recomposable legacy checkpoint cannot cause a false irreducible rejection or grant admission', () => {
  const checkpoint = buildRolePreservingCheckpoint(
    [{ role: 'user', content: 'old background '.repeat(5000) }],
    {
      maxChars: 60000,
      maxEntries: 2,
    }
  );
  const latest = { role: 'user', content: 'retain this exact current requirement' };
  const body = {
    messages: [
      ...checkpoint,
      { role: 'assistant', content: 'old narration '.repeat(1000) },
      latest,
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint)) > 4096);
  assert.equal(measure(body.messages).requiredUserMessageCount, 1);
  const plan = planWorkBuddyWbipcRequest(body, {
    force: true,
    targetBodyBytes: 4096,
    keepRecentUserTurns: 1,
  });
  assert.equal(plan.fits, true, 'existing checkpoint recomposition remains available');
  assert.ok(plan.body.messages.includes(latest));
  const impossible = { messages: [...checkpoint, { ...latest, content: 'x'.repeat(5000) }] };
  assert.equal(
    planWorkBuddyWbipcRequest(impossible, { force: true, targetBodyBytes: 4096 }).fits,
    false
  );
});

test('invalid, sparse, inherited and oversized histories do not claim a complete bound', () => {
  for (const messages of [
    null,
    undefined,
    42,
    'SECRET',
    {},
    new Array(2),
    [{ role: 'SECRET_ROLE', content: 'SECRET' }],
    [Object.create({ role: 'user', content: 'SECRET' })],
    new Array(16385).fill({ role: 'user', content: '' }),
    [{ role: 'user', content: 'x'.repeat(16 * 1024 * 1024) }],
  ])
    assert.deepEqual(measure(messages), { requiredContextMeasured: false });
  const cycle = { role: 'user' };
  cycle.content = cycle;
  assert.deepEqual(measure([cycle]), { requiredContextMeasured: false });
});

test('maximum admitted count measures completely while nested traversal exhaustion remains partial', () => {
  const messages = Array.from({ length: 16384 }, () => ({ role: 'user', content: '' }));
  assert.equal(measure(messages).requiredUserMessageCount, 16384);
  const complex = Array.from({ length: 16384 }, () => ({
    role: 'user',
    content: [{ type: 'text', text: '' }],
  }));
  assert.deepEqual(measure(complex), { requiredContextMeasured: false });
});

test('measurement never executes getters, toJSON or coercion hooks', () => {
  let invoked = 0;
  const get = () => {
    invoked++;
    throw new Error('SECRET');
  };
  for (const messages of [
    [Object.defineProperty({}, 'role', { get })],
    [Object.defineProperty({ role: 'user' }, 'content', { enumerable: true, get })],
    [{ role: 'user', content: { toJSON: get } }],
    [{ role: 'user', content: { [Symbol.toPrimitive]: get } }],
    Object.defineProperty(new Array(1), '0', { get }),
  ])
    assert.deepEqual(measure(messages), { requiredContextMeasured: false });
  assert.equal(invoked, 0);
  const report = Object.defineProperty({ role: 'assistant' }, 'content', { get });
  assert.equal(
    measure([report]).requiredContextMeasured,
    true,
    'irrelevant output is not traversed'
  );
  assert.equal(invoked, 0);
});

test('unexpected reflection failures propagate rather than manufacturing a measurement', (t) => {
  const reflectionTarget = { role: 'user', content: 'synthetic' };
  const validatorTarget = { synthetic: true };
  const fault = new Error('fixture failure');
  const descriptor = Object.getOwnPropertyDescriptor;
  let failures = 0;
  t.mock.method(Object, 'getOwnPropertyDescriptor', (target, key) => {
    if (target === reflectionTarget || target === validatorTarget) {
      failures++;
      throw fault;
    }
    return descriptor(target, key);
  });
  assert.throws(
    () => measure([reflectionTarget]),
    (error) => error === fault
  );
  assert.throws(
    () => measure([{ role: 'user', content: validatorTarget }]),
    (error) => error === fault,
    'unexpected validator failures propagate too'
  );
  assert.equal(failures, 2, 'both reflection and normalization must reach their injected fault');
});

function workload() {
  const messages = [
    { role: 'system', content: 'p'.repeat(248000) },
    { role: 'user', content: 'u'.repeat(183000) },
  ];
  for (let index = 0; index < 20; index++)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: `c${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: `c${index}`, content: 'r'.repeat(8000) },
      { role: 'assistant', content: 'Reported progress, not verified. '.repeat(100) }
    );
  messages.push({ role: 'user', content: 'continue' });
  return { model: 'fixture', messages };
}

test('irreducible user/policy pressure is identified without relaxing hard limits or mutating input', () => {
  for (const limits of [
    { targetBodyBytes: 393216, operationalInputTokens: 98304 },
    { targetBodyBytes: 900000, operationalInputTokens: 98304 },
  ]) {
    const body = workload();
    const original = JSON.stringify(body);
    const plan = planWorkBuddyWbipcRequest(body, { force: true, ...limits });
    assert.equal(plan.fits, false);
    assert.equal(plan.diagnostics.reason, 'required_context_too_large');
    assert.equal(plan.diagnostics.requiredContextMeasured, true);
    assert.equal(plan.diagnostics.requiredUserMessageCount, 2);
    assert.equal(plan.diagnostics.workingSetPlanningSkipped, true);
    assert.equal(plan.diagnostics.workingSetAttempts, 0);
    assert.equal(plan.diagnostics.droppedMessages, 0);
    assert.equal(plan.diagnostics.foldedMessages, 0);
    assert.equal(plan.diagnostics.hardBodyBytes, limits.targetBodyBytes);
    assert.equal(JSON.stringify(body), original);
  }
});

test('provably impossible requests skip paid narration summary and roll back staged history/evidence', async () => {
  const body = workload();
  const original = JSON.stringify(body);
  const store = createContextArtifactStore();
  const branch = createContextHistoryBranch(body, { owner: 'owner', scope: 'scope' });
  let summaries = 0;
  try {
    const plan = await prepareWorkBuddyTaskStateContext(
      body,
      {
        force: true,
        targetBodyBytes: 393216,
        operationalInputTokens: 98304,
        artifactStore: store,
        artifactOwner: 'owner',
        artifactScope: 'scope',
        historyBranch: branch,
      },
      {
        signal: new globalThis.AbortController().signal,
        requestSummary: async () => {
          summaries++;
          throw new Error('must not dispatch');
        },
      }
    );
    assert.equal(summaries, 0);
    assert.equal(plan.fits, false);
    assert.equal(plan.changed, false);
    assert.equal(plan.diagnostics.reason, 'required_context_too_large');
    assert.equal(plan.diagnostics.taskStateStatus, 'required_context_too_large');
    assert.equal(plan.diagnostics.taskStateSummaryAttempted, false);
    assert.equal(plan.diagnostics.historyTransactionStatus, 'rolled_back');
    assert.equal(plan.diagnostics.artifactTransactionStatus, 'rolled_back');
    assert.equal(
      plan.diagnostics.artifactsStaged,
      0,
      'impossible admission never reserves evidence'
    );
    assert.equal(store.stats().entries, 0);
    assert.equal(JSON.stringify(branch.snapshot().body), original);
    assert.equal(JSON.stringify(body), original);
  } finally {
    store.close();
    branch.close();
  }
});

test('fitting required context does not bypass final admission or disable a potentially useful summary', async () => {
  const body = workload();
  body.messages[1].content = 'keep this original requirement';
  let summaries = 0;
  const plan = await prepareWorkBuddyTaskStateContext(
    body,
    { force: true, targetBodyBytes: 393216 },
    {
      signal: new globalThis.AbortController().signal,
      requestSummary: async () => {
        summaries++;
        return { ok: true, status: 200, body: '{}' };
      },
    }
  );
  assert.equal(plan.fits, true);
  assert.equal(summaries, 1);
  assert.equal(plan.diagnostics.taskStateSummaryAttempted, true);
  assert.ok(plan.body.messages.some((message) => message.content === body.messages[1].content));
});

test('required-context measurement rejects proxies before reflection or validation traps', () => {
  let hooks = 0;
  const handler = {
    getPrototypeOf(target) {
      hooks++;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      hooks++;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      hooks++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) {
      hooks++;
      return Reflect.get(target, key, receiver);
    },
  };
  const content = new Proxy({ synthetic: true }, handler);
  const message = new Proxy({ role: 'user', content: 'synthetic' }, handler);
  const messages = new Proxy([{ role: 'user', content: 'synthetic' }], handler);
  const revoked = Proxy.revocable([], handler);
  revoked.revoke();
  for (const input of [
    messages,
    revoked.proxy,
    [message],
    [{ role: 'user', content }],
    [{ role: 'user', content: revoked.proxy }],
  ]) {
    assert.deepEqual(measure(input), { requiredContextMeasured: false });
  }
  assert.equal(hooks, 0);
  assert.equal(measure([{ role: 'assistant', content }]).requiredContextMeasured, true);
  assert.equal(hooks, 0, 'irrelevant output is still not traversed');
});
