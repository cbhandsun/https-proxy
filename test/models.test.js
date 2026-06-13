const assert = require('assert');

const { getModelRoutes } = require('../lib/proxy/config');
const {
  buildLocalClaudeModelObject,
  buildLocalModelsResponse,
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
        object: 'model',
        created: 0,
        owned_by: 'local-proxy',
        root: 'claude-gemini',
        parent: null,
        permission: [],
      },
      {
        id: 'claude-haiku-4-5-20251001',
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
        created_at: '1970-01-01T00:00:00.000Z',
      },
      {
        id: 'claude-haiku-4-5-20251001',
        type: 'model',
        display_name: 'claude-haiku-4-5-20251001',
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

const desktopRoutes = getModelRoutes({
  modelRoutes: [{ from: 'claude-opus-4-7', profileId: 'openai-official', to: 'gpt-5.5' }],
  claudeDesktop: {
    models: [{ routeId: 'claude-opus-4-7', labelOverride: 'GPT-5.5', supports1m: true }],
  },
});

assert.strictEqual(desktopRoutes[0].labelOverride, 'GPT-5.5');
assert.strictEqual(desktopRoutes[0].supports1m, true);
assert.deepStrictEqual(buildLocalModelsResponse(desktopRoutes, 'claude').data[0], {
  id: 'claude-opus-4-7',
  type: 'model',
  display_name: 'GPT-5.5',
  created_at: '1970-01-01T00:00:00.000Z',
  supports1m: true,
});

console.log('[models.test] ok');
