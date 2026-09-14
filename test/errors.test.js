const assert = require('assert');

const {
  parseRetryAfterHeaderSeconds,
  parseGeminiError,
  geminiErrorToClaude,
  getUpstreamCooldown,
  setUpstreamCooldown,
  getGeminiCooldown,
  setGeminiCooldown,
} = require('../lib/proxy/errors');

const body = JSON.stringify({
  error: {
    code: 429,
    message: 'Quota exceeded. Please retry in 43.024s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaMetric: 'tokens', quotaId: 'InputTokensPerMinute' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '43s' },
    ],
  },
});

const parsed = parseGeminiError(429, body);
assert.strictEqual(parsed.type, 'rate_limit_error');
assert.strictEqual(parsed.retryAfterSeconds, 43);
assert.strictEqual(parsed.quotaId, 'InputTokensPerMinute');
assert.deepStrictEqual(JSON.parse(geminiErrorToClaude(429, body)).error.type, 'rate_limit_error');

const hugeRetry = parseGeminiError(
  429,
  JSON.stringify({ error: { message: 'Please retry in 999999999999999999999s.' } })
);
assert.strictEqual(hugeRetry.retryAfterSeconds, 120);

const cooldown = setGeminiCooldown('google-gemini', 'gemini-3-flash-preview', 2);
assert.strictEqual(cooldown.retryAfterSeconds, 2);
const active = getGeminiCooldown('google-gemini', 'gemini-3-flash-preview');
assert.ok(active.retryAfterSeconds > 0);
assert.strictEqual(
  setGeminiCooldown('google-gemini', 'gemini-3-flash-preview', Infinity).retryAfterSeconds,
  120
);

assert.strictEqual(parseRetryAfterHeaderSeconds('2.2'), 3);
assert.strictEqual(parseRetryAfterHeaderSeconds('Please retry in 4.1s.'), 5);
assert.strictEqual(parseRetryAfterHeaderSeconds(new Date(Date.now() + 160000).toUTCString()), 120);

const upstreamCooldown = setUpstreamCooldown('workbuddy-official', 'deepseek-v4.1-flash', 7);
assert.strictEqual(upstreamCooldown.retryAfterSeconds, 7);
const activeUpstreamCooldown = getUpstreamCooldown('workbuddy-official', 'deepseek-v4.1-flash');
assert.ok(activeUpstreamCooldown.retryAfterSeconds > 0);
assert.strictEqual(getUpstreamCooldown('workbuddy-official', 'glm-5.3'), null);

console.log('[errors.test] ok');
