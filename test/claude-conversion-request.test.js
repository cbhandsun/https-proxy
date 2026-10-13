'use strict';
const assert = require('node:assert/strict');
const { prepareOpenAIClaudeRequest } = require('../lib/proxy/handlers/claude-conversion-request');
const prepared = {
  rewriteTo: 'deepseek-v4-flash',
  model: 'deepseek-v4-flash',
  profile: { protocol: 'claude', targetUrl: 'https://api.deepseek.com/anthropic' },
};
const source = {
  model: 'alias',
  messages: [{ role: 'user', content: 'hello' }],
  reasoning_effort: 'low',
  max_tokens: 1024,
};
let conversions = 0;
let errors = 0;
const ctx = {
  parseProxyBody: () => source,
  rejectUnsupportedOpenAIChatNonOpenAIConversion: () => false,
  rejectUnsupportedResponsesNonOpenAIConversion: () => false,
  openAIChatToClaudeMessages(body) {
    conversions++;
    assert.equal(body.reasoning_effort, undefined);
    return { max_tokens: body.max_tokens, messages: body.messages };
  },
  responsesToChatWithHistory: () => ({ max_tokens: 1024, messages: [] }),
  sendJsonError: () => {
    errors++;
  },
};
const before = JSON.stringify(source);
const chat = prepareOpenAIClaudeRequest(ctx, {}, prepared, 'chat');
assert.equal(chat.claudeBody.max_tokens, 1024);
assert.equal(chat.claudeBody.output_config.effort, 'low');
assert.equal(JSON.stringify(source), before);
assert.equal(
  prepareOpenAIClaudeRequest({ ...ctx, parseProxyBody: () => null }, {}, prepared, 'chat'),
  null
);
assert.equal(
  prepareOpenAIClaudeRequest(
    { ...ctx, rejectUnsupportedOpenAIChatNonOpenAIConversion: () => true },
    {},
    prepared,
    'chat'
  ),
  null
);
assert.equal(conversions, 1);
assert.equal(
  prepareOpenAIClaudeRequest(
    { ...ctx, responsesToChatWithHistory: () => null },
    {},
    prepared,
    'responses'
  ),
  null
);
const nativeCtx = {
  ...ctx,
  resolveResponsesHistory: () => ({ history: [], messages: [] }),
  responsesHistoryToClaude: () => ({ messages: [], max_tokens: 1024 }),
  claudeResponseToResponses: () => ({}),
  openAIChatToClaudeMessages: () => {
    throw new Error('Native requests must not use Chat conversion');
  },
};
const native = prepareOpenAIClaudeRequest(nativeCtx, {}, prepared, 'responses');
assert.equal(native.native, true);
assert.equal(native.claudeBody.output_config.effort, 'low');
assert.equal(
  prepareOpenAIClaudeRequest(
    { ...nativeCtx, resolveResponsesHistory: () => null },
    {},
    prepared,
    'responses'
  ),
  null
);
assert.equal(
  prepareOpenAIClaudeRequest(
    {
      ...nativeCtx,
      responsesHistoryToClaude: () => {
        const error = new TypeError('fixture');
        error.code = 'invalid_request_error';
        throw error;
      },
    },
    {},
    prepared,
    'responses'
  ),
  null
);
assert.equal(errors, 1);
assert.equal(
  prepareOpenAIClaudeRequest(
    {
      ...ctx,
      openAIChatToClaudeMessages: () => ({
        __hpmDiagnostics: { contextBudget: { enabled: true, overBudgetTokens: 1 } },
      }),
    },
    {},
    prepared,
    'chat'
  ),
  null
);
assert.equal(errors, 2);
assert.throws(
  () =>
    prepareOpenAIClaudeRequest(
      {
        ...ctx,
        openAIChatToClaudeMessages: () => {
          throw new Error('Dependency failure');
        },
      },
      {},
      prepared,
      'chat'
    ),
  /Dependency failure/
);
console.log('claude-conversion-request.test.js passed');
