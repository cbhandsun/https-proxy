'use strict';
const assert = require('node:assert/strict');
const {
  convertedServiceTier,
  applyConvertedServiceTier,
  geminiServiceTier,
} = require('../lib/proxy/converted-service-tier');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { createCodeAssist } = require('../lib/proxy/handlers/code-assist');
const noop = () => {};
const deps = {
  ...require('../lib/proxy/tools'),
  ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'passthrough' } }),
  fallbackId: () => 'fixture',
  stableHash: () => 'fixture',
  stableCreated: () => 1,
  sampleGeminiToolEvent: noop,
};
const gemini = createGeminiProtocol(deps);
const ai = createOpenAIProtocol({ ...deps, ...gemini });
function route(shape, target, tier, codeAssist = false, stream = false) {
  const source =
    shape === 'responses'
      ? { input: 'question' }
      : { messages: [{ role: 'user', content: 'question' }] };
  source.service_tier = tier;
  source.stream = stream;
  for (const message of source.messages || []) Object.freeze(message);
  Object.freeze(source);
  let sent,
    error,
    requests = 0;
  const sendJsonError = (_res, status, body) => {
    error = { status, body };
  };
  const state = createResponsesState({
    ...deps,
    ...ai,
    sendJsonError,
    log: { info: noop, warn: noop },
  });
  const ctx = {
    ...deps,
    ...ai,
    ...gemini,
    ...state,
    ...createRequestValidators({ sendJsonError }),
    sendJsonError,
    parseProxyBody: () => source,
    log: { info: noop, warn: noop },
    getGeminiCooldown: () => null,
    shouldUseCodeAssistUpstream: () => codeAssist,
    codeAssistGenerateRequest: createCodeAssist({ fallbackId: () => 'fixture' })
      .codeAssistGenerateRequest,
    codeAssistUserAgent: () => 'fixture',
    http: {
      request: () => {
        requests++;
        return {
          on: noop,
          end: (bytes) => {
            sent = JSON.parse(bytes);
          },
        };
      },
    },
    upstreamRequestOptions: () => ({}),
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    logRequestEnd: noop,
    logProxyEvent: noop,
  };
  const names = {
    'chat-Claude': 'handleOpenAIChatToClaudeMessages',
    'chat-Gemini': 'handleOpenAIChatToGeminiMessages',
    'responses-Claude': 'handleOpenAIResponsesToClaudeMessages',
    'responses-Gemini': 'handleOpenAIResponsesToGeminiMessages',
    'claude-Chat': 'handleClaudeMessagesToOpenAIChat',
    'claude-Responses': 'handleClaudeMessagesToOpenAIResponses',
    'claude-Gemini': 'handleGeminiMessages',
  };
  if (shape === 'responses') {
    ctx.responsesToChatWithHistory = () => assert.fail('Chat history selected');
    ctx.openAIResponsesToChat = () => assert.fail('Chat request selected');
    ctx.openAIChatToClaudeMessages = () => assert.fail('Chat Claude request selected');
    ctx.tryOpenAIChatToGemini = () => assert.fail('Chat Gemini request selected');
  }
  const before = JSON.stringify(source);
  createRouteHandlers(ctx)[names[shape + '-' + target]](
    { method: 'POST', headers: {} },
    {},
    {
      rewriteTo: target === 'Gemini' ? 'gemini-3.8-flash' : 'model',
      buffer: Buffer.from('{}'),
      profile: {},
    },
    { protocol: 'http:', hostname: 'fixture', path: '/v1' },
    '',
    '/request',
    1
  );
  assert.equal(JSON.stringify(source), before);
  return { sent: codeAssist ? sent?.request : sent, error, requests };
}
for (const shape of ['chat', 'responses', 'claude']) {
  for (const target of shape === 'claude'
    ? ['Chat', 'Responses', 'Gemini']
    : ['Claude', 'Gemini']) {
    for (const tier of [
      undefined,
      null,
      'auto',
      'default',
      'priority',
      'flex',
      ...(shape === 'claude' ? ['standard_only'] : []),
    ]) {
      const source = shape === 'claude' ? 'claude' : 'openai';
      if (target === 'Claude' && ['priority', 'flex'].includes(tier)) {
        const result = route(shape, target, tier);
        assert.equal(result.requests, 0);
        assert.equal(result.error.status, 400);
        continue;
      }
      const expected = convertedServiceTier(tier, source, target);
      const result = route(shape, target, tier);
      assert.equal(result.requests, 1);
      assert.equal(result.error, undefined);
      assert.equal(
        target === 'Gemini' ? result.sent.serviceTier : result.sent.service_tier,
        expected ?? undefined
      );
      assert.equal(result.sent.generationConfig?.serviceTier, undefined);
    }
    for (const tier of [
      '',
      'SECRET',
      'SECRET'.repeat(10000),
      [],
      {},
      0,
      false,
      'fast',
      'PRIORITY',
    ]) {
      const result = route(shape, target, tier);
      assert.equal(result.requests, 0);
      assert.equal(result.error.status, 400);
      assert.ok(!JSON.stringify(result.error).includes('SECRET'));
    }
  }
}
assert.throws(() => convertedServiceTier('standard_only', 'openai', 'Gemini'));
assert.equal(convertedServiceTier(' priority ', 'openai', 'Gemini'), 'priority');
for (const value of [null, [], 'SECRET'])
  assert.throws(
    () => applyConvertedServiceTier({}, value, 'openai', 'Gemini'),
    (error) => error.code === 'invalid_request_error'
  );
for (const shape of ['chat', 'responses', 'claude'])
  for (const stream of [false, true]) {
    for (const tier of [
      undefined,
      null,
      'auto',
      'default',
      'priority',
      'flex',
      ...(shape === 'claude' ? ['standard_only'] : []),
    ]) {
      const result = route(shape, 'Gemini', tier, true, stream);
      assert.equal(result.error, undefined);
      assert.equal(result.requests, 1);
      assert.equal(result.sent.serviceTier, undefined);
    }
  }
for (const shape of ['chat', 'responses', 'claude'])
  for (const stream of [false, true])
    for (const tier of [
      '',
      'SECRET',
      'SECRET'.repeat(10000),
      {},
      [],
      false,
      1,
      'fast',
      'PRIORITY',
    ]) {
      const result = route(shape, 'Gemini', tier, true, stream);
      assert.equal(result.requests, 0);
      assert.equal(result.error.status, 400);
      assert.equal(JSON.stringify(result.error).includes('SECRET'), false);
    }
assert.equal(
  gemini.claudeMessagesToGemini(
    { messages: [], __geminiServiceTier: 'priority' },
    'gemini-3.8-flash'
  ).serviceTier,
  undefined
);
for (const tier of ['unspecified', 'standard', 'priority', 'flex']) {
  const body = { messages: [], [geminiServiceTier]: tier };
  const compatible = gemini.claudeMessagesToGemini(body, 'gemini-3.8-flash-tiered', {
    codeAssist: true,
  });
  assert.equal(Object.hasOwn(compatible, 'serviceTier'), false);
  assert.deepEqual(compatible.__hpmDiagnostics.serviceTier, {
    requested: tier,
    effective: 'provider-default',
    preserved: false,
    reason: 'code-assist-service-tier-unsupported',
  });
  assert.equal(JSON.stringify(compatible).includes('code-assist-service-tier-unsupported'), false);
  assert.equal(body[geminiServiceTier], tier);
  assert.equal(gemini.claudeMessagesToGemini(body, 'gemini-3.8-flash-tiered').serviceTier, tier);
}
for (const tier of ['auto', 'default', 'priority', 'flex']) {
  const converted = gemini.tryOpenAIChatToGemini(
    { messages: [], service_tier: tier },
    'gemini-3.8-flash-tiered',
    { codeAssist: true }
  );
  assert.equal(Object.hasOwn(converted.request, 'serviceTier'), false);
  assert.equal(converted.request.__hpmDiagnostics.serviceTier.effective, 'provider-default');
}
