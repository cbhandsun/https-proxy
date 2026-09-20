'use strict';

const assert = require('node:assert/strict');
const { sanitizeContextDiagnostics } = require('../lib/proxy/conversation-audit-utils');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const {
  createResponsesRequestConverter,
} = require('../lib/proxy/protocol-openai-responses-request');
const {
  createGeminiJsonResponseHandlers,
} = require('../lib/proxy/handlers/gemini-json-response-handlers');
const { sanitizeWorkBuddyChatBody } = require('../lib/proxy/workbuddy-official');

function assertSanitizedDiagnostics(label, value, marker) {
  const diagnostics = value && value.__hpmDiagnostics;
  assert.ok(diagnostics, `${label} exposes diagnostics`);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(value, '__hpmDiagnostics'),
    false,
    `${label} diagnostics are non-enumerable`
  );
  const sanitized = sanitizeContextDiagnostics(diagnostics);
  assert.ok(sanitized, `${label} diagnostics can be written to audit`);
  assert.ok(sanitized.contextBudget, `${label} keeps context budget`);
  assert.equal(
    JSON.stringify(sanitized).includes(marker),
    false,
    `${label} sanitized diagnostics do not include prompt marker`
  );
}

function longMessages(marker) {
  return [
    { role: 'system', content: 'system ' + marker },
    { role: 'user', content: 'hello ' + marker + ' ' + 'context '.repeat(4000) },
  ];
}

const protocolOptions = {
  maxContextTokens: 64,
  contextWindowPolicy: 'overflow-drop-oldest',
  providerCacheHintsPolicy: 'diagnostics-only',
  contextCacheCandidateMinTokens: 1,
};

{
  const marker = 'matrix-chat-to-responses-private';
  const { openAIChatToResponsesRequest } = createResponsesRequestConverter({
    fallbackId: (prefix) => `${prefix}_matrix`,
    chatToolContentToResponsesOutput: (content) =>
      typeof content === 'string' ? content : JSON.stringify(content),
    protocolOptions,
  });
  const converted = openAIChatToResponsesRequest({
    model: 'gpt-5',
    messages: longMessages(marker),
  });
  assertSanitizedDiagnostics('openai-chat-to-responses', converted, marker);
}

{
  const marker = 'matrix-chat-to-claude-private';
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (_name, args) => args,
    fallbackId: (prefix) => `${prefix}_matrix`,
    stableCreated: () => 123,
    isClaudeThinkingBlock: () => false,
    filterClaudeCompatibleBlocks: (blocks) => blocks,
    normalizeClaudeContent: (content) =>
      typeof content === 'string' ? [{ type: 'text', text: content }] : content || [],
    normalizeClaudeSystem: (system) => system || null,
    geminiToolResponseText: (value) => String(value == null ? '' : value),
    parseClaudeSseEvent: () => null,
    deltaPartialJson: () => null,
    protocolOptions,
  });
  const converted = protocol.openAIChatToClaudeMessages(
    { model: 'claude-test', messages: longMessages(marker) },
    'claude-test'
  );
  assertSanitizedDiagnostics('openai-chat-to-claude', converted, marker);
}

function geminiBodyWithDiagnostics(marker) {
  const body = { contents: [{ role: 'user', parts: [{ text: 'private ' + marker }] }] };
  Object.defineProperty(body, '__hpmDiagnostics', {
    value: {
      contextBudget: {
        enabled: true,
        policy: 'overflow-drop-oldest',
        source: 'matrix',
        estimatedInputTokens: 42,
        contextCache: { candidate: true, stablePrefixHash: 'hash-only' },
      },
      providerCache: {
        enabled: true,
        provider: 'gemini',
        policy: 'diagnostics-only',
        candidate: true,
      },
    },
    enumerable: false,
    configurable: true,
  });
  return body;
}

{
  const marker = 'matrix-responses-to-gemini-json-private';
  const clientRes = {};
  const handlers = createGeminiJsonResponseHandlers({
    handleConvertedJsonResponse() {},
  });
  handlers.handleResponsesToGeminiJson({
    proxyRes: { statusCode: 200 },
    clientReq: { method: 'POST' },
    clientRes,
    prepared: { model: 'gemini-client', profile: { id: 'google-official' } },
    upstreamPath: '/responses',
    startTime: 1,
    responseBody: '{}',
    targetModel: 'gemini-3.8-flash',
    claudeBody: { tools: [] },
    parsed: { model: 'gemini-3.8-flash' },
    chatBody: { messages: [] },
    toolPreambleText: '',
    geminiBody: geminiBodyWithDiagnostics(marker),
  });
  const sanitized = sanitizeContextDiagnostics(clientRes.__diagnostics.hpmDiagnostics);
  assert.ok(sanitized.contextBudget, 'responses-to-gemini-json audit diagnostics are present');
  assert.equal(JSON.stringify(sanitized).includes(marker), false);
}

{
  const marker = 'matrix-chat-to-gemini-json-private';
  const clientRes = {};
  const handlers = createGeminiJsonResponseHandlers({
    handleGeminiUpstreamError() {
      throw new Error('unexpected upstream error');
    },
    geminiResponseToClaude: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    claudeResponseToOpenAIChat: () => ({ choices: [{ message: { content: 'ok' } }] }),
    parseJsonOrSseJson: JSON.parse,
    unwrapCodeAssistResponse: (payload) => payload,
    writeJsonResponse() {},
    logRequestEnd() {},
    sendJsonError() {},
  });
  handlers.handleOpenAIChatToGeminiJson({
    proxyRes: { statusCode: 200 },
    clientReq: { method: 'POST' },
    clientRes,
    prepared: { model: 'gemini-client', profile: { id: 'google-official' } },
    upstreamPath: '/chat/completions',
    startTime: 1,
    responseBody: '{}',
    targetModel: 'gemini-3.8-flash',
    claudeBody: { tools: [] },
    parsed: { model: 'gemini-3.8-flash' },
    geminiBody: geminiBodyWithDiagnostics(marker),
  });
  const sanitized = sanitizeContextDiagnostics(clientRes.__diagnostics.hpmDiagnostics);
  assert.ok(sanitized.contextBudget, 'chat-to-gemini-json audit diagnostics are present');
  assert.equal(JSON.stringify(sanitized).includes(marker), false);
}

{
  const marker = 'matrix-workbuddy-private';
  const converted = sanitizeWorkBuddyChatBody(
    {
      model: 'workbuddy-test',
      messages: longMessages(marker),
      tools: [{ type: 'function', function: { name: 'lookup' } }],
    },
    {
      targetModel: 'workbuddy-test',
      modelSupport: { maxInputTokens: 64 },
      protocolOptions,
    }
  );
  assertSanitizedDiagnostics('workbuddy-chat', converted, marker);
}

console.log('[context-diagnostics-matrix.test] ok');
