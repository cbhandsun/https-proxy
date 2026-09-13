const assert = require('assert');

const {
  buildGoogleOfficialModelsResponse,
  googleOfficialAudioTranscriptionModelNames,
  googleOfficialImageGenerationModelNames,
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
  assert.ok(response.models.includes('Gemini 3.8 Flash'));
  assert.ok(response.models.includes('Gemini 3.8 Flash Low'));
  assert.ok(response.models.includes('Gemini 3.8 Flash Medium'));
  assert.ok(response.models.includes('Gemini 3.8 Flash High'));
  assert.ok(response.models.includes('gemini-3.8-flash'));
  assert.ok(response.models.includes('gemini-3.8-flash-medium'));
  assert.ok(response.models.includes('Gemini 3.7 Flash'));
  assert.ok(response.models.includes('Gemini 3.7 Flash Low'));
  assert.ok(response.models.includes('Gemini 3.7 Flash Medium'));
  assert.ok(response.models.includes('Gemini 3.7 Flash High'));
  assert.ok(response.models.includes('gemini-3.7-flash'));
  assert.ok(response.models.includes('gemini-3.7-flash-tiered'));
  assert.ok(response.models.includes('gemini-3.7-flash-medium'));
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
  assert.ok(response.models.includes('Gemini 3.5 Transcribe'));
  assert.ok(response.models.includes('gemini-3.5-transcribe'));
  assert.ok(response.models.includes('gemini-3.1-flash-image'));
  assert.ok(response.models.includes('Gemini 3.1 Flash Image'));

  const models = googleOfficialModelsFromAvailableModels({
    models: {
      'gemini-3.8-flash-tiered': {},
      'gemini-3.7-flash-tiered': {},
      'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash (Medium)' },
      'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)' },
      'gemini-3.5-flash-extra-low': { displayName: 'Gemini 3.5 Flash (Low)' },
    },
    audioTranscriptionModelIds: [
      'models/proactive-observer-v10',
      'models/proactive-observer-v10',
      '',
      null,
      42,
      'javascript:alert(1)',
      'models/../../secret',
    ],
    imageGenerationModelIds: [
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-image',
      '',
      null,
      42,
      'javascript:alert(1)',
      '../../secret',
    ],
  });
  assert.ok(models.includes('gemini-3.8-flash'));
  assert.ok(models.includes('Gemini 3.8 Flash Low'));
  assert.ok(models.includes('Gemini 3.8 Flash Medium'));
  assert.ok(models.includes('Gemini 3.8 Flash High'));
  assert.ok(models.includes('gemini-3.8-flash-medium'));
  assert.ok(models.includes('gemini-3.7-flash-tiered'));
  assert.ok(models.includes('Gemini 3.7 Flash Low'));
  assert.ok(models.includes('Gemini 3.7 Flash Medium'));
  assert.ok(models.includes('Gemini 3.7 Flash High'));
  assert.ok(models.includes('gemini-3.7-flash-medium'));
  assert.ok(models.includes('Gemini 3.5 Flash (Medium)'));
  assert.ok(models.includes('gemini-3.5-flash-low'));
  assert.ok(models.includes('gemini-3-flash-agent'));
  assert.ok(models.includes('gemini-3.5-flash-extra-low'));
  assert.ok(models.includes('Gemini 3.5 Transcribe'));
  assert.ok(models.includes('gemini-3.5-transcribe'));
  assert.ok(models.includes('gemini-3.1-flash-image'));
  assert.ok(models.includes('Gemini 3.1 Flash Image'));
  assert.ok(models.includes('proactive-observer-v10'));
  assert.strictEqual(models.filter((name) => name === 'proactive-observer-v10').length, 1);
  assert.ok(!models.includes('javascript:alert(1)'));
  assert.ok(!models.includes('../../secret'));
  assert.deepStrictEqual(googleOfficialAudioTranscriptionModelNames(null), []);
  assert.deepStrictEqual(googleOfficialAudioTranscriptionModelNames({}), []);
  assert.deepStrictEqual(
    googleOfficialAudioTranscriptionModelNames({ audioTranscriptionModelIds: 'invalid' }),
    []
  );
  assert.deepStrictEqual(googleOfficialImageGenerationModelNames(null), []);
  assert.deepStrictEqual(googleOfficialImageGenerationModelNames({}), []);
  assert.deepStrictEqual(
    googleOfficialImageGenerationModelNames({ imageGenerationModelIds: 'invalid' }),
    []
  );
  assert.deepStrictEqual(
    googleOfficialImageGenerationModelNames({
      imageGenerationModelIds: ['models/gemini-3.1-flash-image', '../../secret'],
    }),
    ['models/gemini-3.1-flash-image', 'Gemini 3.1 Flash Image']
  );

  const codeAssist = createCodeAssist({ fallbackId: () => 'test-id' });
  for (const [name, expectedModel, expectedThinkingLevel] of [
    ['Gemini 3.8 Flash', 'gemini-3.8-flash-tiered', undefined],
    ['Gemini 3.8 Flash Medium', 'gemini-3.8-flash-tiered', 'MEDIUM'],
    ['Gemini 3.8 Flash High', 'gemini-3.8-flash-tiered', 'HIGH'],
    ['Gemini 3.8 Flash Low', 'gemini-3.8-flash-tiered', 'LOW'],
    ['Gemini 3.8 Flash (Medium)', 'gemini-3.8-flash-tiered', 'MEDIUM'],
    ['Gemini 3.8 Flash (High)', 'gemini-3.8-flash-tiered', 'HIGH'],
    ['Gemini 3.8 Flash (Low)', 'gemini-3.8-flash-tiered', 'LOW'],
    ['gemini-3.8-flash', 'gemini-3.8-flash-tiered', undefined],
    ['gemini-3.8-flash-tiered', 'gemini-3.8-flash-tiered', undefined],
    ['gemini-3.8-flash-medium', 'gemini-3.8-flash-tiered', 'MEDIUM'],
    ['gemini-3.8-flash-high', 'gemini-3.8-flash-tiered', 'HIGH'],
    ['gemini-3.8-flash-low', 'gemini-3.8-flash-tiered', 'LOW'],
    ['Gemini 3.7 Flash', 'gemini-3.7-flash-tiered', undefined],
    ['Gemini 3.7 Flash Medium', 'gemini-3.7-flash-tiered', 'MEDIUM'],
    ['Gemini 3.7 Flash High', 'gemini-3.7-flash-tiered', 'HIGH'],
    ['Gemini 3.7 Flash Low', 'gemini-3.7-flash-tiered', 'LOW'],
    ['Gemini 3.7 Flash (Medium)', 'gemini-3.7-flash-tiered', 'MEDIUM'],
    ['Gemini 3.7 Flash (High)', 'gemini-3.7-flash-tiered', 'HIGH'],
    ['Gemini 3.7 Flash (Low)', 'gemini-3.7-flash-tiered', 'LOW'],
    ['gemini-3.7-flash', 'gemini-3.7-flash-tiered', undefined],
    ['gemini-3.7-flash-tiered', 'gemini-3.7-flash-tiered', undefined],
    ['gemini-3.7-flash-medium', 'gemini-3.7-flash-tiered', 'MEDIUM'],
    ['gemini-3.7-flash-high', 'gemini-3.7-flash-tiered', 'HIGH'],
    ['gemini-3.7-flash-low', 'gemini-3.7-flash-tiered', 'LOW'],
    ['Gemini 3.6 Flash (Medium)', 'gemini-3.6-flash-medium', undefined],
    ['Gemini 3.6 Flash (High)', 'gemini-3.6-flash-high', undefined],
    ['Gemini 3.6 Flash (Low)', 'gemini-3.6-flash-low', undefined],
    ['gemini-3.6-flash-medium', 'gemini-3.6-flash-medium', undefined],
    ['gemini-3.6-flash-high', 'gemini-3.6-flash-high', undefined],
    ['gemini-3.6-flash-low', 'gemini-3.6-flash-low', undefined],
    ['Gemini 3.5 Transcribe', 'models/proactive-observer-v10', undefined],
    ['gemini-3.5-transcribe', 'models/proactive-observer-v10', undefined],
    ['proactive-observer-v10', 'models/proactive-observer-v10', undefined],
    ['models/proactive-observer-v10', 'models/proactive-observer-v10', undefined],
    ['Gemini 3.1 Flash Image', 'gemini-3.1-flash-image', undefined],
    ['gemini-3.1-flash-image', 'gemini-3.1-flash-image', undefined],
    ['models/gemini-3.1-flash-image', 'gemini-3.1-flash-image', undefined],
  ]) {
    const selection = codeAssist.codeAssistModelSelection(name);
    assert.strictEqual(selection.model, expectedModel);
    assert.strictEqual(selection.thinkingLevel, expectedThinkingLevel);
  }

  const geminiBody = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
  for (const [route, thinkingLevel] of [
    ['Gemini 3.8 Flash Low', 'LOW'],
    ['Gemini 3.8 Flash Medium', 'MEDIUM'],
    ['Gemini 3.8 Flash High', 'HIGH'],
  ]) {
    const request = codeAssist.codeAssistGenerateRequest(
      { model: route, googleOfficialProjectId: 'project-1' },
      geminiBody,
      'gemini-3.8-flash-tiered',
      false
    );
    assert.strictEqual(request.body.model, 'gemini-3.8-flash-tiered');
    assert.deepStrictEqual(request.body.request.generationConfig, {
      thinkingConfig: { thinkingLevel },
    });
  }
  for (const [route, thinkingLevel] of [
    ['Gemini 3.7 Flash Low', 'LOW'],
    ['Gemini 3.7 Flash Medium', 'MEDIUM'],
    ['Gemini 3.7 Flash High', 'HIGH'],
  ]) {
    const request = codeAssist.codeAssistGenerateRequest(
      { model: route, googleOfficialProjectId: 'project-1' },
      geminiBody,
      'gemini-3.7-flash-tiered',
      false
    );
    assert.strictEqual(request.body.model, 'gemini-3.7-flash-tiered');
    assert.deepStrictEqual(request.body.request.generationConfig, {
      thinkingConfig: { thinkingLevel },
    });
  }
  assert.strictEqual(geminiBody.generationConfig, undefined, 'input body must not be mutated');

  const explicitThinking = codeAssist.codeAssistGenerateRequest(
    { model: 'Gemini 3.7 Flash High', googleOfficialProjectId: 'project-1' },
    {
      ...geminiBody,
      generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
    },
    'gemini-3.7-flash-tiered',
    false
  );
  assert.deepStrictEqual(explicitThinking.body.request.generationConfig, {
    thinkingConfig: { thinkingLevel: 'LOW' },
  });

  const defaultThinking = codeAssist.codeAssistGenerateRequest(
    { model: 'Gemini 3.7 Flash', googleOfficialProjectId: 'project-1' },
    geminiBody,
    'gemini-3.7-flash-tiered',
    false
  );
  assert.strictEqual(defaultThinking.body.request.generationConfig, undefined);

  const transcription = codeAssist.codeAssistGenerateRequest(
    { model: 'Gemini 3.5 Transcribe', googleOfficialProjectId: 'project-1' },
    {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Transcribe this audio.' },
            { inlineData: { mimeType: 'audio/wav', data: 'YXVkaW8=' } },
          ],
        },
      ],
    },
    'models/proactive-observer-v10',
    false
  );
  assert.strictEqual(transcription.body.model, 'models/proactive-observer-v10');
  assert.strictEqual(transcription.body.request.generationConfig, undefined);
  assert.deepStrictEqual(transcription.body.request.contents[0].parts[1], {
    inlineData: { mimeType: 'audio/wav', data: 'YXVkaW8=' },
  });

  const imageGeneration = codeAssist.codeAssistGenerateRequest(
    { model: 'gemini-3.1-flash-image', googleOfficialProjectId: 'project-1' },
    {
      contents: [{ role: 'user', parts: [{ text: 'Draw a small red circle.' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    'gemini-3.1-flash-image',
    true
  );
  assert.strictEqual(imageGeneration.body.model, 'gemini-3.1-flash-image');
  assert.deepStrictEqual(imageGeneration.body.request.generationConfig, {
    responseModalities: ['TEXT', 'IMAGE'],
  });

  const inner = toBase64Url(
    'token ya29.test-access Bearer refresh 1//test-refresh ' + 'x'.repeat(96)
  );
  const outer = Buffer.from(`oauthTokenInfoSentinelKey ${inner}`).toString('base64');
  const creds = decodeAntigravityOAuthStateValue(outer);
  assert.strictEqual(creds.access_token, 'ya29.test-access');
  assert.strictEqual(creds.refresh_token, '1//test-refresh');
  assert.ok(creds.client_id.includes('apps.googleusercontent.com'));
  assert.strictEqual(Object.hasOwn(creds, 'client_secret'), false);
  assert.strictEqual(creds.__readOnly, true);

  let refreshCalls = 0;
  let refreshRequestBody = '';
  const runtime = createGoogleOfficialRuntime({
    makeRequest: async (_url, _options, requestBody) => {
      refreshCalls += 1;
      refreshRequestBody = requestBody;
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
    env: {},
  });

  assert.strictEqual(await runtime.getFreshAntigravityOfficialAccessToken(), 'ya29.fresh-1');
  assert.strictEqual(await runtime.getFreshAntigravityOfficialAccessToken(), 'ya29.fresh-1');
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(new URLSearchParams(refreshRequestBody).has('client_secret'), false);

  let freshCredentialRefreshCalls = 0;
  const freshCredentialRuntime = createGoogleOfficialRuntime({
    makeRequest: async () => {
      freshCredentialRefreshCalls += 1;
      return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.unused-refresh' }) };
    },
    googleOfficialCodeAssistUrl,
    googleOfficialModelsFromAvailableModels,
    readAntigravityOfficialCredentialState: () => ({
      credsPath: null,
      source: 'antigravity-credential-manager',
      content: {
        access_token: 'ya29.credential-access',
        refresh_token: '1//credential-refresh',
        token_type: 'Bearer',
        __readOnly: true,
        __source: 'antigravity-credential-manager',
        expiry_date: Date.now() + 3600 * 1000,
      },
    }),
    isGoogleOfficialLoginToken,
    buildGoogleOfficialLoadCodeAssistRequest,
    env: {},
  });

  assert.strictEqual(
    await freshCredentialRuntime.getFreshAntigravityOfficialAccessToken(),
    'ya29.credential-access'
  );
  assert.strictEqual(freshCredentialRefreshCalls, 0);

  let explicitSecretBody = '';
  const explicitSecretRuntime = createGoogleOfficialRuntime({
    makeRequest: async (_url, _options, requestBody) => {
      explicitSecretBody = requestBody;
      return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.explicit' }) };
    },
    env: { GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret' },
  });
  assert.strictEqual(
    await explicitSecretRuntime.refreshGoogleAccessToken(null, {
      client_id: 'test-client-id.apps.googleusercontent.com',
      refresh_token: '1//explicit-refresh',
      __readOnly: true,
    }),
    'ya29.explicit'
  );
  assert.strictEqual(
    new URLSearchParams(explicitSecretBody).get('client_secret'),
    'test-client-secret'
  );

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
