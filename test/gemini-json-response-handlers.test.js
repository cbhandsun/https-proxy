'use strict';

const assert = require('node:assert/strict');
const {
  createGeminiJsonResponseHandlers,
} = require('../lib/proxy/handlers/gemini-json-response-handlers');

function geminiBodyWithDiagnostics(marker) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'private prompt ' + marker }] }],
  };
  Object.defineProperty(body, '__hpmDiagnostics', {
    value: {
      contextBudget: {
        enabled: true,
        policy: 'overflow-drop-oldest',
        source: 'gemini-json-test',
        contextCache: {
          stablePrefixHash: 'abc123',
          stablePrefixMessageCount: 1,
        },
      },
      providerCache: {
        enabled: true,
        provider: 'gemini',
        policy: 'diagnostics-only',
        stablePrefixHash: 'abc123',
      },
    },
    enumerable: false,
    configurable: true,
  });
  return body;
}

{
  let convertedCalled = false;
  const clientRes = {};
  const marker = 'json-responses-marker';
  const handlers = createGeminiJsonResponseHandlers({
    handleConvertedJsonResponse(options) {
      convertedCalled = true;
      assert.equal(options.clientRes, clientRes);
    },
  });

  handlers.handleResponsesToGeminiJson({
    proxyRes: { statusCode: 200 },
    clientReq: { method: 'POST' },
    clientRes,
    prepared: {
      model: 'gemini-client',
      profile: { id: 'google-official', protocol: 'gemini' },
    },
    upstreamPath: '/responses',
    startTime: 1,
    responseBody: '{}',
    targetModel: 'gemini-3.5-flash-lite',
    claudeBody: { tools: [] },
    parsed: { model: 'gemini-3.5-flash-lite' },
    chatBody: { messages: [] },
    toolPreambleText: '',
    geminiBody: geminiBodyWithDiagnostics(marker),
  });

  assert.equal(convertedCalled, true);
  assert.equal(clientRes.__diagnostics.protocol, 'gemini');
  assert.equal(clientRes.__diagnostics.entryProtocol, 'openai-responses');
  assert.equal(clientRes.__diagnostics.profile, 'google-official');
  assert.equal(
    clientRes.__diagnostics.hpmDiagnostics.contextBudget.contextCache.stablePrefixHash,
    'abc123'
  );
  assert.equal(JSON.stringify(clientRes.__diagnostics.hpmDiagnostics).includes(marker), false);
}

{
  let wroteJson = false;
  const clientRes = {};
  const marker = 'json-chat-marker';
  const handlers = createGeminiJsonResponseHandlers({
    handleGeminiUpstreamError() {
      throw new Error('unexpected upstream error');
    },
    geminiResponseToClaude() {
      return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1 } };
    },
    claudeResponseToOpenAIChat() {
      return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
    },
    parseJsonOrSseJson: JSON.parse,
    unwrapCodeAssistResponse: (payload) => payload,
    writeJsonResponse(res, status, body) {
      wroteJson = true;
      assert.equal(res, clientRes);
      assert.equal(status, 200);
      assert.equal(body.choices[0].message.content, 'ok');
    },
    logRequestEnd() {},
    sendJsonError() {},
  });

  handlers.handleOpenAIChatToGeminiJson({
    proxyRes: { statusCode: 200 },
    clientReq: { method: 'POST' },
    clientRes,
    prepared: {
      model: 'gemini-client',
      profile: { id: 'google-official', protocol: 'gemini' },
    },
    upstreamPath: '/chat/completions',
    startTime: 1,
    responseBody: '{}',
    targetModel: 'gemini-3.5-flash-lite',
    claudeBody: { tools: [] },
    parsed: { model: 'gemini-3.5-flash-lite' },
    geminiBody: geminiBodyWithDiagnostics(marker),
  });

  assert.equal(wroteJson, true);
  assert.equal(clientRes.__diagnostics.protocol, 'gemini');
  assert.equal(clientRes.__diagnostics.entryProtocol, 'openai-chat');
  assert.equal(clientRes.__diagnostics.profile, 'google-official');
  assert.equal(clientRes.__diagnostics.hpmDiagnostics.providerCache.provider, 'gemini');
  assert.equal(JSON.stringify(clientRes.__diagnostics.hpmDiagnostics).includes(marker), false);
}

console.log('[gemini-json-response-handlers.test] ok');
