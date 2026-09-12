'use strict';

const assert = require('node:assert/strict');
const {
  geminiThinkingConfigFromOpenAI,
  parseOpenAIReasoningEffort,
  supportsGeminiThinkingLevel,
} = require('../lib/proxy/gemini-reasoning');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');

assert.deepStrictEqual(parseOpenAIReasoningEffort(null), {
  present: false,
  valid: true,
  effort: null,
});
assert.deepStrictEqual(parseOpenAIReasoningEffort({}), {
  present: false,
  valid: true,
  effort: null,
});
assert.deepStrictEqual(parseOpenAIReasoningEffort({ reasoning_effort: ' HIGH ' }), {
  present: true,
  valid: true,
  effort: 'high',
});
assert.deepStrictEqual(parseOpenAIReasoningEffort({ reasoning: { effort: 'minimal' } }), {
  present: true,
  valid: true,
  effort: 'minimal',
});
assert.deepStrictEqual(
  parseOpenAIReasoningEffort({
    reasoning_effort: 'medium',
    reasoning: { effort: 'medium', summary: 'auto' },
  }),
  { present: true, valid: true, effort: 'medium' }
);
assert.deepStrictEqual(parseOpenAIReasoningEffort({ reasoning: { summary: 'auto' } }), {
  present: true,
  valid: true,
  effort: null,
});

for (const input of [
  { reasoning_effort: 'ultra' },
  { reasoning_effort: 'x'.repeat(100000) },
  { reasoning_effort: 3 },
  { reasoning: 'high' },
  { reasoning: [] },
  { reasoning: { effort: { value: 'high' } } },
  { reasoning_effort: 'low', reasoning: { effort: 'high' } },
]) {
  const result = parseOpenAIReasoningEffort(input);
  assert.strictEqual(result.present, true);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.effort, null);
}

const inherited = Object.create({ reasoning_effort: 'high' });
assert.deepStrictEqual(parseOpenAIReasoningEffort(inherited), {
  present: false,
  valid: true,
  effort: null,
});

assert.strictEqual(supportsGeminiThinkingLevel('gemini-2.5-pro'), false);
assert.strictEqual(supportsGeminiThinkingLevel('models/gemini-3.6-flash'), true);
assert.strictEqual(supportsGeminiThinkingLevel('gemini-4.0-flash'), true);
assert.deepStrictEqual(
  geminiThinkingConfigFromOpenAI({ reasoning_effort: 'none' }, 'gemini-3.6-flash'),
  { thinkingLevel: 'minimal' }
);
assert.deepStrictEqual(
  geminiThinkingConfigFromOpenAI({ reasoning_effort: 'xhigh' }, 'gemini-3.6-flash'),
  { thinkingLevel: 'high' }
);
assert.deepStrictEqual(
  geminiThinkingConfigFromOpenAI({ reasoning_effort: 'minimal' }, 'gemini-3.1-pro-preview'),
  { thinkingLevel: 'low' }
);
assert.deepStrictEqual(
  geminiThinkingConfigFromOpenAI({ reasoning_effort: 'medium' }, 'gemini-3-pro-preview'),
  { thinkingLevel: 'high' }
);
assert.deepStrictEqual(
  geminiThinkingConfigFromOpenAI(
    { reasoning_effort: 'low' },
    'gemini-3.1-flash-lite-image-preview'
  ),
  { thinkingLevel: 'minimal' }
);
assert.strictEqual(
  geminiThinkingConfigFromOpenAI({ reasoning_effort: 'high' }, 'gemini-2.5-pro'),
  null
);
assert.strictEqual(
  geminiThinkingConfigFromOpenAI({ reasoning_effort: 'unsafe-value' }, 'gemini-3.6-flash'),
  null
);

let response = null;
const validators = createRequestValidators({
  sendJsonError(_clientRes, statusCode, payload) {
    response = { statusCode, payload };
  },
});

assert.strictEqual(
  validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    { reasoning_effort: 'high' },
    'Gemini'
  ),
  false
);
assert.strictEqual(
  validators.rejectUnsupportedResponsesNonOpenAIConversion(
    {},
    { reasoning: { effort: 'medium', summary: 'auto' } },
    'Gemini'
  ),
  false
);
assert.strictEqual(
  validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    { reasoning_effort: '<script>alert(1)</script>' },
    'Gemini'
  ),
  true
);
assert.strictEqual(response.statusCode, 400);
assert.doesNotMatch(response.payload.error.message, /script|alert/i);
assert.strictEqual(
  validators.rejectUnsupportedResponsesTools(
    {},
    {
      tools: [{ type: 'namespace', name: 'chat' }],
    }
  ),
  false
);

console.log('[gemini-reasoning.test] ok');
