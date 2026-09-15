'use strict';

const assert = require('node:assert/strict');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { sendRateLimit } = require('../lib/proxy/local-handlers');

const noop = () => {};
const requestEnds = [];
const warnings = [];
let upstreamRequested = false;

function logRequestEnd(method, path, startTime, statusCode, meta) {
  requestEnds.push({ method, path, startTime, statusCode, meta });
}

const blockedTransport = {
  request() {
    upstreamRequested = true;
    throw new Error('cooldown requests must not reach upstream');
  },
};

const handlers = createRouteHandlers({
  https: blockedTransport,
  http: blockedTransport,
  log: {
    info: noop,
    warn(message) {
      warnings.push(message);
    },
    error: noop,
  },
  CORS_HEADERS: {},
  sendJsonError: noop,
  sendUpstreamError: noop,
  logRequestEnd,
  logProxyEvent: noop,
  fallbackId: () => 'cooldown-test',
  stableCreated: () => 10,
  sendGeminiRateLimit: noop,
  sendUpstreamRateLimit(
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    targetModel,
    retryAfterSeconds,
    message,
    meta
  ) {
    return sendRateLimit(
      clientReq,
      clientRes,
      upstreamPath,
      startTime,
      targetModel,
      retryAfterSeconds,
      message,
      meta,
      logRequestEnd,
      { type: 'upstream_rate_limit' }
    );
  },
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
  openAIChatToResponses: noop,
  claudeMessagesToGemini: noop,
  geminiInlineImageToClaudeBlock: noop,
  geminiGeneratePath: noop,
  geminiResponseToClaude: noop,
  parseGeminiError: noop,
  parseRetryAfterHeaderSeconds: () => null,
  getGeminiCooldown: () => null,
  setGeminiCooldown: noop,
  getUpstreamCooldown(profileId, targetModel) {
    assert.strictEqual(profileId, 'workbuddy-official');
    assert.strictEqual(targetModel, 'deepseek-v4.1-flash');
    return { retryAfterSeconds: 3661 };
  },
  setUpstreamCooldown: noop,
  writeJsonResponse: noop,
  parseProxyBody: () => ({ model: 'workbuddy/deepseek-v4.1-flash', input: 'hello' }),
  upstreamRequestOptions: noop,
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
  responsesToChatWithHistory() {
    throw new Error('cooldown requests must not be converted');
  },
  rememberResponsesFromChatResponse: noop,
  rememberResponsesFromBridge: noop,
  rejectUnsupportedResponsesConversion: () => false,
  rejectUnsupportedResponsesNonOpenAIConversion: () => false,
  rejectUnsupportedOpenAIChatNonOpenAIConversion: () => false,
  protocolOptions: {},
});

const clientRes = {
  statusCode: null,
  headers: null,
  body: '',
  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  },
  end(body) {
    this.body = body;
  },
};

function resetClientRes(res) {
  res.statusCode = null;
  res.headers = null;
  res.body = '';
}

handlers.handleOpenAIResponsesToOpenAIChat(
  { method: 'POST', url: '/v1/responses' },
  clientRes,
  {
    buffer: Buffer.from('{}'),
    rewriteTo: 'deepseek-v4.1-flash',
    profile: { id: 'workbuddy-official', protocol: 'workbuddy' },
  },
  { protocol: 'https:', path: '/v2' },
  'token',
  '/v2/responses',
  123
);

assert.strictEqual(upstreamRequested, false);
assert.strictEqual(clientRes.statusCode, 429);
assert.strictEqual(clientRes.headers['Retry-After'], '3661');
assert.strictEqual(JSON.parse(clientRes.body).error.type, 'rate_limit_error');
assert.ok(JSON.parse(clientRes.body).error.message.includes('1h1m'));
assert.ok(warnings[0].includes('source=local_cooldown target=deepseek-v4.1-flash'));
assert.deepStrictEqual(requestEnds, [
  {
    method: 'POST',
    path: '/v2/responses',
    startTime: 123,
    statusCode: 429,
    meta: {
      type: 'upstream_rate_limit',
      targetModel: 'deepseek-v4.1-flash',
      retryAfterSeconds: 3661,
      source: 'local_cooldown',
      profileId: 'workbuddy-official',
    },
  },
]);

requestEnds.length = 0;
warnings.length = 0;
upstreamRequested = false;
resetClientRes(clientRes);

handlers.handleOpenAIChatToOpenAIResponses(
  { method: 'POST', url: '/v1/chat/completions' },
  clientRes,
  {
    buffer: Buffer.from('{}'),
    rewriteTo: 'deepseek-v4.1-flash',
    profile: { id: 'workbuddy-official', protocol: 'workbuddy' },
  },
  { protocol: 'https:', path: '/v2' },
  'token',
  '/v2/chat/completions',
  456
);

assert.strictEqual(upstreamRequested, false);
assert.strictEqual(clientRes.statusCode, 429);
assert.strictEqual(clientRes.headers['Retry-After'], '3661');
assert.strictEqual(JSON.parse(clientRes.body).error.type, 'rate_limit_error');
assert.ok(JSON.parse(clientRes.body).error.message.includes('1h1m'));
assert.ok(warnings[0].includes('source=local_cooldown target=deepseek-v4.1-flash'));
assert.deepStrictEqual(requestEnds, [
  {
    method: 'POST',
    path: '/v2/chat/completions',
    startTime: 456,
    statusCode: 429,
    meta: {
      type: 'upstream_rate_limit',
      targetModel: 'deepseek-v4.1-flash',
      retryAfterSeconds: 3661,
      source: 'local_cooldown',
      profileId: 'workbuddy-official',
    },
  },
]);

console.log('[workbuddy-cooldown.test] ok');
