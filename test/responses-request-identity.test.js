'use strict';
const assert = require('node:assert/strict');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { fallbackId, stableCreated } = require('../lib/proxy/ids');
const { applyResponsesHistoryPolicy } = require('../lib/proxy/responses-history-policy');
const errors = [];
const state = createResponsesState({
  fallbackId,
  stableCreated,
  log: { info() {}, warn() {} },
  sendJsonError: (_res, status, body) => errors.push({ status, body }),
  openAIResponsesToChat: () => ({ messages: [] }),
});
const source = Object.freeze({ model: 'synthetic', input: 'same question', stream: true });
const first = state.createResponsesStreamState(source, 'Gemini');
const second = state.createResponsesStreamState(source, 'Gemini');
assert.notEqual(
  first.id,
  second.id,
  'Response identity must distinguish separate identical requests'
);
const saved = applyResponsesHistoryPolicy(
  { messages: [{ role: 'user', content: 'synthetic' }] },
  { store: true }
);
const unstored = applyResponsesHistoryPolicy(
  { messages: [{ role: 'user', content: 'synthetic' }] },
  { store: false }
);
state.rememberResponsesFromBridge({ responseState: { ...first, completedOutputItems: [] } }, saved);
state.rememberResponsesFromBridge(
  { responseState: { ...second, completedOutputItems: [] } },
  unstored
);
assert.ok(state.responsesHistory.has(first.id));
assert.equal(state.responsesHistory.has(second.id), false);
assert.equal(
  state.responsesToChatWithHistory({}, { input: [], previous_response_id: second.id }, 'Gemini'),
  null
);
assert.equal(errors[0].status, 400);
assert.ok(
  state.responsesToChatWithHistory({}, { input: [], previous_response_id: first.id }, 'Gemini')
);
const ids = new Set();
for (let index = 0; index < 1000; index++)
  ids.add(state.createResponsesStreamState(source, 'Gemini').id);
assert.equal(ids.size, 1000);
assert.deepEqual(source, { model: 'synthetic', input: 'same question', stream: true });

const nextMessages = [
  { role: 'system', content: 'current instructions' },
  { role: 'tool', tool_call_id: 'call_synthetic', content: 'ORBIT' },
  { role: 'user', content: 'Continue.' },
];
const historical = createResponsesState({
  fallbackId,
  stableCreated,
  log: { info() {}, warn() {} },
  sendJsonError() {},
  openAIResponsesToChat: () => ({ messages: nextMessages }),
});
historical.rememberResponsesHistory('resp_stored', [
  { role: 'system', content: 'prior instructions' },
  { role: 'user', content: 'Call probe.' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_synthetic', type: 'function', function: { name: 'probe', arguments: '{}' } },
    ],
  },
]);
const continued = historical.responsesToChatWithHistory(
  {},
  { input: [], previous_response_id: 'resp_stored', instructions: 'current instructions' },
  'Chat'
);
const toolIndex = continued.messages.findIndex((message) => message.role === 'tool');
assert.equal(
  continued.messages[toolIndex - 1].role,
  'assistant',
  'Continuation instructions must not separate a tool result from its call'
);
assert.equal(
  continued.messages[toolIndex - 1].tool_calls[0].id,
  continued.messages[toolIndex].tool_call_id
);
