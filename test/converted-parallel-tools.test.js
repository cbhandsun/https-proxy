'use strict';
const assert = require('node:assert/strict');
const { applyConvertedParallelTools } = require('../lib/proxy/converted-parallel-tools');
const { responsesTargetOptions } = require('../lib/proxy/responses-target-options');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const noop = () => {};
const deps = {
  ...require('../lib/proxy/tools'),
  fallbackId: () => 'fixture',
  stableHash: () => 'fixture',
};
const ai = createOpenAIProtocol(deps);
const gemini = createGeminiProtocol(deps);
const tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } };
for (const parallel of [true, false]) {
  for (const choice of [
    undefined,
    'required',
    { type: 'function', function: { name: 'lookup' } },
  ]) {
    const source = {
      messages: [],
      tools: [tool],
      tool_choice: choice,
      parallel_tool_calls: parallel,
    };
    assert.equal(
      ai.openAIChatToClaudeMessages(source, 'model').tool_choice.disable_parallel_tool_use,
      !parallel
    );
  }
  assert.equal(
    responsesTargetOptions(
      { tools: [{ type: 'function', ...tool.function }], parallel_tool_calls: parallel },
      'model',
      'Claude'
    ).tool_choice.disable_parallel_tool_use,
    !parallel
  );
}
for (const value of ['false', 0, {}, [], NaN])
  assert.throws(
    () => applyConvertedParallelTools({}, { parallel_tool_calls: value }, 'Claude'),
    (error) => error.code === 'invalid_request_error'
  );
const none = { tools: [tool], tool_choice: { type: 'none' } };
applyConvertedParallelTools(none, { parallel_tool_calls: false }, 'Gemini');
assert.deepEqual(none.tool_choice, { type: 'none' });
applyConvertedParallelTools({}, { parallel_tool_calls: false }, 'Gemini');
assert.throws(
  () =>
    gemini.tryOpenAIChatToGemini(
      { messages: [], tools: [tool], parallel_tool_calls: false },
      'gemini-3.8-flash'
    ),
  (error) => error.code === 'invalid_request_error'
);
for (const shape of ['Chat', 'Responses']) {
  const errors = [];
  const validators = createRequestValidators({ sendJsonError: (...args) => errors.push(args) });
  const reject =
    validators[
      shape === 'Chat'
        ? 'rejectUnsupportedOpenAIChatNonOpenAIConversion'
        : 'rejectUnsupportedResponsesNonOpenAIConversion'
    ];
  const tools = shape === 'Chat' ? [tool] : [{ type: 'function', ...tool.function }];
  assert.equal(reject({}, { tools, parallel_tool_calls: false }, 'Gemini'), true);
  assert.equal(errors[0][1], 400);
  assert.equal(reject({}, { tools, parallel_tool_calls: true }, 'Gemini'), false);
}
function route(target, parallel) {
  let sent,
    error,
    requests = 0;
  const sendJsonError = (_res, status, value) => {
    error = { status, value };
  };
  const ctx = {
    ...deps,
    ...ai,
    ...gemini,
    ...createRequestValidators({ sendJsonError }),
    sendJsonError,
    parseProxyBody: () => ({ messages: [], tools: [tool], parallel_tool_calls: parallel }),
    http: {
      request: () => {
        requests++;
        return {
          on: noop,
          end: (bytes) => {
            sent = JSON.parse(bytes);
          },
        };
      },
    },
    upstreamRequestOptions: () => ({}),
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    shouldUseCodeAssistUpstream: () => false,
    getGeminiCooldown: () => null,
  };
  createRouteHandlers(ctx)[
    target === 'Claude' ? 'handleOpenAIChatToClaudeMessages' : 'handleOpenAIChatToGeminiMessages'
  ](
    { method: 'POST', headers: {} },
    {},
    { rewriteTo: 'model', buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', hostname: 'fixture', path: '/v1' },
    '',
    '/chat',
    Date.now()
  );
  return { sent, error, requests };
}
assert.equal(route('Claude', false).sent.tool_choice.disable_parallel_tool_use, true);
assert.equal(route('Claude', 'false').error.status, 400);
assert.equal(route('Gemini', false).requests, 0);
assert.equal(route('Gemini', false).error.status, 400);
