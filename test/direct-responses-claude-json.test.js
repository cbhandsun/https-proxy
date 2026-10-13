'use strict';
const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { harness } = require('./internal-stream-events.test');
const { createResponsesClaudeBridge } = require('../lib/proxy/responses-claude-bridge');
const { claudeUsageToOpenAIChatUsage } = require('../lib/proxy/protocol-usage-details');
const noop = () => {};
const config = {
  ...require('../lib/proxy/tools'),
  fallbackId: (prefix) => prefix + '_fixture',
  stableCreated: () => 7,
};
const ai = createOpenAIProtocol(config);
const text = (value) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: value }],
});
const tool = {
  type: 'function_call',
  status: 'completed',
  name: 'lookup',
  call_id: 'call_fixture',
  arguments: '{"q":"中文 😀"}',
};
const response = (output = [], extra = {}) => ({
  id: 'resp_fixture',
  status: 'completed',
  model: 'upstream',
  output,
  usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 3 } },
  ...extra,
});
for (const output of [
  [],
  [text('')],
  [text('中文 😀 " \\ \n')],
  [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] }, text('answer')],
  [tool],
  [text('before'), tool, text('after')],
  [{ type: 'custom_tool_call', name: 'custom', call_id: 'custom_fixture', input: 'raw " \\ \n' }],
  [{ type: 'web_search_call', status: 'completed' }, text('search answer')],
]) {
  const payload = response(output);
  const before = JSON.stringify(payload);
  const native = ai.responsesResponseToClaude(payload, 'client');
  assert.deepEqual(
    native,
    ai.openAIResponseToClaudeMessage(ai.openAIResponsesToChatResponse(payload, 'client'), 'client')
  );
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(native.usage, { input_tokens: 9, output_tokens: 8, cache_read_input_tokens: 3 });
  assert.equal(claudeUsageToOpenAIChatUsage(native.usage).prompt_tokens, 12);
}
const exhausted = response(
  [text('partial'), { ...tool, status: 'incomplete', arguments: '{"q":' }],
  { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
);
const partial = ai.responsesResponseToClaude(exhausted, 'client');
assert.equal(partial.stop_reason, 'max_tokens');
assert.deepEqual(partial.content, [{ type: 'text', text: 'partial' }]);
for (const payload of [
  null,
  [],
  {},
  response([], { status: 'failed', error: { message: 'SECRET' } }),
  response([], { status: 'in_progress' }),
  response([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
  response([], { status: 'incomplete', incomplete_details: { reason: 'OTHER' } }),
  response([text(123)]),
  response([null]),
  response([{ type: 'image_generation_call' }]),
  response([
    { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'SECRET' }] },
  ]),
  response([{ ...tool, arguments: '{"SECRET":invalid}' }]),
  response([{ ...tool, arguments: [] }]),
  response([{ ...tool, arguments: null }]),
  response([{ ...tool, name: '', arguments: '{}' }]),
  response([{ ...tool, call_id: {} }]),
  response([{ ...tool, status: 'in_progress' }]),
  response([{ type: 'custom_tool_call', name: 'custom', input: [] }]),
  response([{ type: 'reasoning', summary: [{ text: 123 }] }]),
]) {
  assert.throws(
    () => ai.responsesResponseToClaude(payload, 'client'),
    (error) => error instanceof TypeError && !error.message.includes('SECRET')
  );
}
for (const [payload, options] of [
  [response([text('x'.repeat(2048))]), { maxConversionStreamBytes: 128 }],
  [response([tool]), { maxConversionToolArgumentBytes: 1 }],
  [response([tool, tool]), { maxConversionToolCalls: 1 }],
]) {
  const bounded = createOpenAIProtocol({ ...config, protocolOptions: options });
  assert.throws(() => bounded.responsesResponseToClaude(payload, 'client'));
}
const poison = createOpenAIProtocol({
  ...config,
  cleanToolArgs: () => {
    throw new Error('SECRET');
  },
});
assert.throws(
  () => poison.responsesResponseToClaude(response([tool]), 'client'),
  (error) => !error.message.includes('SECRET')
);
const expanded = createOpenAIProtocol({
  ...config,
  cleanToolArgs: () => ({ expanded: 'x'.repeat(100) }),
  protocolOptions: { maxConversionToolArgumentBytes: 50 },
});
assert.throws(() => expanded.responsesResponseToClaude(response([tool]), 'client'));
const chat = (reason) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'partial',
        tool_calls: [
          { id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
      finish_reason: reason,
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 3 } },
});
assert.equal(ai.openAIResponseToClaudeMessage(chat('length'), 'client').stop_reason, 'max_tokens');
assert.ok(
  !ai
    .openAIResponseToClaudeMessage(chat('length'), 'client')
    .content.some((part) => part.type === 'tool_use')
);
assert.throws(() => ai.openAIResponseToClaudeMessage(chat('content_filter'), 'client'));
assert.throws(() => ai.openAIResponseToClaudeMessage(chat('OTHER'), 'client'));
for (const reason of [null, undefined])
  assert.throws(() => ai.openAIResponseToClaudeMessage(chat(reason), 'client'));
assert.equal(
  ai.openAIResponseToClaudeMessage(chat('tool_calls'), 'client').stop_reason,
  'tool_use'
);
function runRoute(payload, direct = true) {
  let result;
  const logs = [];
  const ctx = {
    ...ai,
    responsesResponseToClaude: direct ? ai.responsesResponseToClaude : undefined,
    http: {
      request: (_options, callback) => {
        callback({ statusCode: 200, headers: {} });
        return { on: noop, end: noop };
      },
    },
    claudeMessagesToOpenAIChat: () => ({ messages: [] }),
    openAIChatToResponsesRequest: (body) => body,
    parseProxyBody: () => ({ model: 'client', messages: [] }),
    upstreamRequestOptions: () => ({}),
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    collectBoundedResponse: (_upstream, _client, _path, _type, done) =>
      done(JSON.stringify(payload)),
    parseJsonOrSseJson: JSON.parse,
    writeJsonResponse: (_client, status, value) => {
      result = { status, value };
    },
    sendJsonError: (_client, status, value) => {
      result = { status, value };
    },
    logRequestEnd: (...args) => logs.push(args),
    logProxyEvent: noop,
    log: { warn: noop },
    openAIResponsesToChatResponse: direct
      ? () => assert.fail('Chat response envelope selected')
      : ai.openAIResponsesToChatResponse,
  };
  createRouteHandlers(ctx).handleClaudeMessagesToOpenAIResponses(
    { method: 'POST' },
    {},
    { rewriteTo: '-', buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', path: '/v1' },
    '',
    '/messages',
    1
  );
  return { ...result, logs };
}
assert.deepEqual(
  runRoute(response([text('answer'), tool])).value,
  ai.responsesResponseToClaude(response([text('answer'), tool]), 'client')
);
assert.equal(runRoute(exhausted).value.stop_reason, 'max_tokens');
for (const payload of [
  response([], { status: 'failed', error: { message: 'SECRET' } }),
  response([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
  response([{ ...tool, arguments: '{"SECRET":invalid}' }]),
]) {
  const result = runRoute(payload);
  assert.equal(result.status, 502);
  assert.equal(result.logs.at(-1)[3], 502);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
}
assert.equal(runRoute(chat('content_filter')).status, 502);
assert.equal(runRoute(chat('length')).value.stop_reason, 'max_tokens');
assert.equal(
  runRoute(
    response([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
    false
  ).status,
  502
);
const h = harness(false);
const state = { usage: {}, toolCalls: [], textIndex: -1 };
const bridge = createResponsesClaudeBridge(h.stream, h.sink, state);
bridge.finish(
  { ok: true, failed: false, incomplete: false },
  { prompt_tokens: 12, completion_tokens: 8, cached_input_tokens: 3 }
);
assert.deepEqual(state.usage, partial.usage);
const weird = ai.responsesResponseToClaude(
  response([], {
    usage: { input_tokens: '12', output_tokens: -1, input_tokens_details: { cached_tokens: '99' } },
  }),
  'client'
);
assert.deepEqual(weird.usage, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 12 });
console.log('direct-responses-claude-json.test.js passed');
