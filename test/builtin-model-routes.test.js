'use strict';

const assert = require('assert');
const {
  BUILTIN_MODEL_ROUTES,
  mergeBuiltinModelRoutes,
} = require('../lib/proxy/builtin-model-routes');

const source = {
  profiles: [{ id: 'openai-official' }, { id: 'google-official' }],
  modelRoutes: [
    { from: 'gpt-5.6-sol', profileId: 'custom-openai', to: 'custom-sol' },
    { from: 'existing', profileId: 'openai-official', to: 'gpt-5.5' },
  ],
};
const merged = mergeBuiltinModelRoutes(source);

assert.notStrictEqual(merged, source, 'merge must return a new config object');
assert.notStrictEqual(merged.modelRoutes, source.modelRoutes, 'merge must not mutate route arrays');
assert.strictEqual(source.modelRoutes.length, 2, 'source routes must remain unchanged');
assert.deepStrictEqual(
  merged.modelRoutes.find((route) => route.from === 'gpt-5.6-sol'),
  source.modelRoutes[0],
  'an explicit user route must override the built-in route'
);
assert.deepStrictEqual(
  merged.modelRoutes.find((route) => route.from === 'gpt-5.6-terra'),
  { from: 'gpt-5.6-terra', profileId: 'openai-official', to: 'gpt-5.6-terra' }
);
assert.deepStrictEqual(
  merged.modelRoutes.find((route) => route.from === 'Gemini 3.6 Flash (High)'),
  {
    from: 'Gemini 3.6 Flash (High)',
    profileId: 'google-official',
    to: 'gemini-3.6-flash',
  }
);
assert.strictEqual(
  mergeBuiltinModelRoutes(merged).modelRoutes.length,
  merged.modelRoutes.length,
  'merge must be idempotent'
);

const missingProfiles = mergeBuiltinModelRoutes({ profiles: [], modelRoutes: [] });
assert.deepStrictEqual(missingProfiles.modelRoutes, []);
assert.strictEqual(mergeBuiltinModelRoutes(null), null);
assert.ok(BUILTIN_MODEL_ROUTES.length >= 14);

console.log('[builtin-model-routes.test] ok');
