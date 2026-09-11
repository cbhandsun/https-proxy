const assert = require('assert');

const { getModelRoutes } = require('../lib/proxy/config');
const {
  buildLocalClaudeModelObject,
  buildLocalModelsResponse,
  clientProtocolsForRoute,
  handleModelsRequest,
  hideCompatibilityAliases,
  inferModelGroupFromId,
  localModelRoutesForClientProtocol,
  modelGroupForRoute,
  normalizeModelGroup,
  parseModelsRequestPath,
} = require('../lib/proxy/models');

assert.deepStrictEqual(
  buildLocalModelsResponse([
    { from: 'claude-haiku-4-5-20251001', profileId: 'yhrouter', to: 'gpt-5.5' },
    { from: 'claude-gemini', profileId: 'google-gemini', to: 'gemini-3-flash-preview' },
    { from: 'claude-haiku-4-5-20251001', profileId: 'other', to: 'other-model' },
  ]),
  {
    object: 'list',
    data: [
      {
        id: 'claude-gemini',
        name: 'claude-gemini',
        group: 'claude',
        object: 'model',
        created: 0,
        owned_by: 'local-proxy',
        root: 'claude-gemini',
        parent: null,
        permission: [],
      },
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'claude-haiku-4-5-20251001',
        group: 'claude',
        object: 'model',
        created: 0,
        owned_by: 'local-proxy',
        root: 'claude-haiku-4-5-20251001',
        parent: null,
        permission: [],
      },
    ],
  }
);

assert.deepStrictEqual(
  buildLocalModelsResponse(
    [
      { from: 'claude-haiku-4-5-20251001', profileId: 'yhrouter', to: 'gpt-5.5' },
      { from: 'claude-gemini', profileId: 'google-gemini', to: 'gemini-3-flash-preview' },
    ],
    'claude'
  ),
  {
    data: [
      {
        id: 'claude-gemini',
        type: 'model',
        display_name: 'claude-gemini',
        group: 'claude',
        created_at: '1970-01-01T00:00:00.000Z',
      },
      {
        id: 'claude-haiku-4-5-20251001',
        type: 'model',
        display_name: 'claude-haiku-4-5-20251001',
        group: 'claude',
        created_at: '1970-01-01T00:00:00.000Z',
      },
    ],
    has_more: false,
    first_id: 'claude-gemini',
    last_id: 'claude-haiku-4-5-20251001',
  }
);
assert.deepStrictEqual(buildLocalClaudeModelObject('claude-gemini'), {
  id: 'claude-gemini',
  type: 'model',
  display_name: 'claude-gemini',
  group: 'claude',
  created_at: '1970-01-01T00:00:00.000Z',
});

assert.deepStrictEqual(parseModelsRequestPath('/v1/models'), { kind: 'list' });
assert.deepStrictEqual(parseModelsRequestPath('/models'), { kind: 'list' });
assert.deepStrictEqual(parseModelsRequestPath('/v1/models/claude-gemini'), {
  kind: 'retrieve',
  id: 'claude-gemini',
});
assert.deepStrictEqual(parseModelsRequestPath('/models/claude-gemini'), {
  kind: 'retrieve',
  id: 'claude-gemini',
});

const explicitRoutes = [
  { from: 'claude-gemini', profileId: 'google-gemini', to: 'gemini-3-flash-preview' },
];
assert.strictEqual(buildLocalModelsResponse(explicitRoutes, 'claude').data[0].type, 'model');
assert.strictEqual(
  buildLocalModelsResponse(explicitRoutes, 'claude').data[0].display_name,
  'claude-gemini'
);
assert.strictEqual(buildLocalModelsResponse(explicitRoutes, 'openai').object, 'list');
assert.strictEqual(buildLocalModelsResponse(explicitRoutes, 'openai').data[0].object, 'model');
assert.deepStrictEqual(
  buildLocalModelsResponse(
    [
      { from: 'visible', profileId: 'p1', to: 'upstream' },
      { from: 'compatibility-alias', profileId: 'p1', to: 'upstream', exposeInModels: false },
    ],
    'openai'
  ).data.map((item) => item.id),
  ['visible']
);

assert.strictEqual(normalizeModelGroup('  DeepSeek  '), 'deepseek');
assert.strictEqual(normalizeModelGroup('图像 模型'), '图像 模型');
assert.strictEqual(normalizeModelGroup('36548dd7-a197-4ebd-a096-8693f0ae1d8f'), '');
assert.strictEqual(normalizeModelGroup('<script>'), '');
assert.strictEqual(normalizeModelGroup('x'.repeat(65)), '');
assert.strictEqual(inferModelGroupFromId('trae/gemini-3-pro'), 'trae');
assert.strictEqual(inferModelGroupFromId('Gemini 3.7 Flash High'), 'gemini');
assert.strictEqual(inferModelGroupFromId('gpt-5.6-sol'), 'gpt');
assert.strictEqual(inferModelGroupFromId('default'), '');
assert.strictEqual(inferModelGroupFromId('bad\nvalue'), '');
assert.strictEqual(
  modelGroupForRoute({
    from: 'default',
    to: 'gpt-5.5',
    profileId: '36548dd7-a197-4ebd-a096-8693f0ae1d8f',
  }),
  'gpt'
);
assert.strictEqual(
  modelGroupForRoute({ from: 'custom-model', to: 'upstream', group: 'Vision Models' }),
  'vision models'
);
assert.strictEqual(
  modelGroupForRoute({ from: 'custom-model', group: '<img onerror=alert(1)>' }),
  'custom'
);
assert.deepStrictEqual(
  hideCompatibilityAliases([
    { from: 'Gemini 3.7 Flash', profileId: 'google', to: 'gemini-tiered' },
    { from: 'gemini-3.7-flash', profileId: 'google', to: 'gemini-tiered' },
    { from: 'Friendly Only', profileId: 'custom', to: 'bare' },
    { from: 'hidden-alias', profileId: 'custom', to: 'hidden', exposeInModels: false },
  ]).map((route) => route.from),
  ['gemini-3.7-flash', 'Friendly Only']
);

const groupedFriendlyModel = buildLocalModelsResponse([
  {
    from: 'gemini-3.7-flash-high',
    to: 'gemini-3.7-flash-tiered',
    profileId: 'google-official',
    labelOverride: 'Gemini 3.7 Flash High',
    group: 'Gemini',
  },
]).data[0];
assert.strictEqual(groupedFriendlyModel.id, 'gemini-3.7-flash-high');
assert.strictEqual(groupedFriendlyModel.name, 'Gemini 3.7 Flash High');
assert.strictEqual(groupedFriendlyModel.group, 'gemini');

const multimodalModel = buildLocalModelsResponse([
  {
    from: 'gemini-3.7-flash',
    profileId: 'google-official',
    to: 'gemini-3.7-flash-tiered',
    capabilities: [
      'function-call',
      'reasoning',
      'image-recognition',
      'audio-recognition',
      'video-recognition',
      '',
      '<script>',
      42,
    ],
    inputModalities: ['text', 'image', 'audio', 'video'],
    outputModalities: ['text'],
    supportsStreaming: true,
  },
]).data[0];
assert.deepStrictEqual(multimodalModel.capabilities, [
  'function-call',
  'reasoning',
  'image-recognition',
  'audio-recognition',
  'video-recognition',
]);
assert.deepStrictEqual(multimodalModel.input_modalities, ['text', 'image', 'audio', 'video']);
assert.deepStrictEqual(multimodalModel.inputModalities, ['text', 'image', 'audio', 'video']);
assert.deepStrictEqual(multimodalModel.output_modalities, ['text']);
assert.strictEqual(multimodalModel.supports_streaming, true);
assert.strictEqual(multimodalModel.supports_tools, true);
assert.strictEqual(multimodalModel.supports_reasoning, true);
assert.strictEqual(multimodalModel.supports_vision, true);
assert.strictEqual(multimodalModel.supports_audio, true);
assert.strictEqual(multimodalModel.supports_transcription, false);
assert.strictEqual(multimodalModel.supports_video, true);

const transcriptionModel = buildLocalModelsResponse([
  {
    from: 'Gemini 3.5 Transcribe',
    profileId: 'google-official',
    to: 'models/proactive-observer-v10',
    capabilities: ['audio-recognition', 'audio-transcription'],
    inputModalities: ['audio'],
    outputModalities: ['text'],
    supportsStreaming: false,
  },
]).data[0];
assert.strictEqual(transcriptionModel.supports_audio, true);
assert.strictEqual(transcriptionModel.supports_transcription, true);
assert.strictEqual(transcriptionModel.supports_streaming, false);
assert.deepStrictEqual(transcriptionModel.input_modalities, ['audio']);
assert.deepStrictEqual(transcriptionModel.output_modalities, ['text']);

const imageGenerationModel = buildLocalModelsResponse([
  {
    from: 'gemini-3.1-flash-image',
    profileId: 'google-official',
    to: 'gemini-3.1-flash-image',
    capabilities: ['image-input', 'image-generation'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text', 'image'],
    supportsStreaming: true,
  },
]).data[0];
assert.strictEqual(imageGenerationModel.supports_vision, true);
assert.strictEqual(imageGenerationModel.supports_image_generation, true);
assert.deepStrictEqual(imageGenerationModel.input_modalities, ['text', 'image']);
assert.deepStrictEqual(imageGenerationModel.output_modalities, ['text', 'image']);

assert.deepStrictEqual(clientProtocolsForRoute({ from: 'claude-sonnet-4-6' }), ['claude']);
assert.deepStrictEqual(clientProtocolsForRoute({ from: 'codex/gpt-5.5' }), [
  'openai-chat',
  'openai-responses',
]);
assert.deepStrictEqual(clientProtocolsForRoute({ from: 'Dola-Seed-2.0-Code' }), [
  'openai-chat',
  'openai-responses',
]);
assert.deepStrictEqual(
  clientProtocolsForRoute({
    from: 'custom-router',
    clientProtocols: ['claude', 'responses', 'openai-chat', 'claude'],
  }),
  ['claude', 'openai-responses', 'openai-chat']
);

const mixedRoutes = [
  { from: 'claude-sonnet-4-6', profileId: 'p1', to: 'gpt-5.4' },
  { from: 'codex/gpt-5.5', profileId: 'p2', to: 'gpt-5.5' },
  { from: 'custom-claude', profileId: 'p3', to: 'custom', clientProtocols: ['claude'] },
  {
    from: 'custom-openai',
    profileId: 'p4',
    to: 'custom',
    clientProtocols: ['openai-chat', 'openai-responses'],
  },
];
assert.deepStrictEqual(
  localModelRoutesForClientProtocol(mixedRoutes, 'claude').map((route) => route.from),
  ['claude-sonnet-4-6', 'custom-claude']
);
assert.deepStrictEqual(
  localModelRoutesForClientProtocol(mixedRoutes, 'openai-chat').map((route) => route.from),
  ['codex/gpt-5.5', 'custom-openai']
);
assert.deepStrictEqual(
  buildLocalModelsResponse(mixedRoutes, 'openai', 'openai-responses').data.map((item) => item.id),
  ['codex/gpt-5.5', 'custom-openai']
);

const desktopRoutes = getModelRoutes({
  modelRoutes: [{ from: 'claude-opus-4-8', profileId: 'openai-official', to: 'gpt-5.5' }],
  claudeDesktop: {
    models: [{ routeId: 'claude-opus-4-8', labelOverride: 'GPT-5.5', supports1m: true }],
  },
});

assert.strictEqual(desktopRoutes[0].labelOverride, 'GPT-5.5');
assert.strictEqual(desktopRoutes[0].supports1m, true);
assert.deepStrictEqual(buildLocalModelsResponse(desktopRoutes, 'claude').data[0], {
  id: 'claude-opus-4-8',
  type: 'model',
  display_name: 'GPT-5.5',
  group: 'claude',
  created_at: '1970-01-01T00:00:00.000Z',
  supports1m: true,
});

function createModelResponse() {
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

const listRes = createModelResponse();
const listResult = handleModelsRequest(
  { method: 'GET', url: '/v1/models', headers: {} },
  listRes,
  { kind: 'list' },
  mixedRoutes,
  'openai',
  'openai-chat'
);
assert.deepStrictEqual(listResult, { status: 200, format: 'openai', modelCount: 2 });

const missingRes = createModelResponse();
const missingResult = handleModelsRequest(
  { method: 'GET', url: '/v1/models/missing', headers: {} },
  missingRes,
  { kind: 'retrieve', id: 'missing' },
  mixedRoutes,
  'openai',
  'openai-chat'
);
assert.strictEqual(missingResult.status, 404);
assert.strictEqual(JSON.parse(missingRes.body).error.code, 'model_not_found');

console.log('[models.test] ok');
