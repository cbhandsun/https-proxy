'use strict';
const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const noop = () => {};
const deps = {
  ...require('../lib/proxy/claude-filters').createClaudeFilters({
    protocolOptions: { thinkingPolicy: 'passthrough' },
  }),
  ...require('../lib/proxy/tools'),
  fallbackId: () => 'fixture',
  stableHash: () => 'fixture',
  stableCreated: () => 1,
  sampleGeminiToolEvent: noop,
};
const gemini = createGeminiProtocol(deps);
const ai = createOpenAIProtocol({ ...deps, normalizeClaudeSystem: gemini.normalizeClaudeSystem });
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const chatFormat = { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } };
const responsesFormat = { type: 'json_schema', name: 'answer', schema, strict: true };
function route(
  source,
  shape,
  target,
  model = target === 'Gemini' ? 'gemini-3.8-flash' : 'claude-sonnet-4-6',
  codeAssist = false
) {
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
  };
  if (shape === 'responses') {
    ctx.responsesToChatWithHistory = () => assert.fail('Chat history selected');
    ctx.openAIResponsesToChat = () => assert.fail('Chat request selected');
    ctx.openAIChatToClaudeMessages = () => assert.fail('Claude bridge selected');
    ctx.tryOpenAIChatToGemini = () => assert.fail('Chat Gemini bridge selected');
  }
  const handlers = createRouteHandlers(ctx);
  const method =
    shape === 'claude'
      ? 'handleGeminiMessages'
      : shape === 'responses'
        ? target === 'Claude'
          ? 'handleOpenAIResponsesToClaudeMessages'
          : 'handleOpenAIResponsesToGeminiMessages'
        : target === 'Claude'
          ? 'handleOpenAIChatToClaudeMessages'
          : 'handleOpenAIChatToGeminiMessages';
  const before = JSON.stringify(source);
  handlers[method](
    { method: 'POST', headers: {} },
    {},
    { rewriteTo: model, buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', hostname: 'fixture', path: '/v1' },
    '',
    '/request',
    1
  );
  assert.equal(JSON.stringify(source), before);
  return { sent, error, requests };
}
// Verify thinking controls on actual handler dispatch, including zero upstream
// calls for model-specific unsupported requests in both response modes.
for (const shape of ['chat', 'responses', 'claude']) {
  for (const stream of [false, true]) {
    const base =
      shape === 'responses'
        ? { input: 'hello', stream }
        : { messages: [{ role: 'user', content: 'hello' }], stream };
    const enabled =
      shape === 'claude'
        ? { thinking: { type: 'enabled', budget_tokens: 4096 } }
        : { reasoning_effort: 'medium' };
    const supported = route({ ...base, ...enabled }, shape, 'Gemini', 'gemini-2.5-flash');
    assert.equal(supported.requests, 1);
    assert.equal(supported.sent.generationConfig.thinkingConfig.thinkingBudget, 4096);
    const disabled =
      shape === 'claude' ? { thinking: { type: 'disabled' } } : { reasoning_effort: 'none' };
    for (const model of ['gemini-2.5-pro', 'gemini-3.6-flash']) {
      const rejected = route({ ...base, ...disabled }, shape, 'Gemini', model);
      assert.equal(rejected.requests, 0);
      assert.equal(rejected.error.status, 400);
    }
    const off = route({ ...base, ...disabled }, shape, 'Gemini', 'gemini-2.5-flash');
    assert.equal(off.requests, 1);
    assert.equal(off.sent.generationConfig.thinkingConfig.thinkingBudget, 0);
  }
}
for (const shape of ['chat', 'responses']) {
  const source =
    shape === 'chat'
      ? { messages: [{ role: 'user', content: 'answer' }], response_format: chatFormat }
      : { input: 'answer', text: { format: responsesFormat } };
  for (const target of ['Claude', 'Gemini']) {
    const result = route(source, shape, target);
    assert.equal(result.requests, 1);
    assert.equal(result.error, undefined);
    if (target === 'Claude')
      assert.deepEqual(result.sent.output_config, { format: { type: 'json_schema', schema } });
    else {
      assert.equal(result.sent.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(result.sent.generationConfig.responseJsonSchema, schema);
    }
    for (const invalid of [
      'SECRET',
      {},
      { type: 'json_schema', name: 'bad', schema: [] },
      ...[{ type: 'SECRET' }, { required: 7 }, { minimum: 'SECRET' }, { minItems: -1 }].map(
        (badSchema) =>
          shape === 'chat'
            ? { type: 'json_schema', json_schema: { name: 'bad', schema: badSchema } }
            : { type: 'json_schema', name: 'bad', schema: badSchema }
      ),
    ]) {
      const body =
        shape === 'chat'
          ? { ...source, response_format: invalid }
          : { ...source, text: { format: invalid } };
      const rejected = route(body, shape, target);
      assert.equal(rejected.requests, 0);
      assert.equal(rejected.error.status, 400);
      assert.ok(!JSON.stringify(rejected.error).includes('SECRET'));
    }
  }
  const image = route(source, shape, 'Gemini', 'gemini-3.1-flash-image');
  assert.equal(image.requests, 0);
  assert.equal(image.error.status, 400);
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro', 'models/deepseek-v4-flash']) {
    for (const stream of [false, true]) {
      const unsupported = route({ ...source, stream }, shape, 'Claude', model);
      assert.equal(unsupported.requests, 0);
      assert.equal(unsupported.error.status, 400);
      assert.ok(!JSON.stringify(unsupported.error).includes(model));
    }
  }
  const jsonSource =
    shape === 'chat'
      ? { ...source, response_format: { type: 'json_object' } }
      : { ...source, text: { format: { type: 'json_object' } } };
  assert.equal(
    route(jsonSource, shape, 'Gemini').sent.generationConfig.responseMimeType,
    'application/json'
  );
  assert.equal(
    route(jsonSource, shape, 'Gemini').sent.generationConfig.responseJsonSchema,
    undefined
  );
  assert.equal(route(jsonSource, shape, 'Claude').error.status, 400);
  for (const unsupported of [source, jsonSource])
    for (const stream of [false, true]) {
      const rejected = route(
        { ...unsupported, stream },
        shape,
        'Gemini',
        'gemini-3.8-flash-tiered',
        true
      );
      assert.equal(rejected.requests, 0);
      assert.equal(rejected.error.status, 400);
      assert.ok(!JSON.stringify(rejected.error).includes('answer'));
    }
}
