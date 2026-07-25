const assert = require('assert');

const {
  buildGoogleOfficialModelsResponse,
  googleOfficialModelsFromAvailableModels,
  googleOfficialCodeAssistUrl,
  isGoogleOfficialLoginToken,
  buildGoogleOfficialLoadCodeAssistRequest,
  buildGoogleOfficialAvailableModelsRequest,
  buildGoogleOfficialRetrieveUserQuotaRequest,
  formatGoogleOfficialAvailableModels,
  formatGoogleOfficialUserQuota,
  decodeAntigravityOAuthStateValue,
} = require('../lib/proxy/google-official');
const { createGoogleOfficialRuntime } = require('../lib/proxy/google-official-runtime');
const { createCodeAssist } = require('../lib/proxy/handlers/code-assist');

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function main() {
  const response = buildGoogleOfficialModelsResponse();
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.authMode, 'official-login');
  assert.strictEqual(response.source, 'official-model-config');
  assert.ok(response.models.includes('Gemini 3.6 Flash (Medium)'));
  assert.ok(response.models.includes('Gemini 3.6 Flash (High)'));
  assert.ok(response.models.includes('Gemini 3.6 Flash (Low)'));
  assert.ok(response.models.includes('gemini-3.6-flash'));
  assert.ok(response.models.includes('Gemini 3.5 Flash (Medium)'));
  assert.ok(response.models.includes('gemini-3.5-flash-low'));
  assert.ok(response.models.includes('gemini-3-flash-agent'));
  assert.ok(response.models.includes('gemini-3.5-flash-extra-low'));
  assert.ok(response.models.includes('gemini-3.1'));
  assert.ok(response.models.includes('gemini-3.1-pro-low'));

  const models = googleOfficialModelsFromAvailableModels({
    models: {
      'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash (Medium)' },
      'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)' },
      'gemini-3.5-flash-extra-low': { displayName: 'Gemini 3.5 Flash (Low)' },
    },
  });
  assert.ok(models.includes('Gemini 3.5 Flash (Medium)'));
  assert.ok(models.includes('gemini-3.5-flash-low'));
  assert.ok(models.includes('gemini-3-flash-agent'));
  assert.ok(models.includes('gemini-3.5-flash-extra-low'));

  const codeAssist = createCodeAssist({ fallbackId: () => 'test-id' });
  for (const name of [
    'Gemini 3.6 Flash (Medium)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.6 Flash (Low)',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-low',
  ]) {
    assert.strictEqual(codeAssist.codeAssistModelSelection(name).model, 'gemini-3.6-flash');
  }

  const inner = toBase64Url(
    'token ya29.test-access Bearer refresh 1//test-refresh ' + 'x'.repeat(96)
  );
  const outer = Buffer.from(`oauthTokenInfoSentinelKey ${inner}`).toString('base64');
  const creds = decodeAntigravityOAuthStateValue(outer);
  assert.strictEqual(creds.access_token, 'ya29.test-access');
  assert.strictEqual(creds.refresh_token, '1//test-refresh');
  assert.ok(creds.client_id.includes('apps.googleusercontent.com'));
  assert.strictEqual(creds.__readOnly, true);

  let refreshCalls = 0;
  const runtime = createGoogleOfficialRuntime({
    makeRequest: async () => {
      refreshCalls += 1;
      return {
        statusCode: 200,
        body: JSON.stringify({ access_token: 'ya29.fresh-' + refreshCalls, expires_in: 3600 }),
      };
    },
    googleOfficialCodeAssistUrl,
    googleOfficialModelsFromAvailableModels,
    readAntigravityOfficialCredentialState: () => ({
      credsPath: null,
      source: 'antigravity-state',
      content: {
        access_token: 'ya29.old',
        refresh_token: '1//same-refresh',
        token_type: 'Bearer',
        __readOnly: true,
        __source: 'antigravity-state',
        expiry_date: 1,
      },
    }),
    isGoogleOfficialLoginToken,
    buildGoogleOfficialLoadCodeAssistRequest,
  });

  assert.strictEqual(await runtime.getFreshAntigravityOfficialAccessToken(), 'ya29.fresh-1');
  assert.strictEqual(await runtime.getFreshAntigravityOfficialAccessToken(), 'ya29.fresh-1');
  assert.strictEqual(refreshCalls, 1);

  const probe = buildGoogleOfficialLoadCodeAssistRequest('ya29.google-token');
  assert.strictEqual(
    googleOfficialCodeAssistUrl('loadCodeAssist'),
    'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
  );
  assert.strictEqual(probe.method, 'POST');
  assert.strictEqual(
    probe.fullUrl,
    'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
  );
  assert.strictEqual(probe.headers.authorization, 'Bearer ya29.google-token');
  assert.strictEqual(probe.headers['content-type'], 'application/json');
  const body = JSON.parse(probe.requestBody);
  assert.strictEqual(body.mode, 'HEALTH_CHECK');
  assert.strictEqual(body.metadata.pluginType, 'GEMINI');

  const available = buildGoogleOfficialAvailableModelsRequest('ya29.google-token', 'project-1');
  assert.strictEqual(available.method, 'POST');
  assert.strictEqual(
    available.fullUrl,
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
  );
  assert.strictEqual(available.headers.authorization, 'Bearer ya29.google-token');
  assert.deepStrictEqual(JSON.parse(available.requestBody), { project: 'project-1' });

  const quota = buildGoogleOfficialRetrieveUserQuotaRequest('ya29.google-token', 'project-1');
  assert.strictEqual(
    quota.fullUrl,
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
  );
  assert.deepStrictEqual(JSON.parse(quota.requestBody), {
    project: 'project-1',
    userAgent: 'antigravity',
  });

  const limits = formatGoogleOfficialAvailableModels({
    models: {
      chat_20706: {
        displayName: 'chat_20706',
        quotaInfo: { remainingFraction: 1 },
      },
      tab_flash_lite_preview: {
        displayName: 'tab_flash_lite_preview',
        quotaInfo: { remainingFraction: 1 },
      },
      'gemini-3-pro-high': {
        displayName: 'Gemini 3 Pro High',
        quotaInfo: { remainingFraction: 0.12, resetTime: '2999-01-01T00:00:00Z' },
      },
      'gemini-3-pro-agent': {
        displayName: 'Gemini 3 Pro High',
        quotaInfo: { remainingFraction: 0.12, resetTime: '2999-01-01T00:00:00Z' },
      },
      'claude-sonnet-4-6-thinking': {
        displayName: 'Claude Sonnet 4.6 Thinking',
        quotaInfo: { remainingFraction: 0.75, resetTime: '2999-01-01T00:00:00Z' },
      },
    },
  });
  assert.strictEqual(limits.length, 2);
  assert.strictEqual(
    limits.some((item) => item.modelId.startsWith('chat_')),
    false
  );
  assert.strictEqual(
    limits.some((item) => item.modelId.startsWith('tab_')),
    false
  );
  const low = limits.find((item) => item.modelId === 'gemini-3-pro-high');
  assert.strictEqual(low.remainingPercent, 12);
  assert.strictEqual(low.percent, 12);
  assert.notStrictEqual(low.resetIn, '2h2m');

  const quotaLimits = formatGoogleOfficialUserQuota({
    buckets: [
      {
        modelId: 'gemini-3-flash',
        remainingFraction: 0.25,
        remainingAmount: '25',
        resetTime: '2999-01-01T00:00:00Z',
      },
    ],
  });
  assert.strictEqual(quotaLimits[0].model, 'gemini-3-flash');
  assert.strictEqual(quotaLimits[0].remainingPercent, 25);
  assert.strictEqual(quotaLimits[0].remainingAmount, '25');
}

main()
  .then(() => {
    console.log('[google-official.test] ok');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
