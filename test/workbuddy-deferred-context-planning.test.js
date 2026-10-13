'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { prepareConvertedChatBody } = require('../lib/proxy/handlers/converted-chat-request');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { applyContextBudgetToMessages } = require('../lib/proxy/context-budget-manager');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const {
  applyResponsesHistoryPolicy,
  shouldStoreResponsesHistory,
} = require('../lib/proxy/responses-history-policy');
const { estimateTokensForValue } = require('../lib/proxy/inline-media');
const { planContextEviction } = require('../lib/proxy/context-eviction-planner');
const { toolCallIds, toolResultIds } = require('../lib/proxy/context-classifier');

const scope = 'hcs_' + 'b'.repeat(32);
const prepared = { authProvider: 'workbuddy', profile: { protocol: 'workbuddy' } };
const protocolOptions = { contextWindowPolicy: 'overflow-drop-oldest', maxContextTokens: 30000 };
function body() {
  const messages = [{ role: 'user', content: '保留中文约束，不执行外部命令。' }];
  for (let index = 0; index < 20; index++)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_' + index, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_' + index,
        content: 'HEAD'.repeat(2000) + 'ORIGINAL_MIDDLE_EVIDENCE🙂' + 'TAIL'.repeat(2000),
      }
    );
  messages.push({ role: 'user', content: '继续，前面的约束仍然有效。' });
  return {
    model: 'hy4-preview-f',
    messages,
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  };
}

test('trusted WBIPC preparation preserves original evidence and IDs until the transactional planner applies the unchanged token ceiling', () => {
  const input = body(),
    original = JSON.stringify(input.messages);
  prepareConvertedChatBody(prepared, input, input.model, {
    protocolOptions,
    deferContextPlanning: true,
  });
  const budget = input.__hpmDiagnostics.contextBudget;
  assert.equal(budget.planningDeferred, true);
  assert.equal(budget.enabled, true);
  assert.equal(budget.inputBudgetTokens, 30000 - budget.reservedTokens);
  assert.equal(JSON.stringify(input.messages), original);
  assert.ok(budget.overBudgetTokens > 0);
  assert.equal(budget.droppedCount, 0);
  const store = createContextArtifactStore();
  const history = createContextHistoryBranch(input, { owner: 'owner', scope });
  try {
    const planned = planWorkBuddyWbipcRequest(input, {
      force: true,
      targetBodyBytes: 100000,
      operationalInputTokens: budget.inputBudgetTokens,
      artifactStore: store,
      artifactOwner: 'owner',
      artifactScope: scope,
      historyBranch: history,
    });
    assert.equal(planned.fits, true);
    assert.ok(estimateTokensForValue(planned.body) <= budget.inputBudgetTokens);
    assert.ok(Buffer.byteLength(JSON.stringify(planned.body)) <= 100000);
    assert.equal(history.hasToolCallId('call_0'), true);
    assert.ok(store.stats().entries > 0);
    assert.ok(
      planned.diagnostics.workingSetAttempts > 1,
      'token pressure must keep planning even when the byte candidate already fits'
    );
  } finally {
    history.close();
    store.close();
  }
});

test('token-only pressure archives complete parallel rounds and keeps policy and unresolved work intact', () => {
  const input = body();
  const parallel = {
    role: 'assistant',
    tool_calls: [
      { id: 'parallel_a', type: 'function', function: { name: 'read', arguments: '{}' } },
      { id: 'parallel_b', type: 'function', function: { name: 'read', arguments: '{}' } },
    ],
  };
  const pending = {
    role: 'assistant',
    tool_calls: [{ id: 'pending', type: 'function', function: { name: 'write', arguments: '{}' } }],
  };
  const policy = { role: 'system', content: '不得泄露凭证。' };
  input.messages.unshift(policy);
  input.messages.splice(
    -1,
    0,
    parallel,
    { role: 'tool', tool_call_id: 'parallel_b', content: '完整证据🙂'.repeat(2000) },
    { role: 'tool', tool_call_id: 'parallel_a', content: '第二证据🙂'.repeat(2000) }
  );
  input.messages.push(pending);
  const original = JSON.stringify(input);
  const ceiling = 13000;
  const planned = planWorkBuddyWbipcRequest(input, {
    targetBodyBytes: 1000000,
    operationalInputTokens: ceiling,
  });
  assert.equal(planned.fits, true);
  assert.equal(JSON.stringify(input), original);
  assert.ok(estimateTokensForValue(planned.body) <= ceiling);
  assert.ok(planned.body.messages.includes(policy));
  assert.ok(planned.body.messages.includes(pending));
  const calls = planned.body.messages.flatMap(toolCallIds);
  const results = planned.body.messages.flatMap(toolResultIds);
  assert.equal(calls.filter((id) => id.startsWith('parallel_')).length, 2);
  for (const id of calls.filter((id) => id !== 'pending'))
    assert.equal(results.filter((result) => result === id).length, 1);
  assert.ok(planned.diagnostics.workingSetAttempts > 1);
  assert.ok(!JSON.stringify(planned.diagnostics).includes('不得泄露'));
});

test('zero and malformed token ceilings fail closed without defaulting to a larger budget or publishing evidence', () => {
  const store = createContextArtifactStore();
  try {
    for (const ceiling of [0, -1, NaN, Infinity, '13000', null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const input = body();
      const original = JSON.stringify(input);
      const planned = planWorkBuddyWbipcRequest(input, {
        targetBodyBytes: 1000000,
        operationalInputTokens: ceiling,
        artifactStore: store,
        artifactOwner: 'owner',
        artifactScope: scope,
      });
      assert.equal(planned.fits, false, String(ceiling));
      assert.equal(JSON.stringify(planned.body), original);
      assert.equal(store.stats().entries, 0);
      assert.equal(store.stats().retainedBytes, 0);
      if (ceiling !== 0) assert.equal(planned.diagnostics.reason, 'invalid_token_budget');
    }
    const input = body();
    const maximum = planWorkBuddyWbipcRequest(input, {
      targetBodyBytes: 1000000,
      operationalInputTokens: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(maximum.fits, true);
    assert.equal(maximum.body, input);
  } finally {
    store.close();
  }
});

test('message token admission covers empty, invalid, exact and impossible mandatory windows', () => {
  assert.equal(planContextEviction([], 100, { inputBudgetTokens: 0 }).fits, true);
  for (const budget of [-1, NaN, Infinity, '100', null]) {
    const rejected = planContextEviction([], 100, { inputBudgetTokens: budget });
    assert.equal(rejected.fits, false);
    assert.equal(rejected.diagnostics.reason, 'invalid_input');
  }
  const mandatory = [{ role: 'user', content: '用户原文🙂'.repeat(1000) }];
  const exact = estimateTokensForValue(mandatory);
  assert.equal(
    planContextEviction(mandatory, 100000, { inputBudgetTokens: exact, preserveUserMessages: true })
      .fits,
    true
  );
  const overflow = planContextEviction(mandatory, 100000, {
    inputBudgetTokens: exact - 1,
    preserveUserMessages: true,
  });
  assert.equal(overflow.fits, false);
  assert.deepEqual(overflow.messages, mandatory);
});

test('deferred planning cannot bypass mandatory overflow, disabled truncation or client storage policy', () => {
  for (const mode of ['mandatory', 'disabled']) {
    const input = applyResponsesHistoryPolicy(body(), {
      store: false,
      ...(mode === 'disabled' ? { truncation: 'disabled' } : {}),
    });
    if (mode === 'mandatory')
      input.messages.push({ role: 'user', content: '不可裁剪🙂'.repeat(20000) });
    prepareConvertedChatBody(prepared, input, input.model, {
      protocolOptions,
      deferContextPlanning: true,
    });
    const budget = input.__hpmDiagnostics.contextBudget;
    const store = createContextArtifactStore();
    const history = createContextHistoryBranch(input, { owner: 'owner', scope });
    try {
      const planned = planWorkBuddyWbipcRequest(input, {
        force: true,
        targetBodyBytes: 100000,
        operationalInputTokens: budget.inputBudgetTokens,
        artifactStore: store,
        artifactOwner: 'owner',
        artifactScope: scope,
        historyBranch: history,
      });
      assert.equal(planned.fits, false, mode);
      assert.equal(shouldStoreResponsesHistory(planned.body), false);
      assert.equal(JSON.stringify(planned.body.messages), JSON.stringify(input.messages));
      assert.equal(store.stats().entries, 0);
    } finally {
      history.close();
      store.close();
    }
  }
});

test('ordinary preparation still uses existing optimization and a wire-like option cannot activate trusted deferral', () => {
  const input = body();
  input.deferContextPlanning = true;
  prepareConvertedChatBody(prepared, input, input.model, { protocolOptions });
  assert.ok(
    input.messages
      .filter((message) => message.role === 'tool')
      .filter((message) => message.content.includes('ORIGINAL_MIDDLE_EVIDENCE')).length < 20
  );
  assert.equal(input.__hpmDiagnostics.contextBudget.planningDeferred, undefined);
});

test('deferred budget measurement handles empty and non-array inputs without weakening disabled or zero ceilings', () => {
  const zero = applyContextBudgetToMessages(
    [{ role: 'user', content: 'required' }],
    {},
    'fixture',
    { maxContextTokens: 10000 },
    { deferPlanning: true, includeCacheDiagnostics: false }
  );
  assert.equal(zero.diagnostics.inputBudgetTokens, 0);
  assert.ok(zero.diagnostics.overBudgetTokens > 0);
  assert.equal(zero.diagnostics.contextCache, undefined);
  const empty = applyContextBudgetToMessages([], {}, 'fixture', protocolOptions, {
    deferPlanning: true,
  });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.diagnostics.overBudgetTokens, 0);
  const absent = applyContextBudgetToMessages(null, {}, 'fixture', protocolOptions, {
    deferPlanning: true,
  });
  assert.equal(absent.messages, null);
  const disabled = applyContextBudgetToMessages(
    [{ role: 'user', content: 'required' }],
    {},
    'fixture',
    { contextWindowPolicy: 'disabled' },
    { deferPlanning: true }
  );
  assert.equal(disabled.diagnostics.enabled, false);
  assert.equal(disabled.messages.length, 1);
});
