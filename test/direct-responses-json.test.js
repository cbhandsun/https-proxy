'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseJsonOrSseJson: safeParse } =
  require('../lib/proxy/handlers/http-utils').createHttpUtils({});
assert.throws(
  () => safeParse('{"do-not-leak":broken}'),
  (error) => error instanceof TypeError && !error.message.includes('do-not-leak')
);
assert.deepEqual(safeParse('{"ok":true}'), { ok: true });
const rootSource = fs.readFileSync(
  require('node:path').join(__dirname, '..', 'openai-proxy.js'),
  'utf8'
);
assert.match(
  rootSource,
  /createProxyHandlers\(\{\s*\.\.\.openAIProtocol,\s*\.\.\.geminiProtocol,\s*createGeminiResponsesStream,/
);
assert.match(rootSource, /const geminiProtocol = createGeminiProtocol\(\{/);
const { createHash } = require('node:crypto');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const tools = require('../lib/proxy/tools');
const {
  createGeminiJsonResponseHandlers,
} = require('../lib/proxy/handlers/gemini-json-response-handlers');
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const deps = {
  ...tools,
  stableHash: hash,
  fallbackId: (prefix, value) => prefix + '_' + hash(value),
  stableCreated: () => 123,
  isClaudeThinkingBlock: (part) => ['thinking', 'redacted_thinking'].includes(part.type),
  filterClaudeCompatibleBlocks: (parts) => parts,
  sampleGeminiToolEvent: () => {},
};
function protocols(extra = {}) {
  const config = { ...deps, ...extra };
  return { ai: createOpenAIProtocol(config), gemini: createGeminiProtocol(config) };
}
const { ai, gemini } = protocols();
const claudePayload = (content = [], stop_reason = 'end_turn') => ({
  id: 'msg_fixture',
  content,
  stop_reason,
  usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
});
const geminiPayload = (parts = [], finishReason = 'STOP') => ({
  candidates: [{ content: { parts }, finishReason }],
  usageMetadata: {
    promptTokenCount: 12,
    candidatesTokenCount: 5,
    thoughtsTokenCount: 2,
    cachedContentTokenCount: 3,
    totalTokenCount: 19,
  },
});
const tool = { type: 'tool_use', name: 'lookup', id: 'toolu_fixture', input: { q: '中文 😀' } };
const directGemini = (input, request = {}, protocol = { ai, gemini }, other = {}) =>
  protocol.gemini.geminiResponseToResponses(input, 'fixture', [], {
    buildResponse: protocol.ai.buildResponsesResponse,
    clientModel: 'client',
    request,
    responsesToolPreambleText: 'Working.',
    ...other,
  });
for (const content of [
  [],
  [{ type: 'text', text: '中文 😀\\\n"' }],
  [
    { type: 'thinking', thinking: 'reason' },
    { type: 'text', text: 'answer' },
  ],
  [tool],
  [{ type: 'text', text: 'before' }, tool, { type: 'text', text: 'after' }],
  [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }],
]) {
  for (const request of [{}, { tools: [{ type: 'custom', name: 'lookup' }] }]) {
    const input = claudePayload(content);
    assert.deepEqual(
      ai.claudeResponseToResponses(input, 'client', request),
      ai.openAIChatToResponses(ai.claudeResponseToOpenAIChat(input, 'client'), 'client', request)
    );
  }
}
for (const parts of [
  [],
  [{ text: '中文 😀' }],
  [{ thought: true, text: 'reason' }, { text: 'answer' }],
  [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
  [{ functionCall: { name: 'lookup', args: { q: '中文' } }, thoughtSignature: 'signature' }],
  [{ text: 'before' }, { functionCall: { name: 'lookup', args: '{"q":1}' } }],
]) {
  for (const request of [{}, { tools: [{ type: 'custom', name: 'lookup' }] }]) {
    const input = geminiPayload(parts);
    const legacy = ai.openAIChatToResponses(
      ai.claudeResponseToOpenAIChat(
        gemini.geminiResponseToClaude(input, 'fixture', [], {
          responsesToolPreambleText: 'Working.',
        }),
        'client'
      ),
      'client',
      request
    );
    assert.deepEqual(directGemini(input, request), legacy);
  }
}
for (const [stop, status, reason] of [
  ['max_tokens', 'incomplete', 'max_output_tokens'],
  ['model_context_window_exceeded', 'incomplete', 'max_output_tokens'],
  ['refusal', 'incomplete', 'content_filter'],
  ['pause_turn', 'completed'],
  ['OTHER', 'failed'],
  [undefined, 'failed'],
]) {
  const input = claudePayload([tool]);
  input.stop_reason = stop;
  const result = ai.claudeResponseToResponses(input, 'client');
  assert.equal(result.status, status);
  assert.equal(result.output.length, 0);
  if (reason) assert.equal(result.incomplete_details.reason, reason);
}
for (const [finish, status] of [
  ['MAX_TOKENS', 'incomplete'],
  ['SAFETY', 'incomplete'],
  ['SPII', 'incomplete'],
  ['MALFORMED_FUNCTION_CALL', 'failed'],
  ['OTHER', 'failed'],
  [undefined, 'failed'],
]) {
  const input = geminiPayload([{ functionCall: { name: 'lookup', args: { q: 1 } } }]);
  input.candidates[0].finishReason = finish;
  const result = directGemini(input);
  assert.equal(result.status, status);
  assert.equal(
    result.output.some((part) => part.type === 'function_call'),
    false
  );
}
for (const input of [
  null,
  [],
  {},
  { error: { message: 'do-not-leak' }, candidates: [] },
  { candidates: [] },
  { candidates: [null] },
  { candidates: [{ content: false }] },
  geminiPayload([null]),
  geminiPayload([{ text: 4 }]),
  geminiPayload([{ thought: 'yes' }]),
  geminiPayload([{ functionCall: [] }]),
  geminiPayload([{ functionCall: { name: 'lookup', args: '[1]' } }]),
  geminiPayload([{ functionCall: { name: 'lookup', args: '{do-not-leak' } }]),
  geminiPayload([{ functionCall: { name: 'lookup', args: {}, willContinue: 'yes' } }]),
  geminiPayload([{ functionCall: { name: 'lookup', args: {}, partialArgs: {} } }]),
]) {
  assert.throws(
    () => directGemini(input),
    (error) => !error.message.includes('do-not-leak')
  );
}
for (const input of [
  null,
  [],
  {},
  claudePayload([null]),
  claudePayload([{ type: 'text', text: 42 }]),
  claudePayload([{ type: 'thinking', thinking: {} }]),
])
  assert.throws(() => ai.claudeResponseToResponses(input, 'client'));
for (const input of [[], null, 'bad']) {
  const result = ai.claudeResponseToResponses(claudePayload([{ ...tool, input }]), 'client');
  assert.equal(result.status, 'failed');
  assert.equal(result.output.length, 0);
}
for (const extra of [
  {
    cleanToolArgs: () => {
      throw new Error('do-not-leak');
    },
  },
  { cleanToolArgs: () => [] },
  { protocolOptions: { maxConversionToolArgumentBytes: 4 } },
  { protocolOptions: { maxConversionToolCalls: 1 } },
]) {
  const p = protocols(extra);
  const result = p.ai.claudeResponseToResponses(
    claudePayload([tool, { ...tool, id: 'toolu_two' }]),
    'client'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.output.length, 0);
  assert.equal(JSON.stringify(result).includes('do-not-leak'), false);
}
const expanding = protocols({
  cleanToolArgs: () => ({ q: 'x'.repeat(100) }),
  protocolOptions: { maxConversionToolArgumentBytes: 50 },
});
assert.equal(
  expanding.ai.claudeResponseToResponses(claudePayload([tool]), 'client').status,
  'failed'
);
const throwsSanitizer = protocols({
  sanitizeGeminiToolCall: () => {
    throw new Error('do-not-leak');
  },
});
assert.throws(
  () =>
    directGemini(
      geminiPayload([{ functionCall: { name: 'lookup', args: {} } }]),
      {},
      throwsSanitizer
    ),
  (error) => !error.message.includes('do-not-leak')
);
let converted;
let remembered;
const handlers = createGeminiJsonResponseHandlers({
  handleConvertedJsonResponse: (options) => {
    converted = options.convert(options.responseBody);
  },
  geminiResponseToResponses: gemini.geminiResponseToResponses,
  buildResponsesResponse: ai.buildResponsesResponse,
  rememberResponsesFromBridge: (bridge, history) => {
    remembered = { bridge, history };
  },
  unwrapCodeAssistResponse: (value) => value.response || value,
  parseJsonOrSseJson: JSON.parse,
});
const input = geminiPayload([{ text: 'answer' }]);
const history = { messages: [] };
handlers.handleResponsesToGeminiJson({
  proxyRes: { statusCode: 200 },
  clientReq: {},
  clientRes: { setHeader() {} },
  responseBody: JSON.stringify({ response: input }),
  targetModel: 'fixture',
  claudeBody: { tools: [] },
  parsed: { model: 'client' },
  chatBody: history,
});
assert.deepEqual(converted, directGemini(input));
assert.equal(remembered.history, history);
assert.deepEqual(remembered.bridge.responseState.completedOutputItems, converted.output);
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
let routeResult;
let routeRemembered;
const statuses = [];
const routePayload = claudePayload([{ type: 'text', text: 'answer' }]);
const noop = () => {};
const routes = createRouteHandlers({
  http: {
    request: (_options, callback) => {
      callback({ statusCode: 200, headers: {} });
      return { on() {}, end() {} };
    },
  },
  parseProxyBody: (_client, body) => JSON.parse(body),
  responsesToChatWithHistory: () => history,
  openAIChatToClaudeMessages: () => ({ messages: [], stream: false }),
  rejectUnsupportedResponsesNonOpenAIConversion: () => false,
  upstreamRequestOptions: () => ({}),
  collectBoundedResponse: (_upstream, _client, _path, _label, done) =>
    done(JSON.stringify(routePayload)),
  parseJsonOrSseJson: JSON.parse,
  claudeResponseToResponses: ai.claudeResponseToResponses,
  rememberResponsesFromBridge: (bridge) => {
    routeRemembered = bridge;
  },
  writeJsonResponse: (_client, status, value) => {
    routeResult = value;
    statuses.push(status);
  },
  logRequestEnd: noop,
  logProxyEvent: noop,
  log: noop,
  sendJsonError: (_client, status, value) => {
    routeResult = value;
    statuses.push(status);
  },
  onProxyTimeout: () => noop,
  onProxyError: () => noop,
});
routes.handleOpenAIResponsesToClaudeMessages(
  { headers: {}, method: 'POST' },
  {},
  { buffer: '{"model":"client"}', rewriteTo: '-' },
  { protocol: 'http:', path: '' },
  null,
  '/responses',
  0
);
assert.deepEqual(routeResult, ai.claudeResponseToResponses(routePayload, 'client'));
assert.deepEqual(statuses, [200]);
assert.deepEqual(routeRemembered.responseState.completedOutputItems, routeResult.output);

const writeTools = [
  { name: 'Write', input_schema: { type: 'object', required: ['file_path', 'content'] } },
  { name: 'Bash', input_schema: { type: 'object', required: ['command'] } },
];
const writeInput = geminiPayload([
  {
    functionCall: {
      name: 'Write',
      args: { file_path: 'E:/tmp/direct-response-fixture.js', content: 'x'.repeat(40000) },
    },
  },
]);
for (const declared of [writeTools, writeTools.slice(0, 1)]) {
  const legacyClaude = gemini.geminiResponseToClaude(writeInput, 'fixture', declared, {
    responsesToolPreambleText: 'Working.',
  });
  const result = gemini.geminiResponseToResponses(writeInput, 'fixture', declared, {
    buildResponse: ai.buildResponsesResponse,
    clientModel: 'client',
    responsesToolPreambleText: 'Working.',
  });
  assert.deepEqual(
    result,
    ai.openAIChatToResponses(ai.claudeResponseToOpenAIChat(legacyClaude, 'client'), 'client')
  );
}
const limited = protocols({ protocolOptions: { maxConversionStreamBytes: 2 } });
const limitedText = limited.ai.claudeResponseToResponses(
  claudePayload([{ type: 'text', text: 'abc' }]),
  'client'
);
assert.equal(limitedText.status, 'failed');
assert.equal(limitedText.output.length, 0);
assert.throws(
  () =>
    directGemini(
      geminiPayload([{ functionCall: { name: 'lookup', args: { q: 'abc' } } }]),
      {},
      limited
    ),
  /byte limit/
);
const stagedHash = hash({
  id: gemini.geminiClaudeToolId(writeInput.candidates[0].content.parts[0].functionCall, 0),
  file_path: 'E:/tmp/direct-response-fixture.js',
  content: 'x'.repeat(40000),
});
const stagedPath = require('node:path').join(
  require('node:os').tmpdir(),
  'hpm-claude-tool-payloads',
  stagedHash + '.payload'
);
assert.equal(fs.readFileSync(stagedPath, 'utf8').length, 40000);
fs.unlinkSync(stagedPath);

const filters = require('../lib/proxy/claude-filters').createClaudeFilters;
for (const thinkingPolicy of ['drop', 'placeholder', 'inject', 'passthrough']) {
  const filter = filters({ protocolOptions: { thinkingPolicy } });
  const p = protocols(filter);
  const input = claudePayload([
    { type: 'thinking', thinking: 'reason' },
    { type: 'text', text: 'answer' },
  ]);
  assert.deepEqual(
    p.ai.claudeResponseToResponses(input, 'client'),
    p.ai.openAIChatToResponses(p.ai.claudeResponseToOpenAIChat(input, 'client'), 'client')
  );
  assert.throws(() => p.ai.claudeResponseToResponses(claudePayload([null]), 'client'));
  assert.throws(() =>
    p.ai.claudeResponseToResponses(claudePayload([{ type: 'thinking', thinking: {} }]), 'client')
  );
}
for (const call of [false, { name: 'lookup', args: null }, { name: 'lookup', id: {}, args: {} }])
  assert.throws(() => directGemini(geminiPayload([{ functionCall: call }])));
console.log('[direct-responses-json.test] ok');
