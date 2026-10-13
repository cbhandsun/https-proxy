'use strict';

const assert = require('node:assert/strict');
const { route } = require('./responses-history-policy-routes.test');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { supportsClaudeAdaptiveThinking } = require('../lib/proxy/claude-thinking-capabilities');
const { nativeGeminiThinking } = require('../lib/proxy/native-reasoning-controls');
const { responsesTargetOptions } = require('../lib/proxy/responses-target-options');
const {
  extractCanonicalReasoning,
  applyReasoningToOpenAI,
} = require('../lib/proxy/reasoning-adapter');

const deps = {
  ...require('../lib/proxy/tools'),
  ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'passthrough' } }),
  fallbackId: () => 'fixture',
  stableHash: () => 'fixture',
  stableCreated: () => 1,
  protocolOptions: { contextWindowPolicy: 'disabled' },
};
const ai = createOpenAIProtocol(deps);
const gemini = createGeminiProtocol(deps);

// Exercise real route validation, compilation, transport wrappers and both
// response modes. A summary must not fabricate a thinking budget or an effort.
for (const model of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.8-flash'])
  for (const codeAssist of [false, true])
    for (const stream of [false, true])
      for (const field of ['summary', 'generate_summary'])
        for (const summary of ['auto', 'concise', 'detailed']) {
          const source = Object.freeze({
            input: 'question',
            reasoning: Object.freeze({ [field]: summary }),
            max_output_tokens: 128,
            store: false,
            stream,
          });
          const result = route(source, 'Gemini', { model, codeAssist });
          assert.equal(result.requests, 1);
          assert.deepEqual(result.errors, []);
          assert.deepEqual(result.sent.generationConfig.thinkingConfig, { includeThoughts: true });
          assert.equal(result.sent.generationConfig.maxOutputTokens, 128);
          assert.ok(result.writes.join('').includes('reply'));
          assert.deepEqual(result.diagnostics.reasoningSummary, {
            requested: summary,
            effective: 'includeThoughts',
            detailPreserved: summary === 'auto',
          });
          assert.ok(!JSON.stringify(result.sent).includes('reasoningSummary'));
        }

for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6']) {
    const expected = effort === 'minimal' ? 'low' : effort === 'xhigh' ? 'max' : effort;
    for (const stream of [false, true]) {
      const r = route(
        {
          input: 'question',
          reasoning: { effort, summary: 'detailed' },
          max_output_tokens: 128,
          stream,
        },
        'Claude',
        { model }
      );
      assert.deepEqual(r.errors, []);
      assert.equal(r.requests, 1);
      assert.deepEqual(r.sent.thinking, { type: 'adaptive', display: 'summarized' });
      assert.deepEqual(r.sent.output_config, { effort: expected });
      assert.equal(r.sent.max_tokens, 128);
      assert.equal(r.sent.temperature, undefined);
      assert.ok(resultText(r).includes('reply'));
      assert.equal(r.diagnostics.reasoningSummary.detailPreserved, false);
    }
    const chat = ai.openAIChatToClaudeMessages(
      {
        messages: [{ role: 'user', content: 'question' }],
        reasoning_effort: effort,
        max_tokens: 128,
      },
      model
    );
    assert.deepEqual(chat.thinking, { type: 'adaptive' });
    assert.deepEqual(chat.output_config, { effort: expected });
    assert.equal(chat.max_tokens, 128);
  }
}
function resultText(result) {
  return result.writes.join('');
}

// Preserve Gemini sampling and output limits; no Claude-shaped thinking should
// be introduced by either the Chat or Responses compiler.
for (const effort of ['low', 'high']) {
  const source = { reasoning: { effort }, temperature: 0.4, top_p: 0.8, max_output_tokens: 128 };
  const config = responsesTargetOptions(source, 'gemini-2.5-flash', 'Gemini');
  assert.equal(config.thinking, undefined);
  assert.equal(config.temperature, 0.4);
  assert.equal(config.top_p, 0.8);
  assert.deepEqual(config[nativeGeminiThinking], {
    thinkingBudget: effort === 'low' ? 2048 : 16384,
  });
  const chat = gemini.tryOpenAIChatToGemini(
    {
      messages: [{ role: 'user', content: 'question' }],
      reasoning_effort: effort,
      temperature: 0.4,
      top_p: 0.8,
      max_tokens: 128,
    },
    'gemini-2.5-flash'
  ).request;
  assert.equal(chat.generationConfig.temperature, 0.4);
  assert.equal(chat.generationConfig.topP, 0.8);
  assert.equal(chat.generationConfig.maxOutputTokens, 128);
}

for (const target of ['Gemini', 'Claude'])
  for (const reasoning of [
    { effort: 'high', summary: 'SECRET' },
    { effort: 'high', summary: [] },
    { effort: 'high', summary: {} },
    { effort: 'high', summary: true },
    { effort: 'high', summary: 'SECRET'.repeat(10000) },
    { effort: 'high', summary: 'auto', generate_summary: 'detailed' },
    { effort: 'none', summary: 'auto' },
  ]) {
    const result = route({ input: 'question', reasoning }, target);
    assert.equal(result.requests, 0);
    assert.equal(result.errors[0].status, 400);
    assert.ok(!JSON.stringify(result.errors).includes('SECRET'));
  }
for (const model of ['unknown', 'gemini-2.0-flash', 'gemini-2.5-flash-image']) {
  const result = route({ input: 'question', reasoning: { summary: 'auto' } }, 'Gemini', { model });
  assert.equal(result.requests, 0);
  assert.equal(result.errors[0].status, 400);
}
for (const target of ['Gemini', 'Claude']) {
  const result = route({ input: 'question', reasoning: {} }, target);
  assert.deepEqual(result.errors, []);
  if (target === 'Gemini') assert.equal(result.sent.generationConfig.thinkingConfig, undefined);
  else assert.equal(result.sent.thinking, undefined);
}
assert.equal(supportsClaudeAdaptiveThinking('claude-opus-4-6-20260205'), true);
for (const model of [null, {}, [], 'SECRET', 'claude-opus-4-60', 'claude-sonnet-4-5'])
  assert.equal(supportsClaudeAdaptiveThinking(model), false);

// Absolute budgets remain manual. Relative effort must not replace the user's
// hard token budget just because this Claude model supports adaptive mode.
const manual = ai.openAIChatToClaudeMessages(
  { messages: [], thinking: { type: 'enabled', budget_tokens: 4096 }, max_tokens: 8192 },
  'claude-sonnet-4-6'
);
assert.deepEqual(manual.thinking, { type: 'enabled', budget_tokens: 4096 });
assert.equal(manual.output_config, undefined);
const disabled = route({ input: 'question', reasoning: { effort: 'none' } }, 'Claude');
assert.deepEqual(disabled.sent.thinking, { type: 'disabled' });
assert.equal(disabled.sent.output_config, undefined);
const defaultOpenAI = {};
applyReasoningToOpenAI(defaultOpenAI, extractCanonicalReasoning({ reasoning: {} }));
assert.deepEqual(defaultOpenAI, {});

process.stdout.write('native-reasoning-controls.test.js passed\n');
