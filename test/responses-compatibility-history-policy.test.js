'use strict';
const assert = require('node:assert/strict');
const {
  applyResponsesHistoryPolicy,
  shouldStoreResponsesHistory,
  preservesResponsesHistory,
} = require('../lib/proxy/responses-history-policy');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { prepareConvertedChatBody } = require('../lib/proxy/handlers/converted-chat-request');
const { sanitizeWorkBuddyChatBody } = require('../lib/proxy/workbuddy-official');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const deps = {
  ...require('../lib/proxy/claude-filters').createClaudeFilters({ protocolOptions: {} }),
  ...require('../lib/proxy/tools'),
  fallbackId: () => 'fixture',
  stableHash: () => 'fixture',
};
const policy = { maxContextTokens: 1000, outputReserveTokens: 100, safetyMarginTokens: 100 };
const ai = createOpenAIProtocol({ ...deps, protocolOptions: policy });
const gemini = createGeminiProtocol({ ...deps, protocolOptions: policy });
const messages = [
  { role: 'user', content: 'old'.repeat(10000) },
  { role: 'assistant', content: 'answer' },
  { role: 'user', content: 'current' },
];
const body = applyResponsesHistoryPolicy(
  { messages, max_tokens: 100 },
  { truncation: 'disabled', store: false }
);
const claude = ai.openAIChatToClaudeMessages(body, 'model');
assert.equal(shouldStoreResponsesHistory(claude), false);
assert.equal(preservesResponsesHistory(claude), true);
assert.equal(claude.__hpmDiagnostics.contextBudget.droppedCount, 0);
assert.ok(claude.__hpmDiagnostics.contextBudget.overBudgetTokens > 0);
const request = gemini.claudeMessagesToGemini(claude, 'gemini-3.8-flash');
assert.equal(request.contents.length, 3);
assert.ok(request.__hpmDiagnostics.contextBudget.overBudgetTokens > 0);
const converted = applyResponsesHistoryPolicy({ messages }, { truncation: 'disabled' });
prepareConvertedChatBody(
  { profile: { protocol: 'trae', optimizeContext: true } },
  converted,
  'model'
);
assert.equal(converted.messages, messages);
const workbuddy = applyResponsesHistoryPolicy(
  { messages, max_tokens: 100 },
  { truncation: 'disabled' }
);
sanitizeWorkBuddyChatBody(workbuddy, { targetModel: 'model', protocolOptions: policy });
assert.equal(workbuddy.messages.length, 3);
assert.equal(workbuddy.messages[0].content, messages[0].content);
assert.ok(workbuddy.__hpmDiagnostics.contextBudget.overBudgetTokens > 0);
for (const force of [false, true]) {
  const result = planWorkBuddyWbipcRequest(workbuddy, {
    force,
    operationalInputTokens: 100,
    preflightBodyBytes: 100,
    targetBodyBytes: 100,
  });
  assert.equal(result.changed, false);
  assert.equal(result.fits, false);
  assert.equal(result.body, workbuddy);
  assert.equal(result.diagnostics.truncationDisabled, true);
}
const small = applyResponsesHistoryPolicy(
  { messages: [{ role: 'user', content: 'current' }] },
  { truncation: 'disabled' }
);
assert.equal(planWorkBuddyWbipcRequest(small).fits, true);
assert.equal(planWorkBuddyWbipcRequest(small, { force: true }).changed, false);
