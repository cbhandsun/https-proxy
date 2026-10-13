'use strict';

const assert = require('node:assert/strict');
const {
  ENCRYPTED_REASONING_INCLUDE,
  MAX_PROMPT_CACHE_KEY_LENGTH,
  WORKBUDDY_PROMPT_CACHE_RETENTIONS,
  WORKBUDDY_REASONING_CONTEXTS,
  WORKBUDDY_REASONING_EFFORTS,
  WORKBUDDY_REASONING_SUMMARIES,
  normalizeWorkBuddyResponsesRequest,
  workBuddyResponsesOptionDiagnostics,
} = require('../lib/proxy/workbuddy-responses-compat');
const { validateResponsesEndpointOptions } = require('../lib/proxy/responses-endpoint-options');

const compatible = Object.freeze({
  model: 'workbuddy/deepseek-v4.1-flash',
  input: 'question',
  include: Object.freeze([ENCRYPTED_REASONING_INCLUDE]),
  prompt_cache_key: 'thread-0123456789',
  prompt_cache_retention: '24h',
  reasoning: Object.freeze({ effort: 'medium', summary: 'auto', context: 'all_turns' }),
});
const compatibleBefore = JSON.stringify(compatible);
const normalized = normalizeWorkBuddyResponsesRequest(compatible);
assert.notEqual(normalized, compatible);
assert.equal(JSON.stringify(compatible), compatibleBefore);
assert.equal(normalized.include, undefined);
assert.equal(normalized.prompt_cache_key, undefined);
assert.equal(normalized.prompt_cache_retention, undefined);
assert.deepEqual(normalized.reasoning, { effort: 'medium' });
assert.deepEqual(workBuddyResponsesOptionDiagnostics(compatible, normalized), {
  present: ['include', 'prompt_cache_key', 'prompt_cache_retention', 'reasoning'],
  retained: ['reasoning'],
  removed: ['include', 'prompt_cache_key', 'prompt_cache_retention'],
  reasoningKeys: ['effort', 'summary', 'context'],
  reasoningAllKeys: ['effort', 'summary', 'context'],
  normalizedReasoningKeys: ['effort'],
  reasoningEffort: 'medium',
  reasoningSummary: 'auto',
  reasoningContext: 'all_turns',
  streamOptionKeys: [],
  textKeys: [],
  textAllKeys: [],
  textVerbosity: 'undefined',
  parallelToolCalls: 'undefined',
});
assert.equal(
  validateResponsesEndpointOptions(normalized, 'Chat', undefined, {
    reasoningEfforts: WORKBUDDY_REASONING_EFFORTS,
  }),
  normalized
);

for (const effort of ['low', 'high', 'xhigh', 'max']) {
  const normalizedEffort = normalizeWorkBuddyResponsesRequest({
    reasoning: { effort, summary: 'auto' },
  });
  assert.deepEqual(normalizedEffort, { reasoning: { effort } });
  assert.equal(
    validateResponsesEndpointOptions(normalizedEffort, 'Chat', undefined, {
      reasoningEfforts: WORKBUDDY_REASONING_EFFORTS,
    }),
    normalizedEffort
  );
}

for (const summary of WORKBUDDY_REASONING_SUMMARIES) {
  const source = Object.freeze({
    reasoning: Object.freeze({ effort: 'medium', summary }),
  });
  const normalizedSummary = normalizeWorkBuddyResponsesRequest(source);
  assert.deepEqual(normalizedSummary, { reasoning: { effort: 'medium' } });
  assert.notEqual(normalizedSummary, source);
  assert.equal(source.reasoning.summary, summary);
  assert.equal(
    validateResponsesEndpointOptions(normalizedSummary, 'Chat', undefined, {
      reasoningEfforts: WORKBUDDY_REASONING_EFFORTS,
    }),
    normalizedSummary
  );
}

for (const promptCacheRetention of WORKBUDDY_PROMPT_CACHE_RETENTIONS) {
  const source = Object.freeze({ prompt_cache_retention: promptCacheRetention });
  const normalizedRetention = normalizeWorkBuddyResponsesRequest(source);
  assert.deepEqual(normalizedRetention, {});
  assert.notEqual(normalizedRetention, source);
  assert.equal(source.prompt_cache_retention, promptCacheRetention);
}

assert.deepEqual(
  workBuddyResponsesOptionDiagnostics(
    {
      input: 'SECRET',
      stream_options: { include_obfuscation: true, secret: 'SECRET' },
      text: { verbosity: 'high', secret: 'SECRET' },
      unknown: 'SECRET',
    },
    {
      input: 'SECRET',
      stream_options: { include_obfuscation: true, secret: 'SECRET' },
      text: { verbosity: 'high', secret: 'SECRET' },
      unknown: 'SECRET',
    }
  ),
  {
    present: ['stream_options', 'text'],
    retained: ['stream_options', 'text'],
    removed: [],
    reasoningKeys: [],
    reasoningAllKeys: [],
    normalizedReasoningKeys: [],
    reasoningEffort: 'undefined',
    reasoningSummary: 'undefined',
    reasoningContext: 'undefined',
    streamOptionKeys: ['include_obfuscation'],
    textKeys: ['verbosity'],
    textAllKeys: ['verbosity', 'secret'],
    textVerbosity: 'high',
    parallelToolCalls: 'undefined',
  }
);

assert.deepEqual(
  workBuddyResponsesOptionDiagnostics(
    {
      parallel_tool_calls: false,
      reasoning: { effort: 'ultra', summary: [] },
      text: { verbosity: 'none' },
    },
    {}
  ),
  {
    present: ['parallel_tool_calls', 'reasoning', 'text'],
    retained: [],
    removed: ['parallel_tool_calls', 'reasoning', 'text'],
    reasoningKeys: ['effort', 'summary'],
    reasoningAllKeys: ['effort', 'summary'],
    normalizedReasoningKeys: [],
    reasoningEffort: 'ultra',
    reasoningSummary: 'object',
    reasoningContext: 'undefined',
    streamOptionKeys: [],
    textKeys: ['verbosity'],
    textAllKeys: ['verbosity'],
    textVerbosity: 'none',
    parallelToolCalls: false,
  }
);

assert.throws(
  () => validateResponsesEndpointOptions({ reasoning: { effort: 'max' } }, 'Chat'),
  (error) => error.code === 'invalid_request_error'
);

for (const source of [
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
  { prompt_cache_retention: 24 },
  { reasoning: { summary: 'auto' } },
  { reasoning: { effort: 'none', summary: 'auto' } },
  { reasoning: { effort: 'medium', summary: '' } },
  { reasoning: { effort: 'medium', summary: 'full' } },
  { reasoning: { effort: 'medium', summary: 'auto', generate_summary: 'detailed' } },
  { reasoning: { effort: 'medium', context: '' } },
  { reasoning: { effort: 'medium', context: 'all-turns' } },
  { reasoning: { effort: 'medium', context: 'x'.repeat(4096) } },
  { reasoning: { effort: 'medium', context: { value: 'all_turns' } } },
  { reasoning: { effort: 'medium', context: 'all_turns\nSECRET' } },
]) {
  assert.equal(normalizeWorkBuddyResponsesRequest(source), source);
}

const deprecated = normalizeWorkBuddyResponsesRequest({
  reasoning: { effort: 'low', generate_summary: 'concise' },
});
assert.deepEqual(deprecated, { reasoning: { effort: 'low' } });

const matchingAliases = normalizeWorkBuddyResponsesRequest({
  reasoning: { effort: 'high', summary: 'auto', generate_summary: 'auto' },
});
assert.deepEqual(matchingAliases, { reasoning: { effort: 'high' } });

for (const context of WORKBUDDY_REASONING_CONTEXTS) {
  const source = Object.freeze({
    reasoning: Object.freeze({ effort: 'medium', context }),
  });
  const normalizedContext = normalizeWorkBuddyResponsesRequest(source);
  assert.deepEqual(normalizedContext, { reasoning: { effort: 'medium' } });
  assert.notEqual(normalizedContext, source);
  assert.equal(source.reasoning.context, context);
  assert.equal(
    validateResponsesEndpointOptions(normalizedContext, 'Chat', undefined, {
      reasoningEfforts: WORKBUDDY_REASONING_EFFORTS,
    }),
    normalizedContext
  );
}

process.stdout.write('workbuddy-responses-compat.test.js passed\n');
