'use strict';

const assert = require('node:assert/strict');
const {
  optimizeContextMessages,
  truncateToolOutputText,
} = require('../lib/proxy/context-optimizer');
const {
  pruneMessagesToTokenBudget,
  resolveContextBudget,
  applyContextBudgetToMessages,
} = require('../lib/proxy/context-budget-manager');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { rejectGeminiContextOverflow } = require('../lib/proxy/handlers/route-gemini-utils');

const call = {
  role: 'assistant',
  tool_calls: ['a', 'b'].map((id) => ({ id, function: { name: 'read', arguments: '{}' } })),
};
const results = ['a', 'b'].map((id) => ({ role: 'tool', tool_call_id: id, content: id }));
const latest = { role: 'user', content: 'private-input-marker' };
for (const budget of [0, 1, 2, 3]) {
  assert.deepEqual(
    pruneMessagesToTokenBudget([call, ...results, latest], budget, () => 1).messages,
    [latest]
  );
}
assert.deepEqual(pruneMessagesToTokenBudget([call, ...results], 1, () => 1).messages, [
  call,
  ...results,
]);
const system = { role: 'system', content: 'fixed' };
assert.deepEqual(
  pruneMessagesToTokenBudget([system, call, ...results, latest], 4, () => 1).messages,
  [system, latest]
);
// Once the suffix is full, do not backfill it with unrelated older messages.
assert.deepEqual(
  pruneMessagesToTokenBudget([{ cost: 1 }, { cost: 20 }, latest], 2, (m) => m.cost || 1).messages,
  [latest]
);
assert.deepEqual(pruneMessagesToTokenBudget([], 0).messages, []);
assert.equal(pruneMessagesToTokenBudget(null, 0).messages, null);

const claudeCall = {
  role: 'assistant',
  content: ['a', 'b'].map((id) => ({ type: 'tool_use', id, name: 'read', input: {} })),
};
const claudeResults = ['a', 'b'].map((id) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(5000) }],
}));
assert.deepEqual(
  pruneMessagesToTokenBudget([claudeCall, ...claudeResults, latest], 3, () => 1).messages,
  [latest]
);
const history = [
  { role: 'user', content: 'old' },
  claudeCall,
  ...claudeResults,
  latest,
  { role: 'assistant', content: 'ok' },
];
const snapshot = JSON.stringify(history);
const compressed = optimizeContextMessages(history, {
  keepRecentTurns: 1,
  maxHistoricalToolChars: 100,
});
assert.equal(compressed.prunedCount, 2);
assert.ok(compressed.messages[2].content[0].content.length <= 100);
assert.equal(compressed.messages[2].content[0].tool_use_id, 'a');
assert.equal(JSON.stringify(history), snapshot);
assert.deepEqual(optimizeContextMessages(history, { keepRecentTurns: 2 }).messages, history);
assert.deepEqual(
  optimizeContextMessages(history.slice(0, 4), { keepRecentTurns: 2 }).messages,
  history.slice(0, 4)
);
for (const max of [0, 1, 30, 100, 500])
  assert.ok(truncateToolOutputText('x'.repeat(1000), max).length <= max);

const media = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(400) },
};
const mixed = JSON.parse(JSON.stringify(history));
mixed[2].content.push({ type: 'text', text: 'preserve user instructions' });
mixed[2].content[0].content = [{ type: 'text', text: 'x'.repeat(5000) }, media];
const folded = optimizeContextMessages(mixed, { keepRecentTurns: 1, maxHistoricalToolChars: 100 });
assert.deepEqual(folded.messages[2].content[0].content[1], media);
assert.equal(folded.messages[2].content[1].text, 'preserve user instructions');

const budget = resolveContextBudget({}, 'gemini-3.8', { maxContextTokens: 1000 });
assert.equal(budget.inputBudgetTokens, 0, 'never invent a minimum larger than the actual window');
const over = applyContextBudgetToMessages(
  [latest],
  {},
  'gemini-3.8',
  { maxContextTokens: 1000 },
  { fixedInputTokens: 50 }
);
assert.ok(over.diagnostics.overBudgetTokens > 0);
assert.equal(over.diagnostics.fixedInputTokens, 50);
let error;
assert.equal(
  rejectGeminiContextOverflow(
    {},
    { __hpmDiagnostics: { contextBudget: over.diagnostics } },
    (_res, status, payload) => {
      error = { status, payload };
    }
  ),
  true
);
assert.equal(error.status, 400);
assert.equal(error.payload.error.code, 'context_length_exceeded');
assert.ok(!JSON.stringify(error).includes('private-input-marker'));
assert.equal(
  rejectGeminiContextOverflow({}, {}, () => assert.fail()),
  false
);

const protocol = createOpenAIProtocol({
  protocolOptions: { maxContextTokens: 2, contextWindowPolicy: 'overflow-drop-oldest' },
  cleanToolArgs: (_name, args) => args,
});
const converted = protocol.openAIChatToClaudeMessages(
  { messages: [call, ...results] },
  'gemini-3.8'
);
assert.equal(converted.messages[0].role, 'assistant');
assert.equal(converted.messages[1].content.length, 2);
assert.ok(converted.__hpmDiagnostics.contextBudget.overBudgetTokens > 0);
assert.equal(
  rejectGeminiContextOverflow({}, converted, (_res, status, payload) => {
    error = { status, payload };
  }),
  true
);
assert.equal(error.payload.error.code, 'context_length_exceeded');
console.log('[context-integrity.test] ok');
