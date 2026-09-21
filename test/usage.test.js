const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _test } = require('../lib/proxy/usage');
const {
  buildUsageReport,
  extractUsageFromJsonPayload,
  estimateCost,
  estimateUsageForRecord,
} = require('../lib/proxy/usage-report');
const usageSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy', 'usage.js'), 'utf8');

const summary = _test.summarizeUsageLines([
  JSON.stringify({
    profileId: 'deepseek',
    model: 'v4',
    inputTokens: '10',
    outputTokens: 5,
    cachedInputTokens: 7,
  }),
  JSON.stringify({ profileId: 'deepseek', model: 'v4', inputTokens: 2, outputTokens: '3' }),
  JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
  JSON.stringify({ profileId: 'bad', model: 'negative', inputTokens: -10, outputTokens: 'nope' }),
  JSON.stringify({
    profileId: 'huge',
    model: 'cap',
    inputTokens: 2000000000,
    outputTokens: 2000000001,
  }),
  'not json',
]);

assert.strictEqual(summary.totalInput, 1000000013);
assert.strictEqual(summary.totalOutput, 1000000009);
assert.strictEqual(summary.totalCachedInput, 7);
assert.deepStrictEqual(summary.byProfile.deepseek.models.v4, {
  input: 12,
  output: 8,
  cachedInput: 7,
});
assert.deepStrictEqual(summary.byProfile.unknown.models.unknown, {
  input: 1,
  output: 1,
  cachedInput: 0,
});
assert.deepStrictEqual(summary.byProfile.bad.models.negative, {
  input: 0,
  output: 0,
  cachedInput: 0,
});
assert.deepStrictEqual(summary.byProfile.huge.models.cap, {
  input: 1000000000,
  output: 1000000000,
  cachedInput: 0,
});
assert.strictEqual(summary.byProfile.deepseek.cachedInput, 7);

assert.strictEqual(_test.compactUsageString('x'.repeat(600)).length, 526);
assert.strictEqual(_test.compactUsageString('', 'fallback'), 'fallback');
assert.ok(
  !/appendFileSync\(\s*USAGE_LOG_FILE/.test(usageSource),
  'usage logging should not synchronously append on the request path'
);

const normalized = _test.normalizeUsageRecord({
  profileId: 'p'.repeat(600),
  model: '',
  inputTokens: -10,
  outputTokens: 2000000001,
  cachedInputTokens: 900,
  type: 't'.repeat(100),
});
assert.ok(normalized.profileId.endsWith('...[truncated]'));
assert.strictEqual(normalized.model, 'unknown');
assert.strictEqual(normalized.inputTokens, 0);
assert.strictEqual(normalized.outputTokens, 1000000000);
assert.strictEqual(normalized.cachedInputTokens, 900);
assert.strictEqual(normalized.type.length, 78);

const contextNormalized = _test.normalizeUsageRecord({
  profileId: 'p1',
  model: 'gpt-5.5',
  inputTokens: 10,
  outputTokens: 2,
  cachedInputTokens: 8,
  context: {
    contextDiagnostics: true,
    contextDroppedCount: 3,
    contextOptimizedCount: 2,
    contextOverBudgetTokens: 1,
    contextStablePrefixCandidate: true,
    providerCacheCandidate: true,
    providerCacheApplied: false,
    prompt: 'private prompt must not appear',
  },
  contextDiagnosticsMissingReason: 'direct-responses-passthrough',
});
assert.strictEqual(contextNormalized.contextDiagnostics, true);
assert.strictEqual(contextNormalized.contextDroppedCount, 3);
assert.strictEqual(contextNormalized.contextOptimizedCount, 2);
assert.strictEqual(contextNormalized.contextOverBudgetTokens, 1);
assert.strictEqual(contextNormalized.contextStablePrefixCandidate, true);
assert.strictEqual(contextNormalized.providerCacheCandidate, true);
assert.strictEqual(contextNormalized.providerCacheApplied, false);
assert.strictEqual(
  contextNormalized.contextDiagnosticsMissingReason,
  'direct-responses-passthrough'
);
assert.ok(!JSON.stringify(contextNormalized).includes('private prompt'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-usage-jsonl-'));
try {
  const usageFile = path.join(tmpDir, 'usage.jsonl');
  const rotated = usageFile + '.1';
  fs.writeFileSync(usageFile, 'x'.repeat(80), 'utf8');
  assert.strictEqual(_test.rotateUsageFileIfNeeded(usageFile, 100, 64), true);
  assert.strictEqual(fs.existsSync(rotated), true);
  assert.strictEqual(fs.existsSync(usageFile), false);

  const recordLine = _test.usageLogLine({
    profileId: 'profile',
    model: 'model',
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 1,
  });
  assert.ok(recordLine.endsWith('\n'));
  fs.writeFileSync(usageFile, recordLine + 'not json\n', 'utf8');
  const fileSummary = _test.summarizeUsageLines(
    fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean)
  );
  assert.deepStrictEqual(fileSummary.byProfile.profile.models.model, {
    input: 1,
    output: 2,
    cachedInput: 1,
  });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const providerUsage = extractUsageFromJsonPayload({
  usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
});
assert.deepStrictEqual(providerUsage, {
  inputTokens: 1000,
  outputTokens: 500,
  cachedInputTokens: 0,
  totalTokens: 1500,
  source: 'provider',
});

// Regression: cache hits were always reported as 0 because the reader looked for
// singular `input_token_details.cache_read`, which is not a field any upstream sends.
// OpenAI Responses reports input_tokens_details.cached_tokens; Anthropic-compatible
// providers report cache_read_input_tokens; DeepSeek uses prompt_cache_hit_tokens.
assert.strictEqual(
  extractUsageFromJsonPayload({
    usage: {
      input_tokens: 1234,
      output_tokens: 56,
      input_tokens_details: { cached_tokens: 900 },
      total_tokens: 1290,
    },
  }).cachedInputTokens,
  900,
  'OpenAI Responses input_tokens_details.cached_tokens must be captured'
);
assert.strictEqual(
  extractUsageFromJsonPayload({
    usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 800 },
  }).cachedInputTokens,
  800,
  'DeepSeek prompt_cache_hit_tokens must be captured'
);

{
  // Claude reports cache reads outside input_tokens, so inputTokens must be folded up
  // to the real prompt size. Otherwise estimateCost() subtracts the cached portion from
  // a prompt that never contained it and the cached tokens vanish from cost entirely.
  const claudeUsage = extractUsageFromJsonPayload({
    usage: {
      input_tokens: 117,
      output_tokens: 222,
      cache_read_input_tokens: 174848,
      cache_creation_input_tokens: 0,
    },
  });
  assert.strictEqual(claudeUsage.cachedInputTokens, 174848);
  assert.strictEqual(claudeUsage.inputTokens, 174965);
  assert.strictEqual(claudeUsage.totalTokens, 175187);
}

{
  // Providers that already fold cache hits into the prompt total must not be summed
  // twice, or the reported prompt would exceed what the upstream actually billed.
  const folded = extractUsageFromJsonPayload({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 800,
      total_tokens: 1010,
    },
  });
  assert.strictEqual(folded.inputTokens, 1000, 'folded cache hits must not double-count');
}

const cost = estimateCost(providerUsage, 'gpt-5-mini', {});
assert.strictEqual(cost.known, true);
assert.ok(cost.amount > 0);
assert.strictEqual(
  extractUsageFromJsonPayload({
    usage: { prompt_tokens: -100, completion_tokens: Infinity, total_tokens: 999999999999 },
  }).totalTokens,
  1000000000
);
assert.strictEqual(
  estimateCost(providerUsage, 'custom-expensive', {
    modelPricing: [{ match: 'custom-expensive', inputPerMillion: Infinity, outputPerMillion: 1 }],
  }).known,
  false
);

const report = buildUsageReport(
  [
    {
      id: 'req-1',
      time: '2026-06-05T10:00:00.000Z',
      profileId: 'openai-main',
      profileName: 'OpenAI Main',
      originalModel: 'gpt-5-mini',
      rewriteModel: 'gpt-5-mini',
      protocol: 'openai',
      statusCode: 200,
      usage: providerUsage,
      contextDiagnostics: {
        contextBudget: {
          optimizedCount: 2,
          droppedCount: 1,
          overBudgetTokens: 0,
          savedChars: 3000,
          prompt: 'private prompt must not appear',
          contextCache: {
            candidate: true,
            stablePrefixHash: 'prefix-hash-only',
            privateText: 'secret context must not appear',
          },
        },
        providerCache: {
          enabled: true,
          candidate: true,
          applied: false,
          provider: 'openai',
          prompt: 'private provider prompt must not appear',
        },
      },
    },
    {
      id: 'req-2',
      time: '2026-06-05T11:00:00.000Z',
      profileId: 'openai-main',
      profileName: 'OpenAI Main',
      originalModel: 'gpt-5-mini',
      statusCode: 500,
      messages: [{ role: 'user', content: 'hello' }],
      response: { content: 'error' },
    },
    {
      id: 'req-3',
      time: '2026-06-05T12:00:00.000Z',
      profileId: 'bad-usage',
      profileName: 'Bad Usage',
      originalModel: 'gpt-5-mini',
      statusCode: 200,
      usage: {
        inputTokens: -10,
        outputTokens: Infinity,
        cachedInputTokens: -1,
        totalTokens: 999999999999,
      },
      cost: { known: true, amount: Infinity },
      contextDiagnostics: {
        contextBudget: {
          overBudgetTokens: 12,
          savedChars: Infinity,
          contextCache: { candidate: false },
        },
        providerCache: {
          enabled: true,
          candidate: true,
          applied: true,
        },
      },
    },
  ],
  {}
);

assert.strictEqual(report.total.requests, 3);
assert.strictEqual(report.total.successes, 2);
assert.strictEqual(report.total.errors, 1);
assert.strictEqual(report.total.providerRecords, 1);
assert.ok(report.byProfile.some((item) => item.key === 'openai-main'));
assert.ok(report.total.inputTokens >= 1000);
assert.strictEqual(report.byProfile.find((item) => item.key === 'bad-usage').inputTokens, 0);
assert.ok(report.total.cost > 0);
assert.ok(report.recent[0].usageCalibration);
assert.deepStrictEqual(report.total.context, {
  records: 2,
  missingDiagnostics: 1,
  attentionRecords: 2,
  overBudgetRecords: 1,
  optimizedRecords: 1,
  droppedRecords: 1,
  optimizedMessages: 2,
  droppedMessages: 1,
  overBudgetTokens: 12,
  savedChars: 3000,
  stablePrefixCandidates: 1,
  providerCacheEnabled: 2,
  providerCacheCandidates: 2,
  providerCacheApplied: 1,
});
assert.strictEqual(
  report.byProfile.find((item) => item.key === 'openai-main').context.missingDiagnostics,
  1
);
assert.strictEqual(report.byModel.find((item) => item.key === 'gpt-5-mini').context.records, 2);
assert.ok(!JSON.stringify(report.total.context).includes('private prompt'));
assert.ok(!JSON.stringify(report.total.context).includes('secret context'));

// Regression: the captured request body is truncated for storage (120000 chars by
// default), so estimating from it reported 30000 input tokens for a live 2.6 MB
// request. When the body is truncated the true serialized byte count must be used.
{
  const truncated = estimateUsageForRecord({
    system: '',
    messages: [],
    request: { body: 'x'.repeat(120000), truncated: true, bodyBytes: 2630287 },
    response: { content: 'short' },
  });
  assert.strictEqual(truncated.source, 'estimated');
  assert.strictEqual(truncated.inputTokens, Math.ceil(2630287 / 4));
  assert.ok(
    truncated.inputTokens > 120000 / 4,
    'a truncated body must not cap the estimate at the stored character count'
  );
}

// An untruncated body keeps the character-based estimate.
{
  const full = estimateUsageForRecord({
    system: 'sys',
    messages: [{ role: 'user', content: 'hello world' }],
    request: { body: '{"alpha":1}', truncated: false, bodyBytes: 11 },
    response: { content: '' },
  });
  // Character-based path: the stored body plus system/messages, ~4 chars per token.
  assert.strictEqual(full.inputTokens, 8);
  assert.ok(full.inputTokens < 1000, 'a small untruncated body must not be inflated');
}

// Missing bodyBytes falls back to the stored body rather than throwing.
{
  const fallback = estimateUsageForRecord({
    system: '',
    messages: [],
    request: { body: 'y'.repeat(1000), truncated: true },
    response: {},
  });
  assert.strictEqual(fallback.inputTokens, 250);
}

// A record with no request at all must not throw.
{
  const empty = estimateUsageForRecord({ system: '', messages: [], response: {} });
  assert.strictEqual(empty.inputTokens, 0);
  assert.strictEqual(empty.source, 'estimated');
}

console.log('[usage.test] ok');
