const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _test } = require('../lib/proxy/usage');
const {
  buildUsageReport,
  extractUsageFromJsonPayload,
  estimateCost,
} = require('../lib/proxy/usage-report');
const usageSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy', 'usage.js'), 'utf8');

const summary = _test.summarizeUsageLines([
  JSON.stringify({ profileId: 'deepseek', model: 'v4', inputTokens: '10', outputTokens: 5 }),
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
assert.deepStrictEqual(summary.byProfile.deepseek.models.v4, { input: 12, output: 8 });
assert.deepStrictEqual(summary.byProfile.unknown.models.unknown, { input: 1, output: 1 });
assert.deepStrictEqual(summary.byProfile.bad.models.negative, { input: 0, output: 0 });
assert.deepStrictEqual(summary.byProfile.huge.models.cap, {
  input: 1000000000,
  output: 1000000000,
});

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
  type: 't'.repeat(100),
});
assert.ok(normalized.profileId.endsWith('...[truncated]'));
assert.strictEqual(normalized.model, 'unknown');
assert.strictEqual(normalized.inputTokens, 0);
assert.strictEqual(normalized.outputTokens, 1000000000);
assert.strictEqual(normalized.type.length, 78);

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
  });
  assert.ok(recordLine.endsWith('\n'));
  fs.writeFileSync(usageFile, recordLine + 'not json\n', 'utf8');
  const fileSummary = _test.summarizeUsageLines(
    fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean)
  );
  assert.deepStrictEqual(fileSummary.byProfile.profile.models.model, { input: 1, output: 2 });
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
    },
  ],
  {}
);

assert.strictEqual(report.total.requests, 3);
assert.strictEqual(report.total.successes, 2);
assert.strictEqual(report.total.errors, 1);
assert.ok(report.byProfile.some((item) => item.key === 'openai-main'));
assert.ok(report.total.inputTokens >= 1000);
assert.strictEqual(report.byProfile.find((item) => item.key === 'bad-usage').inputTokens, 0);
assert.ok(report.total.cost > 0);

console.log('[usage.test] ok');
