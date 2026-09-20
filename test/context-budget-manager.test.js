'use strict';

const assert = require('node:assert/strict');
const {
  applyContextBudgetToMessages,
  pruneMessagesToTokenBudget,
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

console.log('[context-budget-manager.test] ok');
