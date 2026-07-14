'use strict';

const assert = require('assert');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');

let capturedOptions = null;
let capturedBody = null;
const request = {
  on() {
    return this;
  },
  end(body) {
    capturedBody = body;
  },
};
const https = {
  request(options) {
    capturedOptions = options;
    return request;
  },
};
const noop = () => {};
const handlers = createRouteHandlers({
  https,
  http: https,
  log: { info: noop, warn: noop, error: noop },
  CORS_HEADERS: {},
  sendJsonError: noop,
  sendUpstreamError: noop,
  logRequestEnd: noop,
  logProxyEvent: noop,
  fallbackId: () => 'test-id',
  stableCreated: () => 0,
  sendGeminiRateLimit: noop,
  writeClaudeSseEvent: noop,
  openAIChatToClaudeMessages: () => ({ messages: [], tools: [] }),
  claudeMessagesToGemini: () => ({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }),
  geminiGeneratePath: () => {
    throw new Error('direct Gemini path must not be used for Google official login');
  },
  writeJsonResponse: noop,
  parseProxyBody: () => ({
    model: 'gemini-3.5-flash',
    input: 'hello',
    stream: false,
  }),
  upstreamRequestOptions: () => {
    throw new Error('legacy direct request options must not be used for Code Assist');
  },
  onProxyTimeout: () => noop,
  onProxyError: () => noop,
  parseJsonOrSseJson: JSON.parse,
  shouldUseCodeAssistUpstream: () => true,
  codeAssistUserAgent: () => 'antigravity-cli/test',
  codeAssistGenerateRequest: () => ({
    target: new URL('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent'),
    body: {
      model: 'gemini-3.5-flash-low',
      project: 'test-project',
      request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    },
  }),
  unwrapCodeAssistResponse: (payload) => (payload && payload.response ? payload.response : payload),
  unwrapCodeAssistSseEvent: (event) => event,
  collectBoundedResponse: noop,
  responsesToChatWithHistory: () => ({
    model: 'gemini-3.5-flash',
    messages: [],
    stream: false,
  }),
  rememberResponsesFromChatResponse: noop,
  rememberResponsesFromBridge: noop,
  rejectUnsupportedResponsesNonOpenAIConversion: () => false,
  protocolOptions: {},
});

handlers.handleOpenAIResponsesToGeminiMessages(
  { method: 'POST', url: '/v1/responses' },
  {},
  {
    model: 'gemini-3.5-flash',
    rewriteTo: 'gemini-3.5-flash',
    profile: { id: 'google-official', protocol: 'gemini' },
    authMode: 'official-login',
    authProvider: 'google',
    buffer: Buffer.from('{}'),
  },
  {
    protocol: 'https:',
    hostname: 'generativelanguage.googleapis.com',
    port: '443',
    path: '/v1beta',
  },
  'ya29.test-token',
  '/v1beta/responses',
  Date.now()
);

assert.strictEqual(capturedOptions.hostname, 'daily-cloudcode-pa.googleapis.com');
assert.strictEqual(capturedOptions.path, '/v1internal:generateContent');
assert.strictEqual(capturedOptions.headers.authorization, 'Bearer ya29.test-token');
assert.strictEqual(capturedOptions.headers['user-agent'], 'antigravity-cli/test');
assert.deepStrictEqual(JSON.parse(capturedBody.toString('utf8')), {
  model: 'gemini-3.5-flash-low',
  project: 'test-project',
  request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
});

console.log('[responses-gemini-code-assist.test] ok');
