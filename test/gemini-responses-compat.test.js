'use strict';

const assert = require('node:assert/strict');
const {
  ENCRYPTED_REASONING_INCLUDE,
  GEMINI_PROMPT_CACHE_RETENTIONS,
  GEMINI_REASONING_CONTEXTS,
  GEMINI_TEXT_VERBOSITIES,
  MAX_PROMPT_CACHE_KEY_LENGTH,
  geminiResponsesConversionErrorDiagnostics,
  geminiResponsesOptionDiagnostics,
  normalizeGeminiResponsesRequest,
} = require('../lib/proxy/gemini-responses-compat');
const { validateResponsesEndpointOptions } = require('../lib/proxy/responses-endpoint-options');

const source = Object.freeze({
  input: 'question',
  include: Object.freeze([ENCRYPTED_REASONING_INCLUDE]),
  parallel_tool_calls: false,
  prompt_cache_key: 'fixture-thread',
  prompt_cache_retention: '24h',
  reasoning: Object.freeze({ effort: 'medium', context: 'all_turns' }),
  text: Object.freeze({ verbosity: 'low' }),
});
const snapshot = JSON.stringify(source);
const normalized = normalizeGeminiResponsesRequest(source);
assert.equal(JSON.stringify(source), snapshot);
assert.notEqual(normalized, source);
assert.deepEqual(normalized, {
  input: 'question',
  reasoning: { effort: 'medium' },
});
assert.equal(
  validateResponsesEndpointOptions(normalized, 'Gemini', 'gemini-3.8-flash'),
  normalized
);
assert.deepEqual(geminiResponsesOptionDiagnostics(source, normalized), {
  present: [
    'include',
    'parallel_tool_calls',
    'prompt_cache_key',
    'prompt_cache_retention',
    'reasoning',
    'text',
  ],
  removed: ['include', 'parallel_tool_calls', 'prompt_cache_key', 'prompt_cache_retention', 'text'],
  reasoningKeys: ['effort', 'context'],
  reasoningEffort: 'medium',
  reasoningContext: 'all_turns',
  textKeys: ['verbosity'],
  textVerbosity: 'low',
  parallelToolCalls: false,
});

for (const context of GEMINI_REASONING_CONTEXTS) {
  const frozen = Object.freeze({ reasoning: Object.freeze({ effort: 'high', context }) });
  assert.deepEqual(normalizeGeminiResponsesRequest(frozen), { reasoning: { effort: 'high' } });
  assert.equal(frozen.reasoning.context, context);
}
for (const verbosity of GEMINI_TEXT_VERBOSITIES) {
  assert.deepEqual(normalizeGeminiResponsesRequest({ text: { verbosity } }), {});
  assert.deepEqual(
    normalizeGeminiResponsesRequest({ text: { verbosity, format: { type: 'json_object' } } }),
    { text: { format: { type: 'json_object' } } }
  );
}
for (const retention of GEMINI_PROMPT_CACHE_RETENTIONS) {
  assert.deepEqual(normalizeGeminiResponsesRequest({ prompt_cache_retention: retention }), {});
}

for (const invalid of [
  null,
  [],
  'invalid',
  {},
  { include: [] },
  { include: [ENCRYPTED_REASONING_INCLUDE, 'unknown'] },
  { include: ['unknown'] },
  { prompt_cache_key: '' },
  { prompt_cache_key: 'x'.repeat(MAX_PROMPT_CACHE_KEY_LENGTH + 1) },
  { prompt_cache_key: 'unsafe\nkey' },
  { prompt_cache_key: 42 },
  { prompt_cache_retention: '' },
  { prompt_cache_retention: '7d' },
  { reasoning: { effort: 'medium', context: '' } },
  { reasoning: { effort: 'medium', context: 'all-turns' } },
  { reasoning: { effort: 'medium', context: 'x'.repeat(4096) } },
  { reasoning: { effort: 'medium', context: { value: 'all_turns' } } },
  { reasoning: { effort: 'medium', context: 'all_turns\nSECRET' } },
  { text: { verbosity: '' } },
  { text: { verbosity: 'none' } },
  { text: { verbosity: 'x'.repeat(4096) } },
  { text: { verbosity: { value: 'low' } } },
]) {
  assert.equal(normalizeGeminiResponsesRequest(invalid), invalid);
}

assert.deepEqual(
  normalizeGeminiResponsesRequest({
    include: [ENCRYPTED_REASONING_INCLUDE],
    parallel_tool_calls: false,
    prompt_cache_key: 'fixture',
    reasoning: { effort: 'medium', context: 'all_turns' },
    text: { verbosity: 'low' },
  }),
  { reasoning: { effort: 'medium' } }
);
assert.deepEqual(normalizeGeminiResponsesRequest({ parallel_tool_calls: false }), {
  parallel_tool_calls: false,
});

const safeError = new TypeError('SECRET');
safeError.code = 'invalid_request_error';
safeError.stack = 'TypeError: SECRET\n    at fixture (C:\\repo\\safe-file.js:12:34)';
const errorDiagnostic = geminiResponsesConversionErrorDiagnostics(safeError, 'context');
assert.deepEqual(errorDiagnostic, {
  stage: 'context',
  errorCode: 'invalid_request_error',
  errorName: 'TypeError',
  frames: ['safe-file.js:12:34'],
});
assert.ok(!JSON.stringify(errorDiagnostic).includes('SECRET'));
assert.equal(
  geminiResponsesOptionDiagnostics(
    { reasoning: { effort: 'SECRET' } },
    { reasoning: { effort: 'SECRET' } }
  ).reasoningEffort,
  'string'
);

process.stdout.write('gemini-responses-compat.test.js passed\n');
