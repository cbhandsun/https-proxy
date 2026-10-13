'use strict';

const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { parseResponsesHistory } = require('../lib/proxy/responses-semantic-history');
const noop = () => {};
const deps = {
  ...require('../lib/proxy/tools'),
  fallbackId: () => 'generated',
  stableCreated: () => 1,
  isClaudeThinkingBlock: (block) => block?.type === 'thinking',
  filterClaudeCompatibleBlocks: (blocks) => blocks,
};
const ai = createOpenAIProtocol(deps);
const input = [
  { role: 'user', content: 'question' },
  { type: 'function_call', call_id: 'exact-id', name: 'lookup', arguments: '{"q":"x"}' },
  { type: 'function_call_output', call_id: 'exact-id', output: 'result' },
];
const body = {
  instructions: 'system',
  input,
  tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
  max_output_tokens: 123,
};
const history = parseResponsesHistory(input, deps, body.instructions);
const before = JSON.stringify(history);
const compiled = ai.responsesHistoryToClaude(body, { history }, 'target');
assert.equal(compiled.model, 'target');
assert.equal(compiled.system, 'system');
assert.equal(compiled.max_tokens, 123);
assert.equal(compiled.messages[1].content[0].id, 'exact-id');
assert.equal(compiled.messages[2].content[0].tool_use_id, 'exact-id');
assert.deepEqual(compiled.messages[2].content[0].content, [{ type: 'text', text: 'result' }]);
assert.equal(JSON.stringify(history), before);
const image = {
  role: 'user',
  content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGk=' }],
};
assert.equal(
  ai.responsesHistoryToClaude({}, { history: parseResponsesHistory([image], deps) }, 'target')
    .messages[0].content[0].type,
  'image'
);
const reason = { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }] };
assert.deepEqual(
  ai.responsesHistoryToClaude({}, { history: parseResponsesHistory([reason], deps) }, 'target')
    .messages[0].content,
  [{ type: 'text', text: 'summary' }]
);
const compactionItem = {
  type: 'provider_context',
  provider: 'anthropic',
  visible_output_index: 0,
  data: { type: 'compaction', content: 'bounded summary', encrypted_content: 'opaque-context' },
};
const compactionRequest = ai.responsesHistoryToClaude(
  {},
  { history: parseResponsesHistory([compactionItem], deps) },
  'target',
  { nativeContextManagement: true }
);
assert.deepEqual(compactionRequest.messages[0], {
  role: 'assistant',
  content: [compactionItem.data],
});
const compactedJson = ai.claudeResponseToResponses(
  {
    id: 'msg_compacted',
    content: [compactionItem.data, { type: 'text', text: 'continued answer' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  'target'
);
assert.equal(compactedJson.output[0].content[0].text, 'continued answer');
assert.equal(Object.keys(compactedJson).includes('__hpmProviderContextItems'), false);
assert.deepEqual(compactedJson.__hpmProviderContextItems, [
  {
    type: 'provider_context',
    provider: 'anthropic',
    visible_output_index: 0,
    data: compactionItem.data,
  },
]);
assert.throws(
  () =>
    ai.claudeResponseToResponses(
      {
        id: 'msg_invalid_compaction',
        content: [{ ...compactionItem.data, secret: 'no' }],
        stop_reason: 'end_turn',
        usage: {},
      },
      'target'
    ),
  (error) => !error.message.includes('secret')
);
assert.throws(() =>
  ai.claudeResponseToResponses(
    {
      id: 'msg_invalid_compaction_order',
      content: [{ type: 'text', text: 'before' }, compactionItem.data],
      stop_reason: 'end_turn',
      usage: {},
    },
    'target'
  )
);
assert.throws(
  () =>
    ai.responsesHistoryToClaude(
      {},
      { history: parseResponsesHistory([{ ...reason, encrypted_content: 'opaque' }], deps) },
      'target'
    ),
  (error) => error.code === 'invalid_request_error'
);

function route(source, options = {}) {
  let sent,
    error,
    requests = 0;
  const sendJsonError = (_res, status, value) => {
    error = { status, value };
  };
  const state = createResponsesState({
    ...deps,
    ...ai,
    sendJsonError,
    log: { info: noop, warn: noop },
  });
  state.rememberResponsesHistory('previous', { version: 2, history });
  const ctx = {
    ...ai,
    ...state,
    ...createRequestValidators({ sendJsonError }),
    ...options,
    sendJsonError,
    responsesToChatWithHistory: () => assert.fail('Chat history selected'),
    openAIChatToClaudeMessages: () => assert.fail('Chat request converter selected'),
    openAIResponsesToChat: () => assert.fail('Responses Chat converter selected'),
    parseProxyBody: () => source,
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
  };
  createRouteHandlers(ctx).handleOpenAIResponsesToClaudeMessages(
    { method: 'POST', headers: {} },
    {},
    { rewriteTo: 'target', buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', path: '/v1' },
    '',
    '/responses',
    1
  );
  return { sent, error, requests };
}
assert.equal(route(body).sent.messages[1].content[0].id, 'exact-id');
const continued = route({ previous_response_id: 'previous', input: 'continue' });
assert.equal(continued.sent.messages[1].content[0].id, 'exact-id');
assert.equal(continued.sent.messages.at(-1).content.at(-1).text, 'continue');
for (const invalid of [
  { input: [{ type: 'function_call', name: 'lookup', arguments: '{SECRET' }] },
  { input: [{ ...reason, encrypted_content: 'SECRET' }] },
  { previous_response_id: 'missing', input: [] },
  { tools: {}, input: [] },
  { input: 'question', max_output_tokens: 'SECRET' },
  { input: 'question', temperature: 1.5 },
  { input: 'question', stream: 'SECRET' },
  { input: 'question', text: { format: 'SECRET' } },
  { input: 'question', text: { format: { type: 'text' } }, response_format: {} },
]) {
  const result = route(invalid);
  assert.equal(result.requests, 0);
  assert.equal(result.error.status, 400);
  assert.ok(!JSON.stringify(result.error).includes('SECRET'));
}

// Compare the native compiler with the former two-stage request conversion.
const corpus = [
  [],
  '中文 😀',
  [{ role: 'user', content: 'question' }],
  [{ role: 'user', content: [{ type: 'input_text', text: 'look' }, ...image.content] }],
  input,
  [...input, { role: 'user', content: 'follow-up' }],
  [{ role: 'assistant', content: 'partial' }],
];
let comparisons = 0;
function comparable(request) {
  const copy = JSON.parse(JSON.stringify(request));
  function blocks(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return content.map((block) =>
      block.type === 'tool_result' ? { ...block, content: blocks(block.content) } : block
    );
  }
  for (const message of copy.messages) message.content = blocks(message.content);
  return copy;
}
for (const protocolOptions of [{ contextWindowPolicy: 'disabled' }, { maxContextTokens: 32000 }]) {
  const converter = createOpenAIProtocol({ ...deps, protocolOptions });
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6']) {
    for (const items of corpus) {
      for (const options of [
        {},
        { max_output_tokens: 1000, temperature: 0, top_p: 1 },
        { tools: body.tools, tool_choice: 'required' },
        { tools: body.tools, tool_choice: 'none' },
        { reasoning: { effort: 'high' }, stream: true },
      ]) {
        const source = { input: items, instructions: 'system', ...options };
        const context = { history: parseResponsesHistory(items, deps, source.instructions) };
        const snapshot = JSON.stringify({ source, context });
        const legacy = converter.openAIChatToClaudeMessages(
          converter.openAIResponsesToChat(source),
          model
        );
        const native = converter.responsesHistoryToClaude(source, context, model);
        assert.deepEqual(comparable(native), comparable(legacy));
        assert.equal(JSON.stringify({ source, context }), snapshot);
        comparisons++;
      }
    }
  }
}
process.stdout.write(
  `[responses-native-claude-request.test] ok: ${comparisons} differential cases\n`
);
