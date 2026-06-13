const assert = require('assert');

const {
  applyGeminiCooldown,
  appendGeminiStreamBuffer,
  buildGeminiProxyRequestOptions,
  failGeminiStream,
  finishGeminiClaudeStream,
  geminiCooldownMessage,
  geminiRetryHeaders,
  geminiStreamFailurePayload,
  geminiUpstreamErrorEvent,
  logGeminiDirectError,
  normalizeGeminiStreamBufferMax,
  processGeminiStreamChunk,
  sendGeminiLocalCooldown,
} = require('../lib/proxy/handlers/route-gemini-utils');

assert.strictEqual(normalizeGeminiStreamBufferMax('bad'), 1024 * 1024);
assert.strictEqual(normalizeGeminiStreamBufferMax(-1), 1);
assert.strictEqual(normalizeGeminiStreamBufferMax(Infinity), 1024 * 1024);

assert.deepStrictEqual(
  buildGeminiProxyRequestOptions({
    target: { protocol: 'https:', hostname: 'gemini.example.test', port: '443' },
    useCodeAssist: false,
    path: '/v1beta/models/gemini:generateContent',
    headers: { 'content-type': 'application/json' },
    env: { TARGET: '127.0.0.1', TARGET_PORT: '70000' },
  }),
  {
    hostname: '127.0.0.1',
    port: 443,
    path: '/v1beta/models/gemini:generateContent',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    timeout: 600000,
  }
);

assert.deepStrictEqual(
  buildGeminiProxyRequestOptions({
    target: { protocol: 'http:', hostname: 'gemini.example.test', port: 'bad' },
    useCodeAssist: false,
    path: '/v1beta/models/gemini:streamGenerateContent?alt=sse',
    headers: {},
    env: { TARGET_PORT: '-1' },
    timeout: 1000,
  }),
  {
    hostname: 'gemini.example.test',
    port: 80,
    path: '/v1beta/models/gemini:streamGenerateContent?alt=sse',
    method: 'POST',
    headers: {},
    timeout: 1000,
  }
);

assert.deepStrictEqual(
  buildGeminiProxyRequestOptions({
    target: { protocol: 'https:', hostname: 'polluted.example.test', port: '443' },
    useCodeAssist: true,
    codeAssist: { target: { hostname: 'codeassist.example.test', port: '9443' } },
    path: '/v1internal:generateContent',
    headers: { 'user-agent': 'code-assist' },
    env: { TARGET: '127.0.0.1', TARGET_PORT: '1234' },
  }),
  {
    hostname: 'codeassist.example.test',
    port: 9443,
    path: '/v1internal:generateContent',
    method: 'POST',
    headers: { 'user-agent': 'code-assist' },
    timeout: 600000,
  }
);

const state = {};
appendGeminiStreamBuffer(state, 'abc', 5);
assert.strictEqual(state.buffer, 'abc');
appendGeminiStreamBuffer(state, 'de', 5);
assert.strictEqual(state.buffer, 'abcde');
assert.throws(() => appendGeminiStreamBuffer(state, 'f', 5), /Gemini SSE event too large/);
assert.strictEqual(state.buffer, '', 'oversized Gemini stream buffer is cleared');

const processedEvents = [];
const streamState = { buffer: '', tools: [{ name: 'tool' }], usage: { input_tokens: 1 } };
processGeminiStreamChunk({
  sink: 'sink',
  state: streamState,
  chunkText: 'data: one\n\npartial',
  maxChars: 100,
  targetModel: 'gemini-test',
  unwrapEvent: (event) => event.replace(/^data: /, 'unwrapped: '),
  processGeminiSseEvent(sink, event, state, targetModel) {
    processedEvents.push({ sink, event, state, targetModel });
  },
});
assert.strictEqual(streamState.buffer, 'partial');
assert.deepStrictEqual(processedEvents, [
  {
    sink: 'sink',
    event: 'unwrapped: one',
    state: streamState,
    targetModel: 'gemini-test',
  },
]);
processGeminiStreamChunk({
  sink: 'sink',
  state: streamState,
  chunkText: ' event\n\n',
  maxChars: 100,
  targetModel: 'gemini-test',
  processGeminiSseEvent(sink, event, state, targetModel) {
    processedEvents.push({ sink, event, state, targetModel });
  },
});
assert.strictEqual(streamState.buffer, '');
assert.strictEqual(processedEvents[1].event, 'partial event');

const finishCalls = [];
const finishState = {
  buffer: 'tail event',
  tools: [{ name: 'tool' }],
  textOpen: true,
  textIndex: 2,
  usage: { input_tokens: 2, output_tokens: 3 },
  stopReason: 'end_turn',
  hasToolUse: false,
};
finishGeminiClaudeStream({
  sink: 'finish-sink',
  state: finishState,
  targetModel: 'gemini-finish',
  unwrapEvent: (event) => 'wrapped:' + event,
  processGeminiSseEvent(sink, event, state, targetModel) {
    finishCalls.push({ type: 'event', sink, event, state, targetModel });
  },
  flushPendingGeminiToolCall(sink, state, tools) {
    finishCalls.push({ type: 'flush', sink, tools });
  },
  writeClaudeSseEvent(sink, eventName, payload) {
    finishCalls.push({ type: 'write', sink, eventName, payload });
  },
  geminiClaudeStopReason() {
    return 'end_turn';
  },
});
assert.deepStrictEqual(
  finishCalls.map((call) => call.type),
  ['event', 'flush', 'write', 'write', 'write']
);
assert.strictEqual(finishCalls[0].event, 'wrapped:tail event');
assert.strictEqual(finishCalls[2].eventName, 'content_block_stop');
assert.strictEqual(finishCalls[3].payload.usage, finishState.usage);
assert.strictEqual(finishCalls[4].eventName, 'message_stop');

assert.deepStrictEqual(geminiStreamFailurePayload(new Error('boom')), {
  error: {
    type: 'upstream_response_too_large',
    message: 'boom',
  },
});

let jsonErrorCall = null;
let logEndCall = null;
let destroyed = false;
failGeminiStream({
  clientReq: { method: 'POST' },
  clientRes: {
    headersSent: false,
  },
  proxyRes: {
    destroy() {
      destroyed = true;
    },
  },
  upstreamPath: '/v1/messages',
  startTime: 123,
  err: new Error('too big'),
  sendJsonError(res, statusCode, body) {
    jsonErrorCall = { res, statusCode, body };
  },
  logRequestEnd(method, path, startTime, statusCode, meta) {
    logEndCall = { method, path, startTime, statusCode, meta };
  },
});
assert.strictEqual(destroyed, true);
assert.strictEqual(jsonErrorCall.statusCode, 502);
assert.strictEqual(jsonErrorCall.body.error.message, 'too big');
assert.strictEqual(logEndCall.meta.type, 'gemini_stream_response_too_large');

const writes = [];
let ended = false;
failGeminiStream({
  clientReq: { method: 'GET' },
  clientRes: {
    headersSent: true,
    write(chunk) {
      writes.push(chunk);
    },
    end() {
      ended = true;
    },
  },
  proxyRes: null,
  upstreamPath: '/v1beta/models',
  startTime: 456,
  err: null,
  sendJsonError() {
    throw new Error('sendJsonError should not be called after headers are sent');
  },
  logRequestEnd() {},
});
assert.strictEqual(ended, true);
assert.ok(writes[0].includes(': proxy-error '));
assert.ok(writes[0].includes('Gemini stream response is too large'));

assert.strictEqual(
  geminiCooldownMessage(12),
  'Gemini rate limit cooldown active. Please retry in 12s.'
);
assert.deepStrictEqual(geminiRetryHeaders({ existing: '1' }, 429, 37), {
  existing: '1',
  'retry-after': '37',
});
assert.deepStrictEqual(geminiRetryHeaders({ existing: '1' }, 429, null), { existing: '1' });
assert.deepStrictEqual(geminiRetryHeaders(null, 500, 12), {});

let cooldownCall = null;
assert.strictEqual(
  applyGeminiCooldown({
    statusCode: 429,
    retryAfterSeconds: null,
    profileId: 'profile-a',
    targetModel: 'gemini-test',
    setGeminiCooldown(profileId, targetModel, seconds) {
      cooldownCall = { profileId, targetModel, seconds };
    },
  }),
  45
);
assert.deepStrictEqual(cooldownCall, {
  profileId: 'profile-a',
  targetModel: 'gemini-test',
  seconds: 45,
});
assert.strictEqual(
  applyGeminiCooldown({
    statusCode: 500,
    retryAfterSeconds: 20,
    profileId: 'profile-a',
    targetModel: 'gemini-test',
    setGeminiCooldown() {
      throw new Error('setGeminiCooldown should not be called for non-429 responses');
    },
  }),
  null
);

const localCooldownWarnings = [];
let rateLimitCall = null;
assert.strictEqual(
  sendGeminiLocalCooldown({
    clientReq: { method: 'POST' },
    clientRes: { id: 'res' },
    upstreamPath: '/v1/messages',
    startTime: 789,
    targetModel: 'gemini-test',
    cooldown: { retryAfterSeconds: 9 },
    log: {
      warn(message) {
        localCooldownWarnings.push(message);
      },
    },
    sendGeminiRateLimit(...args) {
      rateLimitCall = args;
    },
  }),
  true
);
assert.ok(localCooldownWarnings[0].includes('source=local_cooldown target=gemini-test'));
assert.strictEqual(rateLimitCall[5], 9);
assert.strictEqual(rateLimitCall[6], 'Gemini rate limit cooldown active. Please retry in 9s.');
assert.deepStrictEqual(rateLimitCall[7], { source: 'local_cooldown' });
assert.strictEqual(
  sendGeminiLocalCooldown({
    cooldown: null,
    log: { warn() {} },
    sendGeminiRateLimit() {},
  }),
  false
);

const geminiError = {
  type: 'rate_limit_error',
  status: 'RESOURCE_EXHAUSTED',
  retryAfterSeconds: 11,
  quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests',
  quotaId: 'GenerateRequestsPerMinute',
};
assert.deepStrictEqual(
  geminiUpstreamErrorEvent({ method: 'POST' }, '/v1beta/models/x', 429, geminiError, {
    quotaMetric: geminiError.quotaMetric,
    quotaId: geminiError.quotaId,
  }),
  {
    method: 'POST',
    path: '/v1beta/models/x',
    code: 429,
    type: 'gemini',
    errorType: 'rate_limit_error',
    status: 'RESOURCE_EXHAUSTED',
    retryAfterSeconds: 11,
    quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests',
    quotaId: 'GenerateRequestsPerMinute',
  }
);

const directWarnings = [];
logGeminiDirectError({
  clientReq: { method: 'POST' },
  upstreamPath: '/v1beta/models/x',
  statusCode: 429,
  targetModel: 'gemini-test',
  geminiError,
  cooldownSeconds: 11,
  log: {
    warn(message) {
      directWarnings.push(message);
    },
  },
});
assert.ok(directWarnings[0].includes('retry_after=11s metric=GenerateRequestsPerMinute'));
logGeminiDirectError({
  clientReq: { method: 'GET' },
  upstreamPath: '/v1beta/models/x',
  statusCode: 500,
  targetModel: 'gemini-test',
  geminiError: { message: 'line one\nline two'.repeat(50) },
  cooldownSeconds: null,
  log: {
    warn(message) {
      directWarnings.push(message);
    },
  },
});
assert.ok(directWarnings[1].includes('gemini error GET /v1beta/models/x -> 500 message='));
assert.ok(directWarnings[1].length < 600);

console.log('[route-gemini-utils.test] ok');
