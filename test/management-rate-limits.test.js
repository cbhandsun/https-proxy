const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const {
  createManagementRateLimitHandlers,
  profileIdFromRateLimitRequest,
} = require('../lib/proxy/handlers/management-rate-limits');

function emptyReq(url) {
  const req = Readable.from([]);
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

function createRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body == null ? '' : String(body);
    },
  };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function invoke(handler, url) {
  return new Promise((resolve) => {
    const res = createRes();
    const originalEnd = res.end.bind(res);
    res.end = (payload) => {
      originalEnd(payload);
      resolve(res);
    };
    handler(emptyReq(url), res);
  });
}

function httpsRequestMock({ statusCode = 200, body = '{}', fail = false, calls = [] } = {}) {
  return (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.end = () => {
      process.nextTick(() => {
        if (fail) {
          req.emit('error', new Error('network down'));
          return;
        }
        const res = Readable.from([Buffer.from(body, 'utf8')]);
        res.statusCode = statusCode;
        callback(res);
      });
    };
    req.destroy = () => {};
    return req;
  };
}

(async () => {
  assert.strictEqual(
    profileIdFromRateLimitRequest(
      emptyReq('/v1/local/auth/rate-limits?profileId= google-official ')
    ),
    'google-official'
  );
  assert.strictEqual(
    profileIdFromRateLimitRequest(emptyReq('/v1/local/auth/rate-limits')),
    'openai-official'
  );

  const profiles = [
    { id: 'openai-official', protocol: 'openai', apiKey: '' },
    { id: 'google-official', protocol: 'gemini', apiKey: 'hpm-enc:google' },
    { id: 'workbuddy-official', protocol: 'workbuddy', apiKey: 'PROXY_MANAGED' },
  ];
  const baseDeps = {
    sendJson,
    makeRequest: async () => ({ statusCode: 500, body: '' }),
    resolveOfficialCredentials: async ({ profile }) => ({ profile }),
    getProfilesSnapshot: () => profiles,
    decryptKey: (value) => (value === 'hpm-enc:google' ? 'ya29.google' : value),
    readLatestLocalRateLimits: () => ({
      ok: true,
      limits: [{ window: '5小时', remainingPercent: 80 }],
      source: 'codex-local-session',
    }),
    listLocalUpstreamCooldowns: ({ profileId }) =>
      profileId === 'workbuddy-official'
        ? [
            {
              profileId,
              targetModel: 'deepseek-v4.1-flash',
              retryAfterSeconds: 3661,
              resetAt: Math.ceil((Date.now() + 3661 * 1000) / 1000),
              source: 'upstream_reset_time',
            },
          ]
        : [],
  };

  const fallbackHandlers = createManagementRateLimitHandlers(baseDeps);
  const missingProfile = await invoke(
    fallbackHandlers.handleLocalRateLimitsRequest,
    '/v1/local/auth/rate-limits?profileId=missing'
  );
  assert.strictEqual(missingProfile.statusCode, 400);
  assert.match(JSON.parse(missingProfile.body).error, /找不到 Profile/);

  const localFallback = await invoke(
    fallbackHandlers.handleLocalRateLimitsRequest,
    '/v1/local/auth/rate-limits?profileId=openai-official'
  );
  assert.strictEqual(localFallback.statusCode, 200);
  const localFallbackBody = JSON.parse(localFallback.body);
  assert.strictEqual(localFallbackBody.ok, true);
  assert.strictEqual(localFallbackBody.source, 'codex-local-session');
  assert.match(localFallbackBody.warning, /未检测到 OpenAI 官方登录凭证/);
  assert.deepStrictEqual(localFallbackBody.cooldowns, []);

  const workBuddyCalls = [];
  const workBuddyHandlers = createManagementRateLimitHandlers({
    ...baseDeps,
    resolveOfficialCredentials: async ({ profile }) => ({
      profile: { ...profile, apiKey: 'workbuddy-access' },
    }),
    httpsRequest: httpsRequestMock({
      fail: true,
      calls: workBuddyCalls,
    }),
  });
  const workBuddy = await invoke(
    workBuddyHandlers.handleLocalRateLimitsRequest,
    '/v1/local/auth/rate-limits?profileId=workbuddy-official'
  );
  const workBuddyBody = JSON.parse(workBuddy.body);
  assert.strictEqual(workBuddy.statusCode, 200);
  assert.strictEqual(workBuddyBody.ok, true);
  assert.strictEqual(workBuddyBody.source, 'local-upstream-cooldowns');
  assert.strictEqual(workBuddyBody.cooldowns[0].targetModel, 'deepseek-v4.1-flash');
  assert.strictEqual(workBuddyBody.cooldowns[0].source, 'upstream_reset_time');
  assert.strictEqual(workBuddyCalls.length, 0);

  const googleCalls = [];
  const googleHandlers = createManagementRateLimitHandlers({
    ...baseDeps,
    makeRequest: async (fullUrl, options, requestBody) => {
      googleCalls.push({ fullUrl, options, requestBody });
      if (fullUrl.includes('loadCodeAssist')) {
        return { statusCode: 200, body: JSON.stringify({ cloudaicompanionProject: 'project-1' }) };
      }
      if (fullUrl.includes('fetchAvailableModels')) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            models: {
              'gemini-3.5-pro': {
                displayName: 'Gemini 3.5 Pro',
                quotaInfo: { remainingFraction: 0.42 },
              },
            },
          }),
        };
      }
      return { statusCode: 500, body: '' };
    },
  });
  const googleAvailable = await invoke(
    googleHandlers.handleLocalRateLimitsRequest,
    '/v1/local/auth/rate-limits?profileId=google-official'
  );
  const googleAvailableBody = JSON.parse(googleAvailable.body);
  assert.strictEqual(googleAvailable.statusCode, 200);
  assert.strictEqual(googleAvailableBody.ok, true);
  assert.strictEqual(googleAvailableBody.source, 'fetchAvailableModels');
  assert.strictEqual(googleAvailableBody.projectId, 'project-1');
  assert.strictEqual(googleAvailableBody.limits[0].remainingPercent, 42);
  assert.ok(googleCalls.some((call) => call.fullUrl.includes('loadCodeAssist')));

  const quotaHandlers = createManagementRateLimitHandlers({
    ...baseDeps,
    makeRequest: async (fullUrl) => {
      if (fullUrl.includes('fetchAvailableModels')) return { statusCode: 503, body: 'busy' };
      if (fullUrl.includes('retrieveUserQuota')) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            buckets: [{ modelId: 'gemini-test', remainingFraction: 0.75 }],
          }),
        };
      }
      return { statusCode: 200, body: JSON.stringify({ cloudaicompanionProject: 'project-2' }) };
    },
  });
  const quota = await invoke(
    quotaHandlers.handleLocalRateLimitsRequest,
    '/v1/local/auth/rate-limits?profileId=google-official'
  );
  const quotaBody = JSON.parse(quota.body);
  assert.strictEqual(quota.statusCode, 200);
  assert.strictEqual(quotaBody.source, 'retrieveUserQuota');
  assert.strictEqual(quotaBody.limits[0].remainingPercent, 75);

  const openAiCalls = [];
  const openAiHandlers = createManagementRateLimitHandlers({
    ...baseDeps,
    resolveOfficialCredentials: async ({ profile }) => ({
      profile: { ...profile, apiKey: 'openai-access' },
    }),
    httpsRequest: httpsRequestMock({
      calls: openAiCalls,
      body: JSON.stringify({
        rate_limits: [
          {
            max_requests: 100,
            remaining: 25,
            window_size_seconds: 3600,
            reset_in_seconds: 600,
          },
        ],
      }),
    }),
  });
  const openAi = await invoke(
    openAiHandlers.handleLocalRateLimitsRequest,
    '/v1/local/auth/rate-limits?profileId=openai-official'
  );
  const openAiBody = JSON.parse(openAi.body);
  assert.strictEqual(openAi.statusCode, 200);
  assert.strictEqual(openAiBody.ok, true);
  assert.strictEqual(openAiBody.source, 'chatgpt-rate-limits');
  assert.strictEqual(openAiBody.limits[0].remainingPercent, 25);
  assert.strictEqual(openAiCalls[0].headers.authorization, 'Bearer openai-access');

  const failedOpenAiHandlers = createManagementRateLimitHandlers({
    ...baseDeps,
    resolveOfficialCredentials: async ({ profile }) => ({
      profile: { ...profile, apiKey: 'openai-access' },
    }),
    httpsRequest: httpsRequestMock({ fail: true }),
  });
  const failedOpenAi = await invoke(
    failedOpenAiHandlers.handleLocalRateLimitsRequest,
    '/v1/local/auth/rate-limits?profileId=openai-official'
  );
  const failedOpenAiBody = JSON.parse(failedOpenAi.body);
  assert.strictEqual(failedOpenAi.statusCode, 200);
  assert.strictEqual(failedOpenAiBody.ok, true);
  assert.match(failedOpenAiBody.warning, /network down/);

  console.log('[management-rate-limits.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
