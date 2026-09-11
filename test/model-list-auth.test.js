const assert = require('assert');

const {
  getTraeOfficialBridgePort,
  getTraeOfficialBridgeUrl,
} = require('../lib/proxy/trae-official');
const {
  geminiGeneratePath,
  isOpenAIOfficialLoginToken,
  isGoogleOfficialLoginToken,
  officialLoginProvider,
  configuredAuthMode,
  inferOfficialProfileAuthMode,
  getModelsUrl,
  isOpenAIOfficialCodexTarget,
  codexOfficialModelsFromCache,
  buildOpenAIOfficialCodexModelsResponse,
  openAIOfficialCodexModelSupport,
  isTraeOfficialTarget,
  isTraeOfficialProfile,
  normalizeTraeOfficialModelName,
  traeModelsFromStateRows,
  buildTraeOfficialModelsResponseFromRows,
  traeOfficialModelSupport,
  buildModelListRequest,
} = require('../openai-proxy');

function buildModelsUrls(targetUrl, protocol) {
  const base = new URL(targetUrl);
  if (protocol === 'gemini') return [new URL('/v1beta/models?pageSize=1000', base.origin)];
  if (protocol === 'claude') {
    if (base.hostname === 'api.deepseek.com')
      return [
        new URL('/models?limit=1000', base.origin),
        new URL(base.pathname.replace(/\/$/, '') + '/v1/models?limit=1000', base.origin),
      ];
    return [
      new URL(base.pathname.replace(/\/$/, '') + '/v1/models?limit=1000', base.origin),
      new URL('/models?limit=1000', base.origin),
    ];
  }
  return [new URL(base.pathname.replace(/\/$/, '') + '/models?limit=1000', base.origin)];
}

function normalizeModels(payload) {
  const items = Array.isArray(payload && payload.data)
    ? payload.data
    : Array.isArray(payload && payload.models)
      ? payload.models
      : [];
  return items
    .map((item) => String(item.id || item.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
}

function prepareModelRequest(requestUrl, headers, apiKey) {
  const nextUrl = new URL(requestUrl.toString());
  const requestHeaders = { ...(headers || {}) };
  if (nextUrl.hostname === 'generativelanguage.googleapis.com') {
    delete requestHeaders.authorization;
    delete requestHeaders['x-api-key'];
    delete requestHeaders['api-key'];
    delete requestHeaders['x-goog-api-key'];
    if (apiKey) nextUrl.searchParams.set('key', apiKey);
  }
  return { requestUrl: nextUrl, requestHeaders };
}

{
  assert.strictEqual(
    geminiGeneratePath('', 'gemini-3-flash-preview', false),
    '/v1beta/models/gemini-3-flash-preview:generateContent'
  );
  assert.strictEqual(
    geminiGeneratePath('/v1', 'gemini 3 flash', true),
    '/v1beta/models/gemini%203%20flash:streamGenerateContent'
  );
}

{
  const urls = buildModelsUrls('http://yhrouter.example:80/v1', 'openai');
  assert.strictEqual(urls[0].toString(), 'http://yhrouter.example/v1/models?limit=1000');
  assert.deepStrictEqual(
    normalizeModels({
      data: [{ id: 'yh/gpt-5.3-codex' }, { id: 'gpt-5.5' }],
    }),
    ['gpt-5.5', 'yh/gpt-5.3-codex']
  );
}

{
  const urls = buildModelsUrls('https://claude.example/anthropic', 'claude');
  assert.deepStrictEqual(
    urls.map((url) => url.toString()),
    [
      'https://claude.example/anthropic/v1/models?limit=1000',
      'https://claude.example/models?limit=1000',
    ]
  );
}

{
  const urls = buildModelsUrls('https://api.deepseek.com/anthropic', 'claude');
  assert.deepStrictEqual(
    urls.map((url) => url.toString()),
    [
      'https://api.deepseek.com/models?limit=1000',
      'https://api.deepseek.com/anthropic/v1/models?limit=1000',
    ]
  );
}

{
  const urls = buildModelsUrls('https://generativelanguage.googleapis.com', 'gemini');
  assert.strictEqual(urls.length, 1);
  assert.strictEqual(
    urls[0].toString(),
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
  );
  assert.deepStrictEqual(
    normalizeModels({
      models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }],
    }),
    ['gemini-2.5-flash', 'gemini-2.5-pro']
  );
}

{
  const { requestUrl, requestHeaders } = prepareModelRequest(
    new URL('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'),
    {
      accept: 'application/json',
      authorization: 'Bearer bad-key',
      'x-api-key': 'bad-key',
      'api-key': 'bad-key',
      'x-goog-api-key': 'bad-key',
    },
    'gemini-key'
  );

  assert.strictEqual(
    requestUrl.toString(),
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=gemini-key'
  );
  assert.deepStrictEqual(requestHeaders, { accept: 'application/json' });
}

{
  assert.strictEqual(
    getModelsUrl('https://api.openai.com/v1', 'openai'),
    'https://api.openai.com/v1/models?limit=1000'
  );
  const request = buildModelListRequest('https://api.openai.com/v1', 'openai', 'sk-proj-test');
  assert.strictEqual(request.method, 'GET');
  assert.strictEqual(request.requestUrl, 'https://api.openai.com/v1/models?limit=1000');
  assert.strictEqual(request.headers.authorization, 'Bearer sk-proj-test');
}

{
  assert.strictEqual(
    getModelsUrl('https://api.deepseek.com/anthropic', 'claude'),
    'https://api.deepseek.com/models?limit=1000'
  );

  const request = buildModelListRequest('https://api.deepseek.com/anthropic', 'claude', 'test-key');
  assert.strictEqual(request.method, 'GET');
  assert.strictEqual(request.requestUrl, 'https://api.deepseek.com/models?limit=1000');
  assert.strictEqual(request.headers['x-api-key'], 'test-key');
  assert.strictEqual(request.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(request.requestUrl.includes('test-key'), false);

  assert.strictEqual(
    getModelsUrl('https://claude.example/anthropic', 'claude'),
    'https://claude.example/anthropic/v1/models?limit=1000'
  );
}

{
  const request = buildModelListRequest(
    'https://chatgpt.com/backend-api/codex',
    'openai',
    'eyJhbGciOiJtest'
  );
  assert.strictEqual(request.method, 'GET');
  assert.strictEqual(request.requestUrl, 'https://chatgpt.com/backend-api/models');
  assert.strictEqual(request.headers.authorization, 'Bearer eyJhbGciOiJtest');
}

{
  const request = buildModelListRequest(
    'https://generativelanguage.googleapis.com',
    'gemini',
    'AIza-api-key'
  );
  const url = new URL(request.requestUrl);
  assert.strictEqual(
    url.origin + url.pathname,
    'https://generativelanguage.googleapis.com/v1beta/models'
  );
  assert.strictEqual(url.searchParams.get('pageSize'), '1000');
  assert.strictEqual(url.searchParams.get('key'), 'AIza-api-key');
  assert.strictEqual(request.headers.authorization, undefined);
  assert.strictEqual(request.headers['x-goog-api-key'], undefined);
}

{
  const request = buildModelListRequest(
    'https://generativelanguage.googleapis.com',
    'gemini',
    'ya29.google-token'
  );
  const url = new URL(request.requestUrl);
  assert.strictEqual(url.searchParams.get('key'), null);
  assert.strictEqual(url.searchParams.get('pageSize'), '1000');
  assert.strictEqual(request.headers.authorization, 'Bearer ya29.google-token');
  assert.strictEqual(request.headers['x-goog-api-key'], undefined);
}

{
  assert.strictEqual(isOpenAIOfficialLoginToken('eyJhbGciOiJtest'), true);
  assert.strictEqual(isOpenAIOfficialLoginToken('sk-proj-test'), false);
  assert.strictEqual(isGoogleOfficialLoginToken('ya29.google-token'), true);
  assert.strictEqual(isGoogleOfficialLoginToken('AIza-api-key'), false);
}

{
  assert.strictEqual(configuredAuthMode({ authMode: 'cli' }), 'official-login');
  assert.strictEqual(configuredAuthMode({ credentialMode: 'api-key' }), 'api-key');
  assert.strictEqual(
    officialLoginProvider({ protocol: 'gemini', authMode: 'official-login' }),
    'google'
  );
  assert.strictEqual(
    officialLoginProvider({ protocol: 'openai', authMode: 'official-login' }),
    'openai'
  );
  assert.strictEqual(
    officialLoginProvider({ protocol: 'trae', authMode: 'official-login' }),
    'trae'
  );
  assert.strictEqual(
    officialLoginProvider({
      targetUrl: 'https://coresg-normal.trae.ai',
      authMode: 'official-login',
    }),
    'trae'
  );
  assert.strictEqual(
    officialLoginProvider({ protocol: 'workbuddy', authMode: 'official-login' }),
    'workbuddy'
  );
  assert.strictEqual(
    officialLoginProvider({
      targetUrl: 'https://copilot.tencent.com',
      authMode: 'official-login',
    }),
    'workbuddy'
  );
  assert.strictEqual(officialLoginProvider({ protocol: 'gemini', authMode: 'api-key' }), '');
}

{
  assert.strictEqual(inferOfficialProfileAuthMode({ apiKey: '' }, 'google'), 'official-login');
  assert.strictEqual(
    inferOfficialProfileAuthMode({ apiKey: 'ya29.google-token' }, 'google'),
    'official-login'
  );
  assert.strictEqual(inferOfficialProfileAuthMode({ apiKey: 'AIza-api-key' }, 'google'), 'api-key');
  assert.strictEqual(
    inferOfficialProfileAuthMode({ authMode: 'api-key', apiKey: '' }, 'google'),
    'api-key'
  );
  assert.strictEqual(
    inferOfficialProfileAuthMode({ authMode: 'official-login', apiKey: 'AIza-api-key' }, 'google'),
    'official-login'
  );
}

{
  const cache = {
    fetched_at: '2026-06-02T13:23:50Z',
    models: [
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        supported_in_api: true,
        visibility: 'list',
        priority: 2,
      },
      { slug: 'gpt-5.3-codex-spark', supported_in_api: false, visibility: 'list', priority: 3 },
      { slug: 'codex-auto-review', supported_in_api: true, visibility: 'hide', priority: 4 },
    ],
  };
  const response = buildOpenAIOfficialCodexModelsResponse(cache);
  assert.strictEqual(isOpenAIOfficialCodexTarget('https://chatgpt.com/backend-api/codex'), true);
  assert.strictEqual(isOpenAIOfficialCodexTarget('https://chatgpt.com/backend-api/models'), false);
  assert.deepStrictEqual(response.models, ['gpt-5.5']);
  assert.deepStrictEqual(response.unsupportedModels, ['gpt-5.3-codex-spark']);
  assert.deepStrictEqual(response.hiddenModels, ['codex-auto-review']);
  assert.deepStrictEqual(
    codexOfficialModelsFromCache(cache).map((m) => m.slug),
    ['gpt-5.5']
  );
}

{
  const cache = {
    models: [
      { slug: 'gpt-5.5', supported_in_api: true, visibility: 'list' },
      { slug: 'gpt-5.3-codex-spark', supported_in_api: false, visibility: 'list' },
      { slug: 'codex-auto-review', supported_in_api: true, visibility: 'hide' },
    ],
  };
  assert.deepStrictEqual(openAIOfficialCodexModelSupport('codex/gpt-5.5', cache), {
    known: true,
    supported: true,
    model: 'gpt-5.5',
    visibility: 'list',
    supportedInApi: true,
  });
  assert.strictEqual(openAIOfficialCodexModelSupport('gpt-5-5', cache).known, false);
  assert.strictEqual(openAIOfficialCodexModelSupport('gpt-image-2.5-sunburst', cache).known, false);
  assert.strictEqual(
    openAIOfficialCodexModelSupport('gpt-5.3-codex-spark', cache).supported,
    false
  );
  assert.strictEqual(openAIOfficialCodexModelSupport('codex-auto-review', cache).supported, false);
}

{
  const rows = [
    {
      key: '7478324853305803784_AI.agent.model.model_list_map',
      value: JSON.stringify({
        solo_coder: [
          {
            name: 'gpt-5.4',
            display_name: 'GPT-5.4',
            model_type: 'reasoning_model',
            is_default: true,
          },
          {
            name: 'gemini-3-pro',
            display_name: 'Gemini-3-Pro-Preview',
            model_type: 'reasoning_model',
          },
        ],
        solo_builder: [
          { name: 'kimi-k2-0905', display_name: 'Kimi-K2-0905', model_type: 'chat_model' },
        ],
      }),
    },
    {
      key: 'AI.agent.modelList',
      value: JSON.stringify([
        { name: 'claude3.5', display_name: 'Claude-3.5-Sonnet', model_type: 'chat_model' },
      ]),
    },
  ];
  const response = buildTraeOfficialModelsResponseFromRows(rows);
  assert.strictEqual(isTraeOfficialTarget('https://coresg-normal.trae.ai/api/ide/v1'), true);
  assert.strictEqual(isTraeOfficialProfile({ id: 'trae-official' }), true);
  assert.strictEqual(normalizeTraeOfficialModelName('trae/gpt-5.4'), 'gpt-5.4');
  assert.deepStrictEqual(response.models, [
    'GPT-5.4',
    'Gemini-3-Pro-Preview',
    'Kimi-K2-0905',
    'Claude-3.5-Sonnet',
  ]);
  assert.strictEqual(response.modelMap['GPT-5.4'], 'gpt-5.4');
  assert.strictEqual(traeModelsFromStateRows(rows).length, 4);
  assert.deepStrictEqual(traeOfficialModelSupport('trae/GPT-5.4', rows), {
    known: true,
    supported: true,
    model: 'gpt-5.4',
    displayName: 'GPT-5.4',
    modelType: 'reasoning_model',
  });
  assert.strictEqual(traeOfficialModelSupport('gpt-unknown', rows).known, false);
}

{
  const previousBridgePort = process.env.TRAE_BRIDGE_PORT;
  const previousOpenAIBridgePort = process.env.TRAE_OPENAI_BRIDGE_PORT;
  const previousBridgeUrl = process.env.TRAE_BRIDGE_URL;
  const previousOpenAIBridgeUrl = process.env.TRAE_OPENAI_BRIDGE_URL;
  try {
    delete process.env.TRAE_BRIDGE_URL;
    delete process.env.TRAE_OPENAI_BRIDGE_URL;

    process.env.TRAE_BRIDGE_PORT = '19001';
    delete process.env.TRAE_OPENAI_BRIDGE_PORT;
    assert.strictEqual(getTraeOfficialBridgePort(), 19001);
    assert.strictEqual(getTraeOfficialBridgeUrl('/health'), 'http://127.0.0.1:19001/health');

    process.env.TRAE_BRIDGE_PORT = 'Infinity';
    process.env.TRAE_OPENAI_BRIDGE_PORT = '19002';
    assert.strictEqual(getTraeOfficialBridgePort(), 19002);

    process.env.TRAE_BRIDGE_PORT = '70000';
    delete process.env.TRAE_OPENAI_BRIDGE_PORT;
    assert.strictEqual(getTraeOfficialBridgePort(), 17861);
  } finally {
    if (previousBridgePort === undefined) delete process.env.TRAE_BRIDGE_PORT;
    else process.env.TRAE_BRIDGE_PORT = previousBridgePort;
    if (previousOpenAIBridgePort === undefined) delete process.env.TRAE_OPENAI_BRIDGE_PORT;
    else process.env.TRAE_OPENAI_BRIDGE_PORT = previousOpenAIBridgePort;
    if (previousBridgeUrl === undefined) delete process.env.TRAE_BRIDGE_URL;
    else process.env.TRAE_BRIDGE_URL = previousBridgeUrl;
    if (previousOpenAIBridgeUrl === undefined) delete process.env.TRAE_OPENAI_BRIDGE_URL;
    else process.env.TRAE_OPENAI_BRIDGE_URL = previousOpenAIBridgeUrl;
  }
}

console.log('[model-list-auth.test] ok');
process.exit(0);
