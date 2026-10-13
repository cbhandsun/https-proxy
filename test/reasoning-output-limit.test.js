'use strict';
const assert = require('node:assert/strict');
const { route } = require('./responses-history-policy-routes.test');
const { responsesTargetOptions } = require('../lib/proxy/responses-target-options');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { EFFORT_TO_BUDGET } = require('../lib/proxy/reasoning-adapter');
const { resolveConvertedOutputTokenLimit } = require('../lib/proxy/converted-request-scalars');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const deps = {
  ...require('../lib/proxy/tools'),
  ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'passthrough' } }),
  protocolOptions: { contextWindowPolicy: 'disabled' },
  fallbackId: () => 'fixture',
  stableHash: () => 'fixture',
  stableCreated: () => 1,
};
const ai = createOpenAIProtocol(deps);
const gemini = createGeminiProtocol(deps);
const invalid = (error) => error.code === 'invalid_request_error';
function rejectedChatRoute(source) {
  const errors = [];
  let converted = false;
  const sendJsonError = (_res, status, body) => errors.push({ status, body });
  const handlers = createRouteHandlers({
    ...createRequestValidators({ sendJsonError }),
    parseProxyBody: () => source,
    openAIChatToClaudeMessages: () => {
      converted = true;
      assert.fail('Invalid output budget must be rejected before compilation or transport');
    },
  });
  handlers.handleOpenAIChatToClaudeMessages(
    { headers: {} },
    {},
    { rewriteTo: 'claude-sonnet-4-5', buffer: '', profile: {} },
    { protocol: 'http:', hostname: 'example.test', path: '' },
    null,
    '/chat/completions',
    0
  );
  assert.equal(converted, false);
  assert.equal(errors[0].status, 400);
  assert.equal(JSON.stringify(errors).includes('synthetic'), false);
}
for (const [effort, budget] of Object.entries(EFFORT_TO_BUDGET)) {
  for (const key of ['max_output_tokens', 'max_tokens', 'max_completion_tokens']) {
    const source = { input: 'synthetic', [key]: 128, reasoning: { effort }, store: false };
    const snapshot = JSON.stringify(source);
    const rejected = route(source, 'Claude', { model: 'claude-sonnet-4-5' });
    assert.equal(rejected.requests, 0);
    assert.equal(rejected.errors[0].status, 400);
    const accepted = route(source, 'Gemini');
    assert.equal(accepted.errors.length, 0);
    assert.equal(accepted.sent.generationConfig.maxOutputTokens, 128);
    assert.equal(JSON.stringify(source), snapshot);
    assert.throws(
      () => responsesTargetOptions({ ...source, [key]: budget }, 'claude', 'Claude'),
      invalid
    );
    const bounded = responsesTargetOptions({ ...source, [key]: budget + 1 }, 'claude', 'Claude');
    assert.equal(bounded.max_tokens, budget + 1);
    assert.equal(bounded.thinking.budget_tokens, budget);
  }
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    const body = {
      messages: [{ role: 'user', content: 'synthetic' }],
      [key]: 128,
      reasoning_effort: effort,
    };
    assert.throws(() => ai.openAIChatToClaudeMessages(body, 'claude'), invalid);
    for (const stream of [false, true]) rejectedChatRoute({ ...body, stream });
    for (const model of ['gemini-2.5-pro', 'gemini-3.8-flash-tiered']) {
      const direct = gemini.tryOpenAIChatToGemini(body, model);
      assert.equal(direct.request.generationConfig.maxOutputTokens, 128);
    }
  }
}
for (const effort of ['none', undefined]) {
  const r = route({ input: 'synthetic', max_output_tokens: 128, reasoning: { effort } }, 'Claude');
  assert.equal(r.errors.length, 0);
  assert.equal(r.sent.max_tokens, 128);
}
assert.equal(
  responsesTargetOptions({ reasoning: { effort: 'high' } }, 'claude', 'Claude').max_tokens,
  20480
);
assert.equal(
  responsesTargetOptions({ reasoning: { effort: 'high' } }, 'gemini-3.8-flash', 'Gemini')
    .max_tokens,
  4096
);
const accepted = route(
  { input: 'synthetic', max_output_tokens: 20000, reasoning: { effort: 'high' } },
  'Claude'
);
assert.equal(accepted.errors.length, 0);
assert.equal(accepted.sent.max_tokens, 20000);
for (const body of [
  { max_tokens: 128, max_completion_tokens: 256 },
  { max_output_tokens: 128, max_tokens: 256 },
  { max_output_tokens: 128, max_completion_tokens: 256 },
]) {
  assert.throws(() => resolveConvertedOutputTokenLimit(body), invalid);
  assert.throws(() => ai.openAIChatToClaudeMessages({ messages: [], ...body }, 'claude'), invalid);
  assert.throws(() => gemini.tryOpenAIChatToGemini({ messages: [], ...body }, 'gemini'), invalid);
  assert.throws(() => ai.openAIResponsesToChat({ input: 'synthetic', ...body }), invalid);
  for (const target of ['Claude', 'Gemini']) {
    const rejected = route({ input: 'synthetic', ...body }, target);
    assert.equal(rejected.requests, 0);
    assert.equal(rejected.errors[0].status, 400);
  }
}
assert.equal(resolveConvertedOutputTokenLimit({}), undefined);
assert.equal(resolveConvertedOutputTokenLimit({ max_tokens: null }), undefined);
assert.equal(
  resolveConvertedOutputTokenLimit({
    max_tokens: 128,
    max_completion_tokens: 128,
    max_output_tokens: 128,
  }),
  128
);
for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '128', [], {}]) {
  assert.throws(() => resolveConvertedOutputTokenLimit({ max_tokens: value }), invalid);
}
assert.equal(
  resolveConvertedOutputTokenLimit({ max_tokens: Number.MAX_SAFE_INTEGER }),
  Number.MAX_SAFE_INTEGER
);
process.stdout.write('[reasoning-output-limit.test] ok\n');
