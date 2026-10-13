'use strict';
const assert = require('node:assert/strict');
const {
  applyResponsesHistoryPolicy,
  parseResponsesHistoryPolicy,
  shouldStoreResponsesHistory,
  preservesResponsesHistory,
} = require('../lib/proxy/responses-history-policy');
const { applyContextBudgetToMessages } = require('../lib/proxy/context-budget-manager');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
for (const source of [
  {},
  { store: null, truncation: null },
  { store: true },
  { store: false, truncation: 'disabled' },
  { truncation: 'auto' },
]) {
  const snapshot = JSON.stringify(source);
  const context = applyResponsesHistoryPolicy({}, Object.freeze(source));
  assert.equal(shouldStoreResponsesHistory({ ...context }), source.store !== false);
  assert.equal(preservesResponsesHistory(context), source.truncation === 'disabled');
  assert.equal(JSON.stringify(context), '{}');
  assert.equal(JSON.stringify(source), snapshot);
}
for (const source of [
  null,
  [],
  'SECRET',
  { store: 'SECRET' },
  { store: 0 },
  { store: [] },
  { truncation: true },
  { truncation: 'SECRET'.repeat(10000) },
  { truncation: {} },
])
  assert.throws(
    () => parseResponsesHistoryPolicy(source),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
  );
assert.equal(shouldStoreResponsesHistory({ __responsesHistoryPolicy: { store: false } }), true);
assert.equal(preservesResponsesHistory({ truncation: 'disabled' }), false);

const messages = [
  { role: 'user', content: 'old'.repeat(10000) },
  { role: 'assistant', content: 'answer' },
  { role: 'user', content: 'current' },
];
const options = {
  maxContextTokens: 1000,
  outputReserveTokens: 100,
  safetyMarginTokens: 100,
  contextWindowPolicy: 'disabled',
};
const preserved = applyContextBudgetToMessages(
  messages,
  applyResponsesHistoryPolicy({}, { truncation: 'disabled' }),
  'model',
  options,
  { fixedInputTokens: 50 }
);
assert.equal(preserved.messages, messages);
assert.equal(preserved.diagnostics.droppedCount, 0);
assert.ok(preserved.diagnostics.overBudgetTokens > 0);
assert.equal(preserved.diagnostics.fixedInputTokens, 50);
const automatic = applyContextBudgetToMessages(
  messages,
  applyResponsesHistoryPolicy({}, { truncation: 'auto' }),
  'model',
  options
);
assert.ok(automatic.messages.length < messages.length);
assert.equal(automatic.messages.at(-1).content, 'current');
const under = applyContextBudgetToMessages(
  [{ role: 'user', content: 'current' }],
  applyResponsesHistoryPolicy({}, { truncation: 'disabled' }),
  'model',
  options
);
assert.equal(under.diagnostics.overBudgetTokens, 0);

const errors = [];
const state = createResponsesState({
  fallbackId: () => 'fixture',
  log: { info() {}, warn() {} },
  sendJsonError: (_res, status, body) => errors.push({ status, body }),
  openAIResponsesToChat: () => ({ messages: [{ role: 'user', content: 'current' }] }),
});
state.responsesSummaries.set('summary', { text: 'compressed history' });
for (const method of ['resolveResponsesHistory', 'responsesToChatWithHistory']) {
  assert.equal(
    state[method](
      {},
      { input: [], previous_response_id: 'summary', truncation: 'disabled' },
      'model'
    ),
    null
  );
  assert.equal(errors.at(-1).status, 400);
  assert.ok(
    state[method]({}, { input: [], previous_response_id: 'summary', truncation: 'auto' }, 'model')
  );
}
const bridge = {
  responseState: {
    id: 'private',
    completedOutputItems: [{ type: 'message', role: 'assistant', content: 'reply' }],
  },
};
const semantic = state.resolveResponsesHistory({}, { input: 'private', store: false }, 'model');
state.rememberResponsesFromBridge(bridge, semantic);
const chat = state.responsesToChatWithHistory({}, { input: 'private', store: false }, 'model');
state.rememberResponsesFromBridge(bridge, chat);
state.rememberResponsesFromChatResponse({ id: 'private' }, chat, {
  choices: [{ message: { role: 'assistant', content: 'reply' } }],
});
assert.equal(state.responsesHistory.size, 0);
assert.equal(state.responsesSummaries.has('private'), false);
state.responsesToChatWithHistory({}, { previous_response_id: 'SECRET' }, 'model');
assert.ok(!JSON.stringify(errors.at(-1)).includes('SECRET'));
