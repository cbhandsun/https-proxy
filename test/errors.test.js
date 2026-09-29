const assert = require('assert');

const {
  parseRetryAfterHeaderSeconds,
  parseGeminiError,
  geminiErrorToClaude,
  normalizeUpstreamError,
  getUpstreamCooldown,
  setUpstreamCooldown,
  listUpstreamCooldowns,
  configureUpstreamCooldownPersistence,
  getGeminiCooldown,
  setGeminiCooldown,
} = require('../lib/proxy/errors');

const memoryCooldownWrites = [];
configureUpstreamCooldownPersistence({
  readPersistedCooldowns: () => [],
  writePersistedCooldowns: (records) => {
    memoryCooldownWrites.push(records);
  },
});

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
assert.strictEqual(
  setUpstreamCooldown('workbuddy-official', 'deepseek-v4.1-flash-long-reset', 3600, {
    maxSeconds: 86400,
    source: 'upstream_reset_time',
  }).retryAfterSeconds,
  3600
);
const workbuddyCooldowns = listUpstreamCooldowns({ profileId: 'workbuddy-official' });
assert.ok(workbuddyCooldowns.some((item) => item.targetModel === 'deepseek-v4.1-flash'));
assert.ok(
  workbuddyCooldowns.some(
    (item) =>
      item.targetModel === 'deepseek-v4.1-flash-long-reset' &&
      item.source === 'upstream_reset_time' &&
      item.resetAt > 0
  )
);

configureUpstreamCooldownPersistence({
  readPersistedCooldowns: () => [
    {
      profileId: 'persisted-profile',
      targetModel: 'persisted-model',
      until: Date.now() + 5000,
      source: 'upstream_reset_time',
    },
  ],
  writePersistedCooldowns: (records) => {
    memoryCooldownWrites.push(records);
  },
});
const restoredCooldown = getUpstreamCooldown('persisted-profile', 'persisted-model');
assert.ok(restoredCooldown.retryAfterSeconds > 0);
assert.strictEqual(restoredCooldown.source, 'upstream_reset_time');
setUpstreamCooldown('persisted-profile', 'new-model', 30, { source: 'local_fallback' });
assert.ok(
  memoryCooldownWrites.some((records) =>
    records.some(
      (record) =>
        record.profileId === 'persisted-profile' &&
        record.targetModel === 'new-model' &&
        record.until > Date.now()
    )
  )
);

assert.deepStrictEqual(
  normalizeUpstreamError(
    429,
    { 'retry-after': '1307' },
    JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2026-09-15 16:21:47 UTC+8 重置。',
      requestId: 'upstream-workbuddy-request',
    }),
    'workbuddy'
  ),
  {
    error: {
      type: 'rate_limit_error',
      message: '您的使用量已超出频率限制，将在 2026-09-15 16:21:47 UTC+8 重置。',
      code: 6004,
      status: 429,
      upstream: 'workbuddy',
      request_id: 'upstream-workbuddy-request',
      retry_after: '1307',
    },
  }
);

assert.deepStrictEqual(
  normalizeUpstreamError(
    401,
    { 'x-request-id': '90becc2354cb' },
    '<html><head><title>401 Authorization Required</title></head><body><center><h1>401 Authorization Required</h1></center><hr><center>openresty</center><p><em>Powered by <a href="https://apisix.apache.org/">APISIX</a>.</em></p></body></html>',
    'workbuddy'
  ),
  {
    error: {
      type: 'api_error',
      message: '401 Authorization Required',
      code: undefined,
      status: 401,
      upstream: 'workbuddy',
      request_id: '90becc2354cb',
      retry_after: undefined,
    },
  }
);

console.log('[errors.test] ok');
