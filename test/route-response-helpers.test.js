'use strict';

const assert = require('node:assert/strict');
const {
  _test,
  createRouteResponseHelpers,
} = require('../lib/proxy/handlers/route-response-helpers');

const events = [];
const helpers = createRouteResponseHelpers({
  log: { error() {} },
  logProxyEvent(type, payload) {
    events.push({ type, payload });
  },
  logRequestEnd(method, path, startTime, status, meta) {
    events.push({ method, path, startTime, status, meta });
  },
  parseGeminiError() {
    return { type: 'rate_limit', retryAfterSeconds: 3 };
  },
  parseRetryAfterHeaderSeconds(value) {
    return /^\d+$/.test(String(value || '')) ? Number(value) : null;
  },
  sendJsonError() {},
  sendUpstreamError(_res, status, headers, _body, provider) {
    events.push({ status, headers, provider });
  },
  setGeminiCooldown() {},
  setUpstreamCooldown(profileId, targetModel, seconds, options) {
    events.push({ profileId, targetModel, seconds, options });
    return { key: profileId + ':' + targetModel, retryAfterSeconds: seconds };
  },
  writeJsonResponse(_res, status, body) {
    events.push({ status, body });
  },
});

assert.deepEqual(helpers.boundedResponseContext({ method: 'POST' }, 10, 'chat'), {
  method: 'POST',
  startTime: 10,
  tooLargeLogType: 'chat_response_too_large',
  errorLogType: 'chat_response_error',
});
assert.deepEqual(
  helpers.proxyErrorContext({ method: 'POST', url: '/v1/messages' }, '/upstream', 10, 'x', 'y'),
  {
    method: 'POST',
    path: '/v1/messages',
    upstreamPath: '/upstream',
    startTime: 10,
    type: 'x',
    logType: 'y',
    logProxyEvent: helpers.proxyErrorContext({ method: 'POST' }, '', 0).logProxyEvent,
    logRequestEnd: helpers.proxyErrorContext({ method: 'POST' }, '', 0).logRequestEnd,
    extra: undefined,
  }
);

helpers.handleConvertedJsonResponse({
  proxyRes: { statusCode: 200, headers: {} },
  clientReq: { method: 'POST' },
  clientRes: {},
  upstreamPath: '/upstream',
  startTime: 10,
  responseBody: '{"ok":true}',
  successType: 'converted',
  convert: JSON.parse,
});
assert.ok(events.some((event) => event.status === 200 && event.body && event.body.ok));

helpers.handleConvertedJsonResponse({
  proxyRes: { statusCode: 503, headers: {} },
  clientReq: { method: 'POST' },
  clientRes: {},
  upstreamPath: '/upstream',
  startTime: 10,
  responseBody: 'unavailable',
  upstreamProvider: 'openai',
  upstreamErrorType: 'upstream_error',
  convert: JSON.parse,
});
assert.ok(events.some((event) => event.status === 503 && event.provider === 'openai'));

helpers.handleConvertedJsonResponse({
  proxyRes: { statusCode: 429, headers: {} },
  clientReq: { method: 'POST' },
  clientRes: {},
  upstreamPath: '/v2/responses',
  startTime: 20,
  responseBody: '{"error":{"message":"rate limited"}}',
  upstreamProvider: 'workbuddy',
  upstreamErrorType: 'responses_to_chat_error',
  rateLimitCooldown: {
    profileId: 'workbuddy-official',
    targetModel: 'deepseek-v4.1-flash',
    fallbackSeconds: 45,
  },
  convert: JSON.parse,
});
assert.ok(
  events.some(
    (event) =>
      event.profileId === 'workbuddy-official' &&
      event.targetModel === 'deepseek-v4.1-flash' &&
      event.seconds === 45
  )
);
assert.ok(events.some((event) => event.status === 429 && event.headers['retry-after'] === '45'));
assert.ok(
  events.some(
    (event) =>
      event.type === 'upstream_rate_limit' &&
      event.payload.retryAfterSeconds === 45 &&
      event.payload.source === 'local_fallback'
  )
);
assert.ok(
  events.some(
    (event) =>
      event.status === 429 &&
      event.meta &&
      event.meta.type === 'responses_to_chat_error' &&
      event.meta.cooldownSource === 'local_fallback'
  )
);

const retryAfterEventStart = events.length;
helpers.handleConvertedJsonResponse({
  proxyRes: { statusCode: 429, headers: { 'retry-after': '90' } },
  clientReq: { method: 'POST' },
  clientRes: {},
  upstreamPath: '/v2/responses',
  startTime: 25,
  responseBody: '{"error":{"message":"rate limited"}}',
  upstreamProvider: 'workbuddy',
  upstreamErrorType: 'responses_to_chat_error',
  rateLimitCooldown: {
    profileId: 'workbuddy-official',
    targetModel: 'deepseek-v4.1-flash',
    fallbackSeconds: 45,
  },
  convert: JSON.parse,
});
const retryAfterEvents = events.slice(retryAfterEventStart);
assert.ok(
  retryAfterEvents.some(
    (event) =>
      event.profileId === 'workbuddy-official' &&
      event.targetModel === 'deepseek-v4.1-flash' &&
      event.seconds === 90 &&
      event.options &&
      event.options.source === 'upstream_retry_after'
  )
);
assert.ok(
  retryAfterEvents.some(
    (event) => event.status === 429 && event.headers && event.headers['retry-after'] === '90'
  )
);
assert.ok(
  retryAfterEvents.some(
    (event) =>
      event.type === 'upstream_rate_limit' &&
      event.payload.retryAfterSeconds === 90 &&
      event.payload.source === 'upstream_retry_after'
  )
);

assert.strictEqual(
  _test.parseResetTimeWithUtcOffset('将在 2026-09-15 16:21:47 UTC+8 重置'),
  Date.UTC(2026, 8, 15, 8, 21, 47)
);
assert.strictEqual(
  _test.parseWorkBuddyResetCooldownSeconds(
    JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2026-09-15 16:21:47 UTC+8 重置。',
    }),
    Date.UTC(2026, 8, 15, 8, 0, 0)
  ),
  1307
);
assert.strictEqual(
  _test.parseWorkBuddyResetCooldownSeconds(
    JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2026-09-16 16:21:47 UTC+8 重置。',
    }),
    Date.UTC(2026, 8, 15, 8, 0, 0)
  ),
  86400
);
assert.strictEqual(_test.parseWorkBuddyResetCooldownSeconds('not json'), null);

helpers.handleConvertedJsonResponse({
  proxyRes: { statusCode: 429, headers: {} },
  clientReq: { method: 'POST' },
  clientRes: {},
  upstreamPath: '/v2/responses',
  startTime: 30,
  responseBody: JSON.stringify({
    code: 6004,
    msg: '您的使用量已超出频率限制，将在 2999-01-01 00:00:00 UTC+8 重置。',
  }),
  upstreamProvider: 'workbuddy',
  upstreamErrorType: 'responses_to_chat_error',
  rateLimitCooldown: {
    profileId: 'workbuddy-official',
    targetModel: 'deepseek-v4.1-flash',
    fallbackSeconds: 45,
  },
  convert: JSON.parse,
});
assert.ok(
  events.some(
    (event) =>
      event.profileId === 'workbuddy-official' &&
      event.targetModel === 'deepseek-v4.1-flash' &&
      event.seconds === 86400 &&
      event.options &&
      event.options.maxSeconds === 86400 &&
      event.options.source === 'upstream_reset_time'
  )
);
assert.ok(
  events.some(
    (event) => event.status === 429 && event.headers && event.headers['retry-after'] === '86400'
  )
);
assert.ok(
  events.some(
    (event) =>
      event.type === 'upstream_rate_limit' &&
      event.payload.retryAfterSeconds === 86400 &&
      event.payload.source === 'upstream_reset_time'
  )
);
assert.ok(
  events.some(
    (event) =>
      event.status === 429 &&
      event.meta &&
      event.meta.type === 'responses_to_chat_error' &&
      event.meta.cooldownSource === 'upstream_reset_time'
  )
);

console.log('[route-response-helpers.test] ok');
