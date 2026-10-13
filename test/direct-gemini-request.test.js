'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const tools = require('../lib/proxy/tools');
function protocols(options = {}) {
  const config = {
    ...tools,
    ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'passthrough' } }),
    protocolOptions: options,
    fallbackId: (prefix) => prefix + '_fixture',
    stableHash: () => 'fixture',
    stableCreated: () => 1,
  };
  return { ai: createOpenAIProtocol(config), gemini: createGeminiProtocol(config) };
}
const functionTools = [
  {
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Find',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      strict: false,
    },
  },
];
const corpus = [
  [],
  [{ role: 'user', content: '中文 😀' }],
  [
    { role: 'system', content: '' },
    { role: 'user', content: 'hello' },
  ],
  [
    { role: 'system', content: 'A' },
    { role: 'developer', content: [{ type: 'text', text: 'B' }] },
    { role: 'user', content: 'hi' },
  ],
  [
    { role: 'user', content: 'a' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'b' },
        { type: 'text', text: '' },
        { type: 'text', text: 'c' },
      ],
    },
    { role: 'assistant', content: 'partial' },
  ],
  [
    { role: 'assistant', content: 'partial' },
    { role: 'user', content: [] },
  ],
];
let compared = 0;
for (const protocolOptions of [
  { contextWindowPolicy: 'disabled' },
  { maxContextTokens: 24000 },
  { maxContextTokens: 32000, providerCacheHintsPolicy: 'diagnostics-only' },
]) {
  const { ai, gemini } = protocols(protocolOptions);
  for (const model of ['gemini-2.5-pro', 'gemini-3.8-flash-tiered', 'gemini-3.1-flash-image']) {
    for (const messages of corpus) {
      for (const fields of [
        {},
        { tools: functionTools, tool_choice: 'required' },
        {
          tools: [...functionTools, ...functionTools],
          tool_choice: { type: 'function', function: { name: 'lookup' } },
        },
        {
          tools: functionTools,
          tool_choice: 'none',
          __nativeWebSearch: 'gemini-google-search',
          __managedWebSearchHistoryAsText: true,
        },
        { max_tokens: 4000, temperature: 0.2, top_p: 0.4, stop: ['END'] },
        { reasoning_effort: 'high', max_tokens: 20000 },
        { reasoning_effort: 'none' },
        { max_completion_tokens: 30, stop: 'DONE' },
      ]) {
        for (const outputOptions of [
          {},
          { codeAssist: true, requestedTokens: 50000 },
          { codeAssist: true, requestedTokens: 50000, recovery: true },
        ]) {
          const body = { messages, ...fields };
          const snapshot = JSON.stringify(body);
          if (body.reasoning_effort === 'none') {
            assert.throws(
              () => ai.openAIChatToClaudeMessages(body, model, { target: 'Gemini' }),
              (error) => error.code === 'invalid_request_error'
            );
            assert.throws(
              () =>
                gemini.tryOpenAIChatToGemini(body, model, outputOptions, { toolPreamble: true }),
              (error) => error.code === 'invalid_request_error'
            );
            assert.equal(JSON.stringify(body), snapshot);
            compared++;
            continue;
          }
          const old = ai.openAIChatToClaudeMessages(body, model, { target: 'Gemini' });
          old.reasoning_effort = body.reasoning_effort;
          old.__responsesToolPreamble = true;
          const baseline = gemini.claudeMessagesToGemini(old, model, outputOptions);
          const direct = gemini.tryOpenAIChatToGemini(body, model, outputOptions, {
            toolPreamble: true,
          });
          assert.ok(direct);
          assert.deepEqual(direct.request, baseline);
          assert.deepEqual(direct.request.__hpmDiagnostics, baseline.__hpmDiagnostics);
          assert.equal(JSON.stringify(body), snapshot);
          compared++;
        }
      }
    }
  }
}
const { ai, gemini } = protocols();
for (const message of [
  { role: 'tool', tool_call_id: 'call', content: 'done' },
  { role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: '{}' } }] },
  {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
  },
  { role: 'assistant', content: 'answer', reasoning_content: 'reason' },
])
  assert.ok(gemini.tryOpenAIChatToGemini({ messages: [message] }, 'gemini-3.8-flash'));
for (const body of [
  null,
  [],
  { messages: false },
  { messages: [null] },
  { messages: [{ role: 'unknown', content: 'do-not-leak' }] },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 42 }] }] },
  { tools: [{ type: 'function', function: { name: 'x', parameters: [] } }] },
  { tools: [{ type: 'function', function: { name: 'x', strict: true } }] },
])
  assert.throws(
    () => gemini.tryOpenAIChatToGemini(body, 'gemini-pro'),
    (error) => !error.message.includes('do-not-leak')
  );
const big = {
  messages: Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(4000),
  })),
  tools: functionTools,
  max_tokens: 4000,
};
const p = protocols({ maxContextTokens: 24000 });
const old = p.ai.openAIChatToClaudeMessages(big, 'gemini-pro');
old.reasoning_effort = big.reasoning_effort;
assert.deepEqual(
  p.gemini.tryOpenAIChatToGemini(big, 'gemini-pro').request,
  p.gemini.claudeMessagesToGemini(old, 'gemini-pro')
);
const root = fs.readFileSync(require('node:path').join(__dirname, '..', 'openai-proxy.js'), 'utf8');
assert.match(root, /createProxyHandlers\(\{\s*\.\.\.openAIProtocol,\s*\.\.\.geminiProtocol,/);
assert.match(root, /const geminiProtocol = createGeminiProtocol\(\{/);

const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const noop = () => {};
function runChatRoute(body, native) {
  let sent;
  let converted;
  let compatibilityCalls = 0;
  const transport = {
    request(_options, callback) {
      return {
        on: noop,
        end(wire) {
          sent = JSON.parse(wire);
          callback({ statusCode: 200, headers: {} });
        },
      };
    },
  };
  const ctx = {
    ...ai,
    ...gemini,
    stableCreated: () => 1,
    http: transport,
    https: transport,
    tryOpenAIChatToGemini: native ? gemini.tryOpenAIChatToGemini : undefined,
    parseProxyBody: (_res, wire) => JSON.parse(wire),
    openAIChatToClaudeMessages: (...args) => {
      compatibilityCalls++;
      return ai.openAIChatToClaudeMessages(...args);
    },
    rejectUnsupportedOpenAIChatNonOpenAIConversion: () => false,
    getGeminiCooldown: () => null,
    shouldUseCodeAssistUpstream: () => false,
    parseJsonOrSseJson: JSON.parse,
    unwrapCodeAssistResponse: (value) => value,
    collectBoundedResponse: (_proxy, _client, _path, _kind, done) =>
      done(
        JSON.stringify({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }],
        })
      ),
    writeJsonResponse: (_res, _status, payload) => {
      converted = payload;
    },
    sendJsonError: () => {
      throw new Error('Unexpected route rejection');
    },
    logRequestEnd: noop,
    logProxyEvent: noop,
    log: noop,
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
  };
  createRouteHandlers(ctx).handleOpenAIChatToGeminiMessages(
    { method: 'POST', headers: {} },
    { setHeader: noop },
    { rewriteTo: '-', buffer: JSON.stringify(body), profile: {} },
    { protocol: 'http:', hostname: 'example.test', path: '' },
    null,
    '/chat/completions',
    0
  );
  return { sent, converted, compatibilityCalls };
}
for (const body of [
  {
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: '中文' }],
    tools: functionTools,
  },
  {
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning: { effort: 'high' },
    max_tokens: 8192,
  },
]) {
  const oldRoute = runChatRoute(body, false);
  const nativeRoute = runChatRoute(body, true);
  assert.deepEqual(nativeRoute.sent, oldRoute.sent);
  assert.deepEqual(nativeRoute.converted, oldRoute.converted);
  assert.equal(nativeRoute.compatibilityCalls, 0);
  assert.equal(oldRoute.compatibilityCalls, 1);
}
const fallbackBody = {
  model: 'gemini-pro',
  messages: [
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    },
  ],
};
const oldFallback = runChatRoute(fallbackBody, false);
const newFallback = runChatRoute(fallbackBody, true);
assert.deepEqual(newFallback.sent, oldFallback.sent);
assert.equal(newFallback.compatibilityCalls, 0);

const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const historyState = createResponsesState({
  ...ai,
  log: { warn: noop },
  sendJsonError: () => {
    throw new Error('Missing history');
  },
});
historyState.responsesHistory.set('prev', [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'answer' },
]);
const resumed = historyState.responsesToChatWithHistory(
  {},
  { previous_response_id: 'prev', input: 'next' },
  'gemini-pro'
);
const oldResumed = ai.openAIChatToClaudeMessages(resumed, 'gemini-pro');
oldResumed.reasoning_effort = resumed.reasoning_effort;
const directResumed = gemini.tryOpenAIChatToGemini(resumed, 'gemini-pro');
assert.ok(directResumed);
assert.deepEqual(directResumed.request, gemini.claudeMessagesToGemini(oldResumed, 'gemini-pro'));
assert.deepEqual(
  directResumed.request.contents.map((message) => message.parts[0].text),
  ['first', 'answer', 'next']
);
const toolHistory = {
  model: 'gemini-pro',
  tools: functionTools,
  messages: [
    {
      role: 'assistant',
      tool_calls: [
        { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call', content: 'result' },
    { role: 'user', content: 'next' },
  ],
};
assert.ok(gemini.tryOpenAIChatToGemini(toolHistory, 'gemini-pro'));
const expectedHistory = runChatRoute(toolHistory, false).sent;
expectedHistory.contents[0].parts[0].functionCall.id = 'call';
expectedHistory.contents[1].parts[0].functionResponse.id = 'call';
assert.deepEqual(runChatRoute(toolHistory, true).sent, expectedHistory);
assert.equal(runChatRoute(toolHistory, true).compatibilityCalls, 0);
console.log('[direct-gemini-request.test] ok: ' + compared + ' parity cases');
