'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');

const noop = () => {};
let capturedBody = null;
let upstreamCallback = null;
let jsonResponse = null;
let convertedChatPayload = null;
let remembered = null;

const proxyRequest = {
  on() {
    return this;
  },
  end(body) {
    capturedBody = body;
  },
};

const transport = {
  request(_options, callback) {
    upstreamCallback = callback;
    return proxyRequest;
  },
};

function sendJsonError(_res, statusCode, payload) {
  jsonResponse = { statusCode, payload };
}

function writeJsonResponse(_res, statusCode, payload) {
  jsonResponse = { statusCode, payload };
}

const handlers = createRouteHandlers({
  https: transport,
  http: transport,
  log: { info: noop, warn: noop, error: noop },
  CORS_HEADERS: {},
  sendJsonError,
  sendUpstreamError: noop,
  logRequestEnd: noop,
  logProxyEvent: noop,
  fallbackId: () => 'workbuddy-stream-policy',
  stableCreated: () => 99,
  sendGeminiRateLimit: noop,
  writeClaudeSseEvent: noop,
  processOpenAISseChunkToClaude: noop,
  flushOpenAISseToClaude: noop,
  processClaudeSseChunkToOpenAI: noop,
  flushClaudeSseToOpenAI: noop,
  processOpenAIResponsesSseChunkToChat: noop,
  flushOpenAIResponsesSseToChat: noop,
  processOpenAIChatSseChunkToResponses: noop,
  processGeminiSseEvent: noop,
  flushPendingGeminiToolCall: noop,
  sampleResponseChunk: noop,
  claudeMessagesToOpenAIChat: noop,
  openAIResponseToClaudeMessage: noop,
  openAIChatToClaudeMessages: noop,
  claudeResponseToOpenAIChat: noop,
  openAIChatToResponsesRequest: noop,
  openAIResponsesToChatResponse: noop,
  openAIChatToResponses(payload, model) {
    convertedChatPayload = payload;
    return {
      id: 'resp-workbuddy-stream-policy',
      object: 'response',
      status: 'completed',
      model,
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: payload.choices[0].message.content }],
        },
      ],
    };
  },
  claudeMessagesToGemini: noop,
  geminiInlineImageToClaudeBlock: noop,
  geminiGeneratePath: noop,
  geminiResponseToClaude: noop,
  parseGeminiError: noop,
  parseRetryAfterHeaderSeconds: () => null,
  getGeminiCooldown: () => null,
  setGeminiCooldown: noop,
  getUpstreamCooldown: () => null,
  setUpstreamCooldown: noop,
  writeJsonResponse,
  parseProxyBody: () => ({
    model: 'workbuddy/deepseek-v4.1-flash',
    input: 'ping',
    stream: false,
  }),
  upstreamRequestOptions: (_target, path, headers) => ({ path, headers }),
  onProxyTimeout: () => noop,
  onProxyError: () => noop,
  parseJsonOrSseJson: JSON.parse,
  shouldUseCodeAssistUpstream: () => false,
  codeAssistUserAgent: () => 'test',
  codeAssistGenerateRequest: noop,
  unwrapCodeAssistResponse: noop,
  unwrapCodeAssistSseEvent: (event) => event,
  collectBoundedResponse: noop,
  createChatToResponsesBridge: noop,
  responsesToChatWithHistory: () => ({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'ping' }],
    stream: false,
  }),
  rememberResponsesFromChatResponse(response, chatBody, chatPayload) {
    remembered = { response, chatBody, chatPayload };
  },
  rememberResponsesFromBridge: noop,
  rejectUnsupportedResponsesConversion: () => false,
  rejectUnsupportedResponsesNonOpenAIConversion: () => false,
  rejectUnsupportedOpenAIChatNonOpenAIConversion: () => false,
  maxConversionResponseBytes: 4096,
  protocolOptions: {},
});

const clientRes = {
  headersSent: false,
  writeHead() {
    assert.fail('non-stream Responses client must not receive SSE headers');
  },
  write() {
    assert.fail('non-stream Responses client must not receive SSE chunks');
  },
  end() {},
};

handlers.handleOpenAIResponsesToOpenAIChat(
  { method: 'POST', url: '/v1/responses' },
  clientRes,
  {
    buffer: Buffer.from('{}'),
    rewriteTo: 'deepseek-v4.1-flash',
    profile: { id: 'workbuddy-official', protocol: 'workbuddy' },
  },
  { protocol: 'https:', hostname: 'example.test', port: 443, path: '/v2' },
  'token-not-logged',
  '/v2/responses',
  123
);

assert.strictEqual(JSON.parse(capturedBody.toString('utf8')).stream, true);

const proxyRes = new EventEmitter();
proxyRes.statusCode = 200;
proxyRes.headers = { 'content-type': 'text/event-stream' };
proxyRes.destroy = noop;
upstreamCallback(proxyRes);
proxyRes.emit(
  'data',
  Buffer.from(
    'data: {"id":"chatcmpl-workbuddy","object":"chat.completion.chunk","created":99,' +
      '"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},' +
      '"finish_reason":null}]}\n\n'
  )
);
proxyRes.emit(
  'data',
  Buffer.from(
    'data: {"id":"chatcmpl-workbuddy","object":"chat.completion.chunk","created":99,' +
      '"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"Pong!"},' +
      '"finish_reason":null}]}\n\n'
  )
);
proxyRes.emit(
  'data',
  Buffer.from(
    'data: {"id":"chatcmpl-workbuddy","object":"chat.completion.chunk","created":99,' +
      '"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},' +
      '"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  )
);
proxyRes.emit('end');

assert.strictEqual(jsonResponse.statusCode, 200);
assert.strictEqual(jsonResponse.payload.object, 'response');
assert.strictEqual(jsonResponse.payload.output[0].content[0].text, 'Pong!');
assert.strictEqual(convertedChatPayload.object, 'chat.completion');
assert.strictEqual(convertedChatPayload.choices[0].message.content, 'Pong!');
assert.strictEqual(remembered.chatBody.stream, true);
assert.strictEqual(remembered.chatPayload, convertedChatPayload);

console.log('[workbuddy-responses-stream-policy.test] ok');
