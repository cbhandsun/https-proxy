'use strict';
const assert = require('node:assert/strict');
const { validateResponsesEndpointOptions } = require('../lib/proxy/responses-endpoint-options');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { route } = require('./responses-history-policy-routes.test');
const unsupported = [
  { background: true },
  { background: 'SECRET' },
  { background: [] },
  { include: ['reasoning.encrypted_content'] },
  { include: 'SECRET' },
  { include: [null] },
  { include: Array(10000).fill('SECRET') },
  { stream_options: { include_obfuscation: true } },
  { stream_options: { include_obfuscation: null } },
  { stream_options: { include_usage: true } },
  { stream_options: [] },
  { reasoning: { summary: 'auto' } },
  { reasoning: { summary: 'detailed' } },
  { reasoning: { generate_summary: 'concise' } },
  { reasoning: { unknown: 'SECRET' } },
  { reasoning: 'SECRET' },
  { text: { unknown: 'SECRET' } },
  { text: [] },
  { metadata: { key: 'SECRET' } },
  { metadata: [] },
  { conversation: 'SECRET' },
  { max_tool_calls: 1 },
  { prompt_cache_key: 'SECRET' },
  { prompt_cache_retention: '24h' },
  { safety_identifier: 'SECRET' },
  { top_logprobs: 1 },
  { top_logprobs: 'SECRET' },
];
const accepted = [
  {},
  { background: false },
  { background: null, include: null },
  { include: [] },
  { stream_options: {} },
  { stream_options: { include_obfuscation: false } },
  { reasoning: { effort: 'low', summary: null } },
  { metadata: {} },
  { top_logprobs: 0 },
  { text: { verbosity: null, format: { type: 'text' } } },
];
for (const target of ['Claude', 'Gemini', 'Chat']) {
  for (const value of unsupported)
    if (target === 'Gemini' && (value.reasoning?.summary || value.reasoning?.generate_summary))
      assert.equal(validateResponsesEndpointOptions(value, target), value);
    else
      assert.throws(
        () => validateResponsesEndpointOptions(value, target),
        (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
      );
  for (const value of accepted) {
    const before = JSON.stringify(value);
    assert.equal(validateResponsesEndpointOptions(Object.freeze(value), target), value);
    assert.equal(JSON.stringify(value), before);
  }
}
for (const target of ['Claude', 'Gemini']) {
  for (const summaryField of ['summary', 'generate_summary']) {
    const summary = route(
      { input: 'question', store: false, reasoning: { effort: 'low', [summaryField]: 'auto' } },
      target
    );
    assert.equal(summary.requests, 1);
    assert.deepEqual(summary.errors, []);
    if (target === 'Claude') assert.equal(summary.sent.thinking.display, 'summarized');
    else assert.equal(summary.sent.generationConfig.thinkingConfig.includeThoughts, true);
  }
  for (const value of [...unsupported, { text: { verbosity: 'high' } }, { user: 'SECRET' }]) {
    const result = route(Object.freeze({ input: 'question', ...value }), target);
    const geminiCompatible =
      target === 'Gemini' &&
      ((Array.isArray(value.include) &&
        value.include.length === 1 &&
        value.include[0] === 'reasoning.encrypted_content') ||
        value.prompt_cache_key === 'SECRET' ||
        value.prompt_cache_retention === '24h' ||
        value.text?.verbosity === 'high' ||
        value.reasoning?.summary ||
        value.reasoning?.generate_summary);
    if (geminiCompatible) {
      assert.equal(result.requests, 1);
      assert.deepEqual(result.errors, []);
      continue;
    }
    assert.equal(result.requests, 0);
    assert.equal(result.errors[0].status, 400);
    assert.ok(!JSON.stringify(result.errors).includes('SECRET'));
  }
  for (const value of accepted) {
    const result = route({ input: 'question', store: false, ...value }, target);
    assert.equal(result.requests, 1);
    assert.deepEqual(result.errors, []);
  }
}
const ai = createOpenAIProtocol({ ...require('../lib/proxy/tools') });
for (const verbosity of ['low', 'medium', 'high'])
  assert.equal(
    ai.openAIResponsesToChat({ input: 'question', text: { verbosity } }).verbosity,
    verbosity
  );
for (const verbosity of ['SECRET', [], true])
  assert.throws(() => ai.openAIResponsesToChat({ input: 'question', text: { verbosity } }));
const errors = [];
const validators = createRequestValidators({
  sendJsonError: (_res, status, body) => errors.push({ status, body }),
});
for (const source of unsupported) {
  assert.equal(validators.rejectUnsupportedResponsesConversion({}, source), true);
  assert.equal(errors.at(-1).status, 400);
  assert.ok(!JSON.stringify(errors.at(-1)).includes('SECRET'));
}
assert.throws(() => validateResponsesEndpointOptions(null));
assert.throws(() => validateResponsesEndpointOptions({}, 'SECRET'));
assert.doesNotThrow(() =>
  validateResponsesEndpointOptions(
    { reasoning: { effort: 'low', summary: 'auto' } },
    'Gemini',
    'gemini-2.5-pro'
  )
);
assert.throws(() =>
  validateResponsesEndpointOptions({ reasoning: { effort: 'none', summary: 'auto' } }, 'Claude')
);
assert.throws(() =>
  validateResponsesEndpointOptions(
    { reasoning: { effort: 'low', summary: 'auto', generate_summary: 'detailed' } },
    'Claude'
  )
);
