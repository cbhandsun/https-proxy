'use strict';

const assert = require('node:assert/strict');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { parseResponsesHistory } = require('../lib/proxy/responses-semantic-history');
const noop = () => {};
const deps = {
  ...require('../lib/proxy/tools'),
  ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'passthrough' } }),
  fallbackId: () => 'generated',
  stableHash: () => 'fixture',
  stableCreated: () => 1,
  sampleGeminiToolEvent: noop,
};
const tool = {
  type: 'function',
  name: 'lookup',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  strict: false,
};
const call = (id) => ({
  type: 'function_call',
  call_id: id,
  name: 'lookup',
  arguments: '{"q":"中文 😀"}',
});
const result = (id, output = 'done') => ({ type: 'function_call_output', call_id: id, output });
const media = { type: 'input_image', image_url: 'data:image/png;base64,aGk=' };
const input = [
  { role: 'user', content: 'start' },
  call('a-b'),
  call('a_b'),
  result('a_b'),
  result('a-b'),
  { role: 'user', content: 'next' },
];
const corpus = [
  [],
  'hello',
  [{ role: 'user', content: '中文 😀' }],
  [{ role: 'user', content: [{ type: 'input_text', text: 'look' }, media] }],
  input,
  [call('a'), result('a', [{ type: 'input_text', text: 'image' }, media])],
  [{ role: 'assistant', content: 'partial' }],
];
function withoutOptionalIds(request) {
  const copy = JSON.parse(JSON.stringify(request));
  for (const message of copy.contents)
    for (const part of message.parts) {
      if (part.functionCall) delete part.functionCall.id;
      if (part.functionResponse) delete part.functionResponse.id;
    }
  return copy;
}
let comparisons = 0;
for (const protocolOptions of [{ contextWindowPolicy: 'disabled' }, { maxContextTokens: 32000 }]) {
  for (const model of ['gemini-2.5-pro', 'gemini-3.8-flash-tiered', 'gemini-3.1-flash-image']) {
    for (const items of corpus)
      for (const options of [
        {},
        { tools: [tool], tool_choice: 'required' },
        {
          tools: [tool],
          tool_choice: 'none',
          reasoning: { effort: 'high' },
          max_output_tokens: 1000,
        },
      ]) {
        const config = { ...deps, protocolOptions };
        const ai = createOpenAIProtocol(config);
        const baselineProtocol = createGeminiProtocol(config);
        const nativeProtocol = createGeminiProtocol(config);
        const source = { input: items, instructions: 'system', ...options };
        const history = parseResponsesHistory(items, deps, source.instructions);
        const snapshot = JSON.stringify(history);
        const chat = ai.openAIResponsesToChat(source, model);
        const baseline = baselineProtocol.tryOpenAIChatToGemini(chat, model).request;
        const native = nativeProtocol.responsesHistoryToGemini(source, { history }, model).request;
        assert.deepEqual(withoutOptionalIds(native), withoutOptionalIds(baseline));
        assert.equal(JSON.stringify(history), snapshot);
        comparisons++;
      }
  }
}
const gemini = createGeminiProtocol(deps);
const customTool = {
  type: 'function',
  name: 'custom_action',
  parameters: { type: 'object', properties: { needle: { type: 'string' } }, required: ['needle'] },
};
const customContext = gemini.responsesHistoryToGemini(
  { tools: [customTool] },
  { history: parseResponsesHistory('start', deps) },
  'gemini-2.5-pro'
);
assert.deepEqual(customContext.tools[0].input_schema, customTool.parameters);
const malformedCall = {
  candidates: [
    {
      finishReason: 'STOP',
      content: { parts: [{ functionCall: { name: 'custom_action', args: {} } }] },
    },
  ],
};
const outputProtocol = createOpenAIProtocol(deps);
const protectedOutput = gemini.geminiResponseToResponses(
  malformedCall,
  'gemini-2.5-pro',
  customContext.tools,
  { buildResponse: outputProtocol.buildResponsesResponse, clientModel: 'client', request: {} }
);
assert.equal(
  protectedOutput.output.some((item) => item.type === 'function_call'),
  false
);
const completedCall = {
  candidates: [
    {
      finishReason: 'STOP',
      content: { parts: [{ functionCall: { name: 'custom_action', args: { needle: 'value' } } }] },
    },
  ],
};
const validOutput = gemini.geminiResponseToResponses(
  completedCall,
  'gemini-2.5-pro',
  customContext.tools,
  { buildResponse: outputProtocol.buildResponsesResponse, clientModel: 'client', request: {} }
);
assert.ok(validOutput.output.some((item) => item.type === 'function_call'));
const source = { input, tools: [tool] };
const native = gemini.responsesHistoryToGemini(
  source,
  { history: parseResponsesHistory(input, deps) },
  'gemini-2.5-pro'
).request;
const calls = native.contents
  .flatMap((message) => message.parts)
  .filter((part) => part.functionCall)
  .map((part) => part.functionCall.id);
const results = native.contents
  .flatMap((message) => message.parts)
  .filter((part) => part.functionResponse)
  .map((part) => part.functionResponse.id);
assert.deepEqual(calls, ['a-b', 'a_b']);
assert.deepEqual(results, ['a_b', 'a-b']);
const parallelIds = Array.from({ length: 128 }, (_, index) => 'parallel_' + index);
const parallelInput = [
  ...parallelIds.map(call),
  ...parallelIds.toReversed().map((id) => result(id, id)),
];
const parallel = gemini.responsesHistoryToGemini(
  { tools: [tool] },
  { history: parseResponsesHistory(parallelInput, deps) },
  'gemini-2.5-pro'
).request;
assert.deepEqual(
  parallel.contents[0].parts.map((part) => part.functionCall.id),
  parallelIds
);
assert.deepEqual(
  parallel.contents[1].parts.map((part) => part.functionResponse.id),
  [...parallelIds].reverse()
);
for (const part of parallel.contents[1].parts)
  assert.equal(part.functionResponse.response.content, part.functionResponse.id);
const audiovisual = [
  {
    role: 'user',
    content: [
      { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
      { type: 'input_video', input_video: { data: 'dmlkZW8=', format: 'mp4' } },
    ],
  },
];
const audiovisualRequest = gemini.responsesHistoryToGemini(
  {},
  { history: parseResponsesHistory(audiovisual, deps) },
  'gemini-2.5-pro'
).request;
assert.deepEqual(
  audiovisualRequest.contents[0].parts.map((part) => part.inlineData.mimeType),
  ['audio/wav', 'video/mp4']
);
gemini.rememberGeminiToolCall(
  'client-id',
  'lookup',
  { q: 'signed' },
  'original-signature',
  'provider-id'
);
const signedInput = [call('client-id'), result('client-id')];
const signed = gemini.responsesHistoryToGemini(
  { tools: [tool] },
  { history: parseResponsesHistory(signedInput, deps) },
  'gemini-2.5-pro'
).request;
assert.equal(signed.contents[0].parts[0].functionCall.id, 'provider-id');
assert.equal(signed.contents[0].parts[0].thoughtSignature, 'original-signature');
assert.equal(signed.contents[1].parts[0].functionResponse.id, 'provider-id');
const orphanInput = [call('old'), { role: 'user', content: 'new turn' }, result('old', [media])];
const orphan = gemini.responsesHistoryToGemini(
  { tools: [tool] },
  { history: parseResponsesHistory(orphanInput, deps) },
  'gemini-2.5-pro'
).request;
assert.equal(
  orphan.contents.at(-1).parts.some((part) => part.functionResponse),
  false
);
assert.ok(orphan.contents.at(-1).parts.some((part) => part.inlineData));
const reason = { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] };
assert.equal(
  gemini.responsesHistoryToGemini(
    {},
    { history: parseResponsesHistory([reason], deps) },
    'gemini-2.5-pro'
  ).request.contents[0].parts[0].thought,
  true
);

function route(body, codeAssist = false) {
  let sent,
    error,
    requests = 0;
  const sendJsonError = (_res, status, value) => {
    error = { status, value };
  };
  const state = createResponsesState({ ...deps, sendJsonError, log: { info: noop, warn: noop } });
  state.rememberResponsesHistory('previous', {
    version: 2,
    history: parseResponsesHistory(input, deps),
  });
  const ctx = {
    ...deps,
    ...gemini,
    ...state,
    ...createRequestValidators({ sendJsonError }),
    sendJsonError,
    responsesToChatWithHistory: () => assert.fail('Chat history selected'),
    tryOpenAIChatToGemini: () => assert.fail('Chat Gemini mapper selected'),
    openAIChatToClaudeMessages: () => assert.fail('Chat Claude mapper selected'),
    claudeMessagesToGemini: () => assert.fail('Claude Gemini mapper selected'),
    parseProxyBody: () => body,
    shouldUseCodeAssistUpstream: () => codeAssist,
    codeAssistGenerateRequest: (_prepared, request) => ({
      target: new URL('http://fixture/v1'),
      body: { request },
    }),
    codeAssistUserAgent: () => 'fixture',
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
  createRouteHandlers(ctx).handleOpenAIResponsesToGeminiMessages(
    { method: 'POST', headers: {} },
    {},
    { rewriteTo: 'gemini-2.5-pro', buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', hostname: 'fixture', path: '/v1' },
    '',
    '/responses',
    Date.now()
  );
  return { sent: codeAssist ? sent?.request : sent, error, requests };
}
for (const codeAssist of [false, true]) {
  const routed = route(
    { previous_response_id: 'previous', input: 'continue', tools: [tool] },
    codeAssist
  );
  assert.equal(routed.requests, 1);
  assert.equal(routed.sent.contents[1].parts[0].functionCall.id, 'a-b');
  assert.ok(routed.sent.contents.at(-1).parts.at(-1).text.includes('continue'));
}
for (const codeAssist of [false, true]) {
  const compatible = route(
    {
      input: 'question',
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: false,
      prompt_cache_key: 'fixture-thread',
      reasoning: { effort: 'medium', context: 'all_turns' },
      text: { verbosity: 'low' },
    },
    codeAssist
  );
  assert.equal(compatible.requests, 1);
  assert.equal(compatible.sent.generationConfig.thinkingConfig.thinkingBudget, 4096);
}
for (const invalid of [
  { tools: {}, input: [] },
  { input: 'question', max_output_tokens: 'SECRET' },
  { input: 'question', top_p: 2 },
  { input: 'question', stream: 'SECRET' },
  { input: 'question', text: { format: 'SECRET' } },
  { input: 'question', text: { format: { type: 'text' } }, response_format: {} },
  { input: [{ ...reason, encrypted_content: 'SECRET' }] },
  { input: [{ ...call('x'), arguments: '{SECRET' }] },
  { previous_response_id: 'missing', input: [] },
  { input: 'question', include: ['reasoning.encrypted_content', 'SECRET'] },
  { input: 'question', prompt_cache_key: 'x'.repeat(65) },
  { input: 'question', reasoning: { effort: 'medium', context: 'SECRET' } },
  { input: 'question', text: { verbosity: 'SECRET' } },
]) {
  const routed = route(invalid);
  assert.equal(routed.requests, 0);
  assert.equal(routed.error.status, 400);
  assert.ok(!JSON.stringify(routed.error).includes('SECRET'));
}
process.stdout.write(
  `[responses-native-gemini-request.test] ok: ${comparisons} differential cases\n`
);
