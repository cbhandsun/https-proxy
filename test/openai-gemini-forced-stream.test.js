'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');

const noop = () => {};
let upstreamCallback;
let requestedStream;
let jsonResponse;
let convertedReasoningEffort;

const proxyRequest = {
  on() {
    return this;
  },
  end() {},
};
const transport = {
  request(_options, callback) {
    upstreamCallback = callback;
    return proxyRequest;
  },
};

function writeClaudeSseEvent(sink, event, payload) {
  sink.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const handlers = createRouteHandlers({
  https: transport,
  http: transport,
  log: { info: noop, warn: noop, error: noop },
  CORS_HEADERS: {},
  sendJsonError: (_res, statusCode, payload) => {
    jsonResponse = { statusCode, payload };
  },
  sendUpstreamError: noop,
  logRequestEnd: noop,
  logProxyEvent: noop,
  fallbackId: () => 'chat-forced-stream',
  stableCreated: () => 7,
  sendGeminiRateLimit: noop,
  writeClaudeSseEvent,
  processClaudeSseChunkToOpenAI(sink, chunk) {
    if (!chunk.includes('text_delta')) return;
    const dataLine = chunk.split(/\r?\n/).find((line) => line.startsWith('data:'));
    const payload = JSON.parse(dataLine.slice(5).trim());
    sink.write(
      'data: ' +
        JSON.stringify({
          id: 'chat-forced-stream',
          object: 'chat.completion.chunk',
          created: 7,
          model: 'gemini-test',
          choices: [{ index: 0, delta: { content: payload.delta.text }, finish_reason: null }],
        }) +
        '\n\n'
    );
  },
  flushClaudeSseToOpenAI(sink) {
    sink.write(
      'data: {"id":"chat-forced-stream","object":"chat.completion.chunk","created":7,"model":"gemini-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    );
    sink.write('data: [DONE]\n\n');
  },
  processGeminiSseEvent(sink, _event, state) {
    if (!state.textOpen) {
      state.textOpen = true;
      state.textIndex = 0;
      writeClaudeSseEvent(sink, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
    }
    state.usage = { input_tokens: 2, output_tokens: 1 };
    writeClaudeSseEvent(sink, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    });
  },
  flushPendingGeminiToolCall: noop,
  geminiClaudeStopReason: () => 'end_turn',
  sampleResponseChunk: noop,
  openAIChatToClaudeMessages: () => ({ messages: [], tools: [] }),
  claudeMessagesToGemini: (body) => {
    convertedReasoningEffort = body.reasoning_effort;
    return { contents: [] };
  },
  geminiGeneratePath: () => '/v1/models/gemini-test:streamGenerateContent',
  parseGeminiError: () => ({ type: 'api_error', message: 'error' }),
  getGeminiCooldown: () => null,
  setGeminiCooldown: noop,
  writeJsonResponse(_res, statusCode, payload) {
    jsonResponse = { statusCode, payload };
  },
  parseProxyBody: () => ({
    model: 'gemini-3.6-flash',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning_effort: 'high',
    stream: false,
  }),
  upstreamRequestOptions: noop,
  onProxyTimeout: () => noop,
  onProxyError: () => noop,
  parseJsonOrSseJson: JSON.parse,
  shouldUseCodeAssistUpstream: () => true,
  codeAssistUserAgent: () => 'test',
  codeAssistGenerateRequest: (_prepared, _body, _model, stream) => {
    requestedStream = stream;
    return {
      target: new URL('https://example.test/v1internal:streamGenerateContent?alt=sse'),
      body: { request: {} },
    };
  },
  unwrapCodeAssistResponse: (payload) => payload,
  unwrapCodeAssistSseEvent: (event) => event,
  collectBoundedResponse: noop,
  rejectUnsupportedOpenAIChatNonOpenAIConversion: () => false,
  maxConversionResponseBytes: 4096,
  protocolOptions: {},
});

const clientRes = {
  headersSent: false,
  writeHead() {
    assert.fail('forced upstream streaming must not expose SSE headers to a JSON client');
  },
  write() {
    assert.fail('forced upstream streaming must not expose SSE chunks to a JSON client');
  },
  end() {},
};

handlers.handleOpenAIChatToGeminiMessages(
  { method: 'POST', url: '/v1/chat/completions' },
  clientRes,
  {
    buffer: Buffer.from('{}'),
    forceUpstreamChatStreaming: true,
    model: 'gemini-3.6-flash',
    profile: { id: 'google-official', protocol: 'gemini' },
    rewriteTo: 'gemini-3.6-flash',
  },
  { protocol: 'https:', hostname: 'example.test', port: 443, path: '/v1' },
  'token-not-logged',
  '/chat/completions',
  Date.now()
);

assert.strictEqual(requestedStream, true);
assert.strictEqual(convertedReasoningEffort, 'high');
const proxyRes = new EventEmitter();
proxyRes.statusCode = 200;
proxyRes.headers = { 'content-type': 'text/event-stream' };
proxyRes.destroy = noop;
upstreamCallback(proxyRes);
proxyRes.emit('data', Buffer.from('data: {"response":{}}\n\n'));
proxyRes.emit('end');

assert.strictEqual(jsonResponse.statusCode, 200);
assert.strictEqual(jsonResponse.payload.object, 'chat.completion');
assert.strictEqual(jsonResponse.payload.choices[0].message.content, 'Hello');
assert.deepStrictEqual(jsonResponse.payload.usage, {
  prompt_tokens: 2,
  completion_tokens: 1,
  total_tokens: 3,
});

console.log('[openai-gemini-forced-stream.test] ok');
