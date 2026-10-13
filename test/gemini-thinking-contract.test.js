'use strict';
const assert = require('node:assert/strict');
const {
  geminiThinkingConfigFromOpenAI,
  geminiThinkingConfigFromCanonical,
  extractCanonicalReasoning,
} = require('../lib/proxy/reasoning-adapter');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { geminiReasoningSummary } = require('../lib/proxy/responses-endpoint-options');
const {
  normalizeClaudeModernOptions,
  rejectClaudeModernOptions,
} = require('../lib/proxy/claude-modern-options');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const gemini = createGeminiProtocol({
  ...require('../lib/proxy/claude-filters').createClaudeFilters({
    protocolOptions: { thinkingPolicy: 'passthrough' },
  }),
  ...require('../lib/proxy/tools'),
  fallbackId: () => 'fixture',
  sampleGeminiToolEvent() {},
});
function rejected(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'invalid_request_error');
    assert.ok(!error.message.includes('SECRET'));
    return true;
  });
}
for (const model of [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'models/gemini-2.5-pro-preview-06-05',
]) {
  for (const [effort, expected] of Object.entries({
    minimal: 1024,
    low: 2048,
    medium: 4096,
    high: 16384,
    xhigh: model.includes('pro') ? 32768 : 24576,
  })) {
    const body = { reasoning_effort: effort };
    const before = JSON.stringify(body);
    assert.deepEqual(geminiThinkingConfigFromOpenAI(body, model), { thinkingBudget: expected });
    assert.deepEqual(geminiThinkingConfigFromCanonical(extractCanonicalReasoning(body), model), {
      thinkingBudget: expected,
    });
    assert.equal(JSON.stringify(body), before);
    const wire = gemini.claudeMessagesToGemini(
      { ...body, messages: [{ role: 'user', content: 'hello' }] },
      model
    );
    assert.equal(wire.generationConfig.thinkingConfig.thinkingBudget, expected);
    assert.equal(wire.generationConfig.thinkingConfig.thinkingLevel, undefined);
  }
  assert.equal(geminiThinkingConfigFromOpenAI({}, model), null);
}
for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
  for (const body of [{ reasoning_effort: 'none' }, { thinking: { type: 'disabled' } }])
    assert.deepEqual(geminiThinkingConfigFromOpenAI(body, model), { thinkingBudget: 0 });
}
for (const model of ['gemini-2.5-pro', 'gemini-3.6-flash', 'gemini-3.8-flash-tiered'])
  for (const body of [{ reasoning_effort: 'none' }, { thinking: { type: 'disabled' } }])
    rejected(() => geminiThinkingConfigFromOpenAI(body, model));
for (const [model, min, max] of [
  ['gemini-2.5-pro', 128, 32768],
  ['gemini-2.5-flash', 1, 24576],
  ['gemini-2.5-flash-lite', 512, 24576],
]) {
  for (const budget_tokens of [min, max, 4096])
    assert.deepEqual(
      geminiThinkingConfigFromOpenAI({ thinking: { type: 'enabled', budget_tokens } }, model),
      { thinkingBudget: budget_tokens }
    );
  for (const budget_tokens of [
    min - 1,
    max + 1,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    '4096',
    'SECRET',
    {},
    [],
  ])
    rejected(() =>
      geminiThinkingConfigFromOpenAI({ thinking: { type: 'enabled', budget_tokens } }, model)
    );
}
for (const model of [
  'unknown',
  'gemini-2.0-flash',
  'gemini-2.5-flash-image',
  'gemini-2.5-pro-preview-SECRET',
  null,
  {},
])
  rejected(() => geminiThinkingConfigFromOpenAI({ reasoning_effort: 'high' }, model));
for (const body of [
  { reasoning_effort: 'SECRET' },
  { reasoning: { effort: [] } },
  { reasoning_effort: 'low', reasoning: { effort: 'high' } },
  { thinking: 'SECRET' },
])
  rejected(() => geminiThinkingConfigFromOpenAI(body, 'gemini-3.6-flash'));
for (const model of ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-cyber'])
  assert.deepEqual(geminiThinkingConfigFromOpenAI({ reasoning_effort: 'minimal' }, model), {
    thinkingLevel: 'low',
  });
for (const model of [
  'gemini-3-pro-image',
  'models/gemini-3-pro-image-preview',
  'gemini-3.1-flash-image',
  'models/gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite-image-preview',
]) {
  assert.equal(geminiThinkingConfigFromOpenAI({}, model), null);
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
    const expected = model.includes('3-pro-image')
      ? 'high'
      : effort === 'minimal' || effort === 'low'
        ? 'minimal'
        : 'high';
    const body = { reasoning_effort: effort };
    assert.deepEqual(geminiThinkingConfigFromOpenAI(body, model), { thinkingLevel: expected });
    assert.deepEqual(geminiThinkingConfigFromCanonical(extractCanonicalReasoning(body), model), {
      thinkingLevel: expected,
    });
    const wire = gemini.claudeMessagesToGemini(
      { ...body, messages: [{ role: 'user', content: 'hello' }] },
      model
    );
    assert.equal(wire.generationConfig.thinkingConfig.thinkingLevel, expected);
    assert.deepEqual(body, { reasoning_effort: effort });
  }
  for (const body of [{ reasoning_effort: 'none' }, { thinking: { type: 'disabled' } }])
    rejected(() => geminiThinkingConfigFromOpenAI(body, model));
}
// Image constraints must not narrow ordinary text models with similar names.
assert.deepEqual(
  geminiThinkingConfigFromOpenAI({ reasoning_effort: 'low' }, 'gemini-3-pro-preview'),
  { thinkingLevel: 'low' }
);
assert.deepEqual(
  geminiThinkingConfigFromOpenAI({ reasoning_effort: 'medium' }, 'gemini-3.1-flash'),
  { thinkingLevel: 'medium' }
);
const adaptive = normalizeClaudeModernOptions(
  { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
  'Gemini',
  { model: 'gemini-2.5-flash' }
);
assert.deepEqual(geminiThinkingConfigFromOpenAI(adaptive, 'gemini-2.5-flash'), {
  thinkingBudget: 2048,
});
const summary = gemini.claudeMessagesToGemini(
  { messages: [{ role: 'user', content: 'hello' }], [geminiReasoningSummary]: true },
  'gemini-2.5-pro'
);
assert.deepEqual(summary.generationConfig.thinkingConfig, { includeThoughts: true });
const chat = gemini.tryOpenAIChatToGemini(
  { messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'xhigh' },
  'gemini-2.5-flash'
);
assert.equal(chat.request.generationConfig.thinkingConfig.thinkingBudget, 24576);
assert.deepEqual(
  geminiThinkingConfigFromOpenAI(
    { reasoning: { summary: 'auto' }, thinking: { type: 'enabled', budget_tokens: 4096 } },
    'gemini-2.5-flash'
  ),
  { thinkingBudget: 4096 }
);
rejected(() =>
  geminiThinkingConfigFromOpenAI(
    { reasoning: { summary: 'auto' }, thinking: { type: 'enabled', budget_tokens: 'SECRET' } },
    'gemini-2.5-flash'
  )
);

let failure;
const sendJsonError = (_res, status, body) => {
  failure = { status, body };
};
const validators = createRequestValidators({ sendJsonError });
for (const model of ['gemini-2.5-pro', 'gemini-3.6-flash']) {
  failure = undefined;
  assert.equal(
    validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
      {},
      { reasoning_effort: 'none' },
      'Gemini',
      model
    ),
    true
  );
  assert.equal(failure.status, 400);
  failure = undefined;
  assert.equal(
    validators.rejectUnsupportedResponsesNonOpenAIConversion(
      {},
      { input: 'hello', reasoning: { effort: 'none' } },
      'Gemini',
      model
    ),
    true
  );
  assert.equal(failure.status, 400);
  failure = undefined;
  assert.equal(
    rejectClaudeModernOptions({}, { thinking: { type: 'disabled' } }, 'Gemini', sendJsonError, {
      model,
    }),
    true
  );
  assert.equal(failure.status, 400);
}
process.stdout.write('gemini-thinking-contract.test.js passed\n');
