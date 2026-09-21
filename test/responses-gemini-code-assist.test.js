'use strict';

const assert = require('assert');
const {
  createRouteHandlers,
  _internal: routeHandlerInternals,
} = require('../lib/proxy/handlers/route-handlers');
const { createCodeAssist } = require('../lib/proxy/handlers/code-assist');

let capturedOptions = null;
let capturedBody = null;
let parsedStream = false;
let parsedInput = 'hello';
let requestedStream = null;
let convertedClaudeBody = null;
const fallbackId = () => 'test-id';
const codeAssist = createCodeAssist({ fallbackId });
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
  fallbackId,
  stableCreated: () => 0,
  sendGeminiRateLimit: noop,
  writeClaudeSseEvent: noop,
  openAIChatToClaudeMessages: () => ({ messages: [], tools: [] }),
  claudeMessagesToGemini: (body) => {
    convertedClaudeBody = body;
    return {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      ...(body.__responsesToolPreamble === true
        ? {
            systemInstruction: { parts: [{ text: 'preamble before functionCall' }] },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'exec',
                    description: 'Run code',
                    parameters: { type: 'OBJECT', properties: { input: { type: 'STRING' } } },
                  },
                ],
              },
            ],
          }
        : {}),
    };
  },
  geminiGeneratePath: () => {
    throw new Error('direct Gemini path must not be used for Google official login');
  },
  writeJsonResponse: noop,
  parseProxyBody: () => ({
    model: 'gemini-3.5-flash',
    input: parsedInput,
    stream: parsedStream,
  }),
  upstreamRequestOptions: () => {
    throw new Error('legacy direct request options must not be used for Code Assist');
  },
  onProxyTimeout: () => noop,
  onProxyError: () => noop,
  parseJsonOrSseJson: JSON.parse,
  shouldUseCodeAssistUpstream: () => true,
  codeAssistUserAgent: codeAssist.codeAssistUserAgent,
  codeAssistGenerateRequest: (prepared, body, model, stream) => {
    requestedStream = stream;
    return codeAssist.codeAssistGenerateRequest(prepared, body, model, stream);
  },
  unwrapCodeAssistResponse: (payload) => (payload && payload.response ? payload.response : payload),
  unwrapCodeAssistSseEvent: (event) => event,
  collectBoundedResponse: noop,
  responsesToChatWithHistory: () => ({
    model: 'gemini-3.5-flash',
    messages: [],
    stream: parsedStream,
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
    googleOfficialProjectId: 'test-project',
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
assert.strictEqual(capturedOptions.headers['user-agent'], 'antigravity-cli/diagnostic');
assert.deepStrictEqual(JSON.parse(capturedBody.toString('utf8')), {
  model: 'gemini-3.5-flash-low',
  project: 'test-project',
  user_prompt_id: 'test-id',
  request: {
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    systemInstruction: { parts: [{ text: 'preamble before functionCall' }] },
    tools: [
      {
        functionDeclarations: [
          {
            name: 'exec',
            description: 'Run code',
            parameters: { type: 'OBJECT', properties: { input: { type: 'STRING' } } },
          },
        ],
      },
    ],
  },
});
assert.strictEqual(requestedStream, false);
assert.strictEqual(convertedClaudeBody.__responsesToolPreamble, true);

parsedStream = true;
handlers.handleOpenAIResponsesToGeminiMessages(
  { method: 'POST', url: '/v1/responses' },
  {},
  {
    model: 'gemini-3.5-flash',
    rewriteTo: 'gemini-3.5-flash',
    profile: { id: 'google-official', protocol: 'gemini' },
    authMode: 'official-login',
    authProvider: 'google',
    googleOfficialProjectId: 'test-project',
    buffer: Buffer.from('{"stream":true}'),
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
assert.strictEqual(requestedStream, true);
assert.strictEqual(capturedOptions.path, '/v1internal:streamGenerateContent?alt=sse');

parsedInput = [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }];
parsedStream = false;
convertedClaudeBody = null;
capturedBody = null;
handlers.handleOpenAIResponsesToGeminiMessages(
  { method: 'POST', url: '/v1/responses' },
  {},
  {
    model: 'gemini-3.5-flash',
    rewriteTo: 'gemini-3.5-flash',
    profile: { id: 'google-official', protocol: 'gemini' },
    authMode: 'official-login',
    authProvider: 'google',
    googleOfficialProjectId: 'test-project',
    buffer: Buffer.from(
      '{"input":[{"type":"function_call_output","call_id":"call_1","output":"ok"}]}'
    ),
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
assert.notStrictEqual(convertedClaudeBody.__responsesToolPreamble, true);
assert.deepStrictEqual(JSON.parse(capturedBody.toString('utf8')).request, {
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
});

const longEnglishPrefix = 'a'.repeat(25000);
assert.strictEqual(
  routeHandlerInternals.responsesToolPreambleText({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: longEnglishPrefix }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续看看' }] },
    ],
  }),
  '我先看一下。'
);

console.log('[responses-gemini-code-assist.test] ok');
