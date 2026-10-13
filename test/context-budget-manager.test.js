'use strict';

const assert = require('node:assert/strict');
const {
  applyContextBudgetToMessages,
  pruneMessagesToTokenBudget,
  rejectContextOverflow,
  resolveContextBudget,
} = require('../lib/proxy/context-budget-manager');

{
  const budget = resolveContextBudget(
    {
      max_tokens: 8192,
      reasoning_effort: 'high',
      tools: [{ name: 'read_file' }],
    },
    'gemini-3.8-flash-tiered',
    { clientContextTokens: 0 }
  );
  assert.equal(budget.enabled, true);
  assert.equal(budget.contextWindowTokens, 1000000);
  assert.equal(budget.source, 'model-default');
  assert.equal(budget.inputBudgetTokens, 975424);
  assert.equal(budget.clientContextTokens, 0);
}

{
  const budget = resolveContextBudget(
    {
      max_tokens: 8192,
      reasoning_effort: 'high',
      tools: [{ name: 'read_file' }],
    },
    'gemini-3.8-flash-tiered',
    { clientContextTokens: 200000 }
  );
  assert.equal(budget.enabled, true);
  assert.equal(budget.contextWindowTokens, 200000);
  assert.equal(budget.source, 'client-default');
  assert.equal(budget.inputBudgetTokens, 175424);
  assert.equal(budget.reservedTokens, 24576);
}

{
  const messages = [
    { role: 'system', content: 'system instructions' },
    { role: 'user', content: 'old request ' + 'A'.repeat(20000) },
    { role: 'assistant', content: 'old answer ' + 'B'.repeat(20000) },
    { role: 'tool', content: 'TOOL'.repeat(10000) },
    { role: 'user', content: 'current request' },
  ];
  const result = applyContextBudgetToMessages(
    messages,
    { max_tokens: 1024 },
    'gemini-3.8-flash-tiered',
    {
      clientContextTokens: 9000,
      outputReserveTokens: 1024,
      safetyMarginTokens: 1024,
      contextKeepRecentTurns: 1,
      maxHistoricalToolChars: 500,
      maxHistoricalMessageChars: 800,
    }
  );
  assert.equal(result.diagnostics.enabled, true);
  assert.ok(result.diagnostics.optimizedCount >= 2);
  assert.ok(result.diagnostics.estimatedInputTokens <= result.diagnostics.inputBudgetTokens);
  assert.ok(result.diagnostics.contextCache);
  assert.equal(result.diagnostics.contextCache.stablePrefixMessageCount, 1);
  assert.match(result.diagnostics.contextCache.stablePrefixHash, /^[a-f0-9]{16}$/);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[result.messages.length - 1].content, 'current request');
  assert.ok(!JSON.stringify(result.diagnostics).includes('current request'));
}

{
  const historicalTool = {
    role: 'tool',
    tool_call_id: 'old_call',
    content: 'historical output that must stay byte-for-byte stable while under budget',
  };
  const messages = [
    { role: 'system', content: 'stable policy' },
    { role: 'user', content: 'old request' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'old_call', function: { name: 'read', arguments: '{}' } }],
    },
    historicalTool,
    { role: 'user', content: 'latest request' },
  ];
  const underBudget = applyContextBudgetToMessages(
    messages,
    { max_tokens: 100 },
    'synthetic',
    {
      clientContextTokens: 10_000,
      outputReserveTokens: 100,
      safetyMarginTokens: 100,
      contextKeepRecentTurns: 1,
      maxHistoricalToolChars: 100,
    },
    { estimateMessageTokens: () => 100 }
  );
  assert.strictEqual(underBudget.messages, messages);
  assert.strictEqual(underBudget.messages[3], historicalTool);
  assert.equal(underBudget.diagnostics.compactionTriggered, false);
  assert.equal(underBudget.diagnostics.compactionApplied, false);
}

{
  const messages = [
    { role: 'system', content: 'stable policy' },
    { role: 'user', content: 'oldest request' },
    { role: 'assistant', content: 'oldest response' },
    { role: 'user', content: 'older request' },
    { role: 'assistant', content: 'older response' },
    { role: 'user', content: 'recent request' },
    { role: 'assistant', content: 'recent response' },
    { role: 'user', content: 'latest request' },
  ];
  const batched = applyContextBudgetToMessages(
    messages,
    { max_tokens: 500 },
    'synthetic',
    {
      clientContextTokens: 7000,
      outputReserveTokens: 500,
      safetyMarginTokens: 500,
      contextKeepRecentTurns: 1,
      contextCompactionMinSavingsTokens: 2000,
      contextCompactionTargetRatio: 0.8,
    },
    { estimateMessageTokens: () => 1000 }
  );
  assert.equal(batched.diagnostics.compactionTriggered, true);
  assert.equal(batched.diagnostics.compactionApplied, true);
  assert.equal(batched.diagnostics.compactionTargetTokens, 4800);
  assert.ok(batched.diagnostics.batchSavingsTokens >= 2000);
  assert.ok(batched.diagnostics.estimatedInputTokens <= 4800);
  assert.equal(batched.diagnostics.stablePrefixPreserved, true);
  assert.equal(batched.messages[0].content, 'stable policy');
  assert.equal(batched.messages.at(-1).content, 'latest request');
}

{
  const messages = [
    { role: 'user', content: 'continue the current task' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_large', type: 'function', function: { name: 'exec' } }],
    },
    { role: 'tool', tool_call_id: 'call_large', content: 'large but indivisible result' },
  ];
  const estimateMessageTokens = (message) => (message.role === 'tool' ? 180000 : 1000);
  const body = {
    max_tokens: 8192,
    reasoning_effort: 'high',
    tools: [{ name: 'exec' }],
  };
  const modelDefault = applyContextBudgetToMessages(
    messages,
    body,
    'gemini-3.8-flash-tiered',
    { contextWindowPolicy: 'overflow-drop-oldest', clientContextTokens: 0 },
    { fixedInputTokens: 40000, estimateMessageTokens }
  );
  assert.equal(modelDefault.diagnostics.contextWindowTokens, 1000000);
  assert.equal(modelDefault.diagnostics.overBudgetTokens, 0);
  assert.deepStrictEqual(modelDefault.messages, messages);

  const explicitClientCap = applyContextBudgetToMessages(
    messages,
    body,
    'gemini-3.8-flash-tiered',
    { contextWindowPolicy: 'overflow-drop-oldest', clientContextTokens: 200000 },
    { fixedInputTokens: 40000, estimateMessageTokens }
  );
  assert.equal(explicitClientCap.diagnostics.contextWindowTokens, 200000);
  assert.ok(explicitClientCap.diagnostics.overBudgetTokens > 0);
  assert.deepStrictEqual(explicitClientCap.messages, messages);
}

{
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_exec', name: 'exec', input: { input: '1' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_exec', content: '1' }],
    },
    { role: 'user', content: 'next' },
  ];
  const result = pruneMessagesToTokenBudget(messages, 3, () => 1);
  assert.deepStrictEqual(result.messages, messages);
  assert.equal(result.droppedCount, 0);

  const tight = pruneMessagesToTokenBudget(messages, 2, () => 1);
  assert.deepStrictEqual(tight.messages, [{ role: 'user', content: 'next' }]);
  assert.equal(tight.droppedCount, 2);
}

{
  const toolCall = (id) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'exec', arguments: '{}' } }],
  });
  const toolResult = (id) => ({ role: 'tool', tool_call_id: id, content: 'ok' });
  const messages = [
    { role: 'user', content: 'old completed request' },
    { role: 'assistant', content: 'old completed answer' },
    { role: 'user', content: 'run the chained task' },
    toolCall('call_a'),
    toolResult('call_a'),
    toolCall('call_b'),
    toolResult('call_b'),
  ];
  const result = pruneMessagesToTokenBudget(messages, 5, () => 1);
  assert.deepStrictEqual(result.messages, messages.slice(2));
  assert.equal(result.droppedCount, 2);
  assert.equal(result.messages[0].role, 'user');

  const overBudget = pruneMessagesToTokenBudget(messages, 4, () => 1);
  assert.deepStrictEqual(overBudget.messages, messages.slice(2));
  assert.equal(overBudget.estimatedInputTokens, 5);
}

{
  const messages = [
    { role: 'user', content: 'discard me' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'run both tools' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'a' },
    { role: 'tool', tool_call_id: 'call_b', content: 'b' },
  ];
  const result = pruneMessagesToTokenBudget(messages, 4, () => 1);
  assert.deepStrictEqual(result.messages, messages.slice(2));
  assert.equal(result.droppedCount, 2);
}

{
  const toolUse = (id) => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'exec', input: { input: '1' } }],
  });
  const toolResult = (id) => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
  });
  const messages = [
    { role: 'user', content: 'discard this older request' },
    { role: 'assistant', content: 'older answer' },
    { role: 'user', content: 'run the Gemini tool chain' },
    toolUse('toolu_a'),
    toolResult('toolu_a'),
    toolUse('toolu_b'),
    toolResult('toolu_b'),
  ];
  const result = pruneMessagesToTokenBudget(messages, 5, () => 1);
  assert.deepStrictEqual(result.messages, messages.slice(2));
  assert.equal(result.droppedCount, 2);
  assert.equal(result.messages[0].role, 'user');
}

{
  const messages = [
    { role: 'user', content: 'legacy request' },
    { role: 'assistant', function_call: { name: 'lookup', arguments: '{}' } },
    { role: 'function', name: 'lookup', content: 'legacy result' },
  ];
  const result = pruneMessagesToTokenBudget(messages, 2, () => 1);
  assert.deepStrictEqual(result.messages, messages);
  assert.equal(result.estimatedInputTokens, 3);
}

{
  const messages = [
    { role: 'assistant', content: null, tool_calls: [null] },
    { role: 'tool', content: 'malformed result without an id' },
    { role: 'user', content: 'safe latest request' },
  ];
  const result = pruneMessagesToTokenBudget(messages, 1, () => 1);
  assert.deepStrictEqual(result.messages, [{ role: 'user', content: 'safe latest request' }]);
  assert.equal(result.droppedCount, 2);
  assert.deepStrictEqual(pruneMessagesToTokenBudget(null, 1, () => 1).messages, null);
}

{
  const messages = [
    { role: 'user', content: 'run an oversized tool chain' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_big', name: 'exec', input: { input: '1' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_big', content: 'result' }],
    },
  ];
  const result = applyContextBudgetToMessages(
    messages,
    { max_tokens: 1, tools: [{ name: 'exec' }] },
    'gemini-3.8-flash-tiered',
    {
      clientContextTokens: 5,
      outputReserveTokens: 1,
      toolReserveTokens: 1,
      safetyMarginTokens: 1,
    },
    { estimateMessageTokens: () => 1 }
  );
  assert.deepStrictEqual(result.messages, messages);
  assert.equal(result.diagnostics.overBudgetTokens, 1);

  let rejected = null;
  assert.equal(
    rejectContextOverflow(
      {},
      { __hpmDiagnostics: { contextBudget: result.diagnostics } },
      (_response, status, payload) => {
        rejected = { status, payload };
      }
    ),
    true
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejected.payload.error.code, 'context_length_exceeded');
  assert.ok(!JSON.stringify(result.diagnostics).includes('oversized tool chain'));
}

console.log('[context-budget-manager.test] ok');
