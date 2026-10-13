'use strict';

const assert = require('assert');
const {
  BUILTIN_MODEL_ROUTES,
  mergeBuiltinModelRoutes,
} = require('../lib/proxy/builtin-model-routes');
const { buildLocalModelsResponse } = require('../lib/proxy/models');

const source = {
  profiles: [{ id: 'openai-official' }, { id: 'google-official' }, { id: 'tianxi-official' }],
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
  merged.modelRoutes.find((route) => route.from === 'gpt-6.1-sol'),
  { from: 'gpt-6.1-sol', profileId: 'openai-official', to: 'gpt-6.1-sol' }
);
assert.deepStrictEqual(
  merged.modelRoutes.find((route) => route.from === 'codex/gpt-6.1-sol'),
  { from: 'codex/gpt-6.1-sol', profileId: 'openai-official', to: 'gpt-6.1-sol' }
);
assert.deepStrictEqual(
  merged.modelRoutes.find((route) => route.from === 'gpt-6-astra'),
  { from: 'gpt-6-astra', profileId: 'openai-official', to: 'gpt-6-astra' }
);
assert.deepStrictEqual(
  merged.modelRoutes.find((route) => route.from === 'codex/gpt-6-astra'),
  { from: 'codex/gpt-6-astra', profileId: 'openai-official', to: 'gpt-6-astra' }
);
for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
  assert.deepStrictEqual(
    merged.modelRoutes.find((route) => route.from === model),
    { from: model, profileId: 'openai-official', to: model }
  );
  assert.deepStrictEqual(
    merged.modelRoutes.find((route) => route.from === `codex/${model}`),
    { from: `codex/${model}`, profileId: 'openai-official', to: model }
  );
}
assert.deepStrictEqual(
  buildLocalModelsResponse(merged.modelRoutes, 'openai', 'openai-responses')
    .data.map((model) => model.id)
    .filter((id) => /^(?:codex\/)?gpt-6(?:\.1-sol|-(?:astra|sol|luna))$/.test(id)),
  [
    'codex/gpt-6-astra',
    'codex/gpt-6-luna',
    'codex/gpt-6-sol',
    'codex/gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6-luna',
    'gpt-6-sol',
    'gpt-6.1-sol',
  ]
);
for (const [id, name] of [
  ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare'],
  ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'],
]) {
  const route = merged.modelRoutes.find((item) => item.from === id);
  assert.strictEqual(route.profileId, 'openai-official');
  assert.strictEqual(route.to, '*');
  assert.strictEqual(route.group, 'openai');
  assert.strictEqual(route.labelOverride, name);
  assert.deepStrictEqual(route.capabilities, ['image-input', 'image-generation']);
  assert.deepStrictEqual(route.inputModalities, ['text', 'image']);
  assert.deepStrictEqual(route.outputModalities, ['image']);
  assert.deepStrictEqual(route.clientProtocols, ['openai-chat']);
  assert.strictEqual(route.responsesModel, 'gpt-6-astra');
  assert.strictEqual(route.supportsStreaming, false);

  const publicChatModel = buildLocalModelsResponse(
    merged.modelRoutes,
    'openai',
    'openai-chat'
  ).data.find((model) => model.id === id);
  assert.strictEqual(publicChatModel.name, name);
  assert.strictEqual(publicChatModel.group, 'openai');
  assert.strictEqual(publicChatModel.supports_vision, true);
  assert.strictEqual(publicChatModel.supports_image_generation, true);
  assert.strictEqual(publicChatModel.supports_streaming, false);
  assert.deepStrictEqual(publicChatModel.input_modalities, ['text', 'image']);
  assert.deepStrictEqual(publicChatModel.output_modalities, ['image']);
  assert.strictEqual(
    buildLocalModelsResponse(merged.modelRoutes, 'openai', 'openai-responses').data.some(
      (model) => model.id === id
    ),
    false
  );
}
const tianxiSuperRoute = merged.modelRoutes.find((route) => route.from === 'tianxi/super');
assert.strictEqual(tianxiSuperRoute.profileId, 'tianxi-official');
assert.strictEqual(tianxiSuperRoute.to, 'super');
assert.strictEqual(tianxiSuperRoute.group, 'tianxi');
assert.strictEqual(tianxiSuperRoute.labelOverride, 'Tianxi Super');
assert.deepStrictEqual(tianxiSuperRoute.clientProtocols, ['openai-responses']);
assert.strictEqual(tianxiSuperRoute.supportsStreaming, true);
assert.strictEqual(tianxiSuperRoute.tianxiAgentId, 'super');
const publicTianxiSuper = buildLocalModelsResponse(
  merged.modelRoutes,
  'openai',
  'openai-responses'
).data.find((model) => model.id === 'tianxi/super');
assert.strictEqual(publicTianxiSuper.name, 'Tianxi Super');
assert.strictEqual(publicTianxiSuper.group, 'tianxi');
assert.strictEqual(publicTianxiSuper.supports_streaming, true);
assert.deepStrictEqual(tianxiSuperRoute.capabilities, []);
const staleTianxi = mergeBuiltinModelRoutes({
  profiles: [{ id: 'tianxi-official' }],
  modelRoutes: [
    {
      from: 'tianxi/super',
      profileId: 'tianxi-official',
      to: 'super',
      capabilities: ['function-call'],
      labelOverride: 'Custom Tianxi',
    },
  ],
}).modelRoutes[0];
assert.deepStrictEqual(staleTianxi.capabilities, []);
assert.strictEqual(staleTianxi.labelOverride, 'Custom Tianxi');
assert.deepStrictEqual(publicTianxiSuper.input_modalities, ['text']);
assert.deepStrictEqual(publicTianxiSuper.output_modalities, ['text']);
assert.strictEqual(
  buildLocalModelsResponse(merged.modelRoutes, 'openai', 'openai-chat').data.some(
    (model) => model.id === 'tianxi/super'
  ),
  false
);
const tianxiChatRoute = merged.modelRoutes.find((route) => route.from === 'tianxi/chat');
assert.strictEqual(tianxiChatRoute.profileId, 'tianxi-official');
assert.strictEqual(tianxiChatRoute.to, 'chat');
assert.strictEqual(tianxiChatRoute.group, 'tianxi');
assert.strictEqual(tianxiChatRoute.labelOverride, 'Tianxi Chat');
assert.deepStrictEqual(tianxiChatRoute.clientProtocols, ['openai-responses']);
assert.strictEqual(tianxiChatRoute.tianxiAgentId, 'chat');
assert.strictEqual(tianxiChatRoute.tianxiLlm, 'dfmodel');
const customChatRoute = {
  from: 'tianxi/chat',
  profileId: 'tianxi-official',
  to: 'chat',
  tianxiAgentId: 'chat',
  tianxiLlm: 'custom-model',
};
assert.deepStrictEqual(
  mergeBuiltinModelRoutes({
    profiles: [{ id: 'tianxi-official' }],
    modelRoutes: [customChatRoute],
  }).modelRoutes[0],
  customChatRoute
);
const publicTianxiChat = buildLocalModelsResponse(
  merged.modelRoutes,
  'openai',
  'openai-responses'
).data.find((model) => model.id === 'tianxi/chat');
assert.strictEqual(publicTianxiChat.name, 'Tianxi Chat');
assert.strictEqual(publicTianxiChat.group, 'tianxi');
assert.strictEqual(publicTianxiChat.supports_streaming, true);
assert.deepStrictEqual(publicTianxiChat.input_modalities, ['text']);
assert.deepStrictEqual(publicTianxiChat.output_modalities, ['text']);
const gemini37High = merged.modelRoutes.find((route) => route.from === 'Gemini 3.7 Flash High');
assert.strictEqual(gemini37High.to, 'gemini-3.7-flash-tiered');
assert.strictEqual(gemini37High.exposeInModels, false);
const gemini37Base = merged.modelRoutes.find((route) => route.from === 'Gemini 3.7 Flash');
assert.strictEqual(gemini37Base.to, 'gemini-3.7-flash-tiered');
assert.strictEqual(gemini37Base.exposeInModels, false);
const gemini37Slug = merged.modelRoutes.find((route) => route.from === 'gemini-3.7-flash');
assert.strictEqual(gemini37Slug.exposeInModels, undefined);
assert.strictEqual(gemini37Slug.labelOverride, 'Gemini 3.7 Flash');

const legacyGemini37Config = {
  profiles: [{ id: 'google-official' }],
  modelRoutes: [
    { from: 'gemini-3.7-flash', profileId: 'google-official', to: 'gemini-3.7-flash' },
    { from: 'Gemini 3.7 Flash', profileId: 'google-official', to: 'gemini-3.7-flash' },
    { from: 'gemini-3.7-flash-custom', profileId: 'google-official', to: 'gemini-3.7-flash' },
    { from: 'gemini-3.7-flash', profileId: 'custom-google', to: 'gemini-3.7-flash' },
  ],
};
const legacyGemini37Merged = mergeBuiltinModelRoutes(legacyGemini37Config);
assert.deepStrictEqual(
  legacyGemini37Config.modelRoutes.slice(0, 2).map((route) => route.to),
  ['gemini-3.7-flash', 'gemini-3.7-flash'],
  'legacy source routes must remain unchanged'
);
const fixedGemini37Slug = legacyGemini37Merged.modelRoutes.find(
  (route) => route.from === 'gemini-3.7-flash' && route.profileId === 'google-official'
);
assert.strictEqual(fixedGemini37Slug.to, 'gemini-3.7-flash-tiered');
assert.strictEqual(fixedGemini37Slug.labelOverride, 'Gemini 3.7 Flash');
assert.deepStrictEqual(fixedGemini37Slug.inputModalities, ['text', 'image', 'audio', 'video']);
const fixedGemini37Display = legacyGemini37Merged.modelRoutes.find(
  (route) => route.from === 'Gemini 3.7 Flash'
);
assert.strictEqual(fixedGemini37Display.to, 'gemini-3.7-flash-tiered');
assert.strictEqual(fixedGemini37Display.exposeInModels, false);
assert.strictEqual(
  legacyGemini37Merged.modelRoutes.find((route) => route.from === 'gemini-3.7-flash-custom').to,
  'gemini-3.7-flash',
  'unknown user routes must not be migrated'
);
assert.strictEqual(
  legacyGemini37Merged.modelRoutes.find((route) => route.profileId === 'custom-google').to,
  'gemini-3.7-flash',
  'custom-profile routes must not be migrated'
);
const gemini37Parenthesized = merged.modelRoutes.find(
  (route) => route.from === 'Gemini 3.7 Flash (High)'
);
assert.strictEqual(gemini37Parenthesized.exposeInModels, false);
const gemini38High = merged.modelRoutes.find((route) => route.from === 'Gemini 3.8 Flash High');
assert.strictEqual(gemini38High.to, 'gemini-3.8-flash-tiered');
assert.strictEqual(gemini38High.exposeInModels, false);
const gemini38Slug = merged.modelRoutes.find((route) => route.from === 'gemini-3.8-flash');
assert.strictEqual(gemini38Slug.to, 'gemini-3.8-flash-tiered');
assert.strictEqual(gemini38Slug.exposeInModels, undefined);
assert.strictEqual(gemini38Slug.labelOverride, 'Gemini 3.8 Flash');
const gemini36High = merged.modelRoutes.find((route) => route.from === 'Gemini 3.6 Flash (High)');
assert.strictEqual(gemini36High.to, 'gemini-3.6-flash-high');
assert.strictEqual(gemini36High.exposeInModels, false);
for (const route of [gemini38High, gemini38Slug, gemini37High, gemini37Base, gemini36High]) {
  assert.strictEqual(route.profileId, 'google-official');
  assert.deepStrictEqual(route.inputModalities, ['text', 'image', 'audio', 'video']);
  assert.deepStrictEqual(route.outputModalities, ['text']);
  assert.strictEqual(route.supportsStreaming, true);
  assert.ok(route.capabilities.includes('image-recognition'));
  assert.ok(route.capabilities.includes('audio-recognition'));
  assert.ok(route.capabilities.includes('video-recognition'));
}
const transcribe = merged.modelRoutes.find((route) => route.from === 'Gemini 3.5 Transcribe');
assert.strictEqual(transcribe.to, 'models/proactive-observer-v10');
assert.deepStrictEqual(transcribe.capabilities, ['audio-recognition', 'audio-transcription']);
assert.deepStrictEqual(transcribe.inputModalities, ['audio']);
assert.deepStrictEqual(transcribe.outputModalities, ['text']);
assert.strictEqual(transcribe.supportsStreaming, false);
assert.strictEqual(transcribe.exposeInModels, false);
for (const alias of ['proactive-observer-v10', 'models/proactive-observer-v10']) {
  assert.strictEqual(
    merged.modelRoutes.find((route) => route.from === alias).exposeInModels,
    false
  );
}
const publicTranscribeRoute = merged.modelRoutes.find(
  (route) => route.from === 'gemini-3.5-transcribe'
);
assert.strictEqual(publicTranscribeRoute.exposeInModels, undefined);
assert.strictEqual(publicTranscribeRoute.labelOverride, 'Gemini 3.5 Transcribe');
const publicTranscribe = buildLocalModelsResponse(merged.modelRoutes, 'openai').data.find(
  (model) => model.id === 'gemini-3.5-transcribe'
);
assert.strictEqual(publicTranscribe.supports_audio, true);
assert.strictEqual(publicTranscribe.supports_transcription, true);
assert.strictEqual(publicTranscribe.supports_streaming, false);
assert.deepStrictEqual(publicTranscribe.input_modalities, ['audio']);
assert.deepStrictEqual(publicTranscribe.output_modalities, ['text']);
assert.strictEqual(publicTranscribe.name, 'Gemini 3.5 Transcribe');
assert.strictEqual(publicTranscribe.group, 'gemini');
const imageGeneration = merged.modelRoutes.find((route) => route.from === 'gemini-3.1-flash-image');
assert.strictEqual(imageGeneration.to, 'gemini-3.1-flash-image');
assert.deepStrictEqual(imageGeneration.capabilities, ['image-input', 'image-generation']);
assert.deepStrictEqual(imageGeneration.inputModalities, ['text', 'image']);
assert.deepStrictEqual(imageGeneration.outputModalities, ['text', 'image']);
assert.strictEqual(imageGeneration.supportsStreaming, true);
assert.strictEqual(imageGeneration.exposeInModels, undefined);
assert.strictEqual(
  merged.modelRoutes.find((route) => route.from === 'Gemini 3.1 Flash Image').exposeInModels,
  false
);
const publicImageGeneration = buildLocalModelsResponse(merged.modelRoutes, 'openai').data.find(
  (model) => model.id === 'gemini-3.1-flash-image'
);
assert.strictEqual(publicImageGeneration.supports_vision, true);
assert.strictEqual(publicImageGeneration.supports_image_generation, true);
assert.deepStrictEqual(publicImageGeneration.input_modalities, ['text', 'image']);
assert.deepStrictEqual(publicImageGeneration.output_modalities, ['text', 'image']);
const publicGemini37Models = buildLocalModelsResponse(merged.modelRoutes, 'openai').data.filter(
  (model) => model.id.startsWith('gemini-3.7-flash') && model.id !== 'gemini-3.7-flash-tiered'
);
assert.deepStrictEqual(
  publicGemini37Models.map((model) => model.id),
  ['gemini-3.7-flash', 'gemini-3.7-flash-high', 'gemini-3.7-flash-low', 'gemini-3.7-flash-medium']
);
for (const model of publicGemini37Models) {
  assert.strictEqual(model.group, 'gemini');
  assert.match(model.name, /^Gemini 3\.7 Flash/);
  assert.strictEqual(model.supports_vision, true);
  assert.strictEqual(model.supports_audio, true);
  assert.strictEqual(model.supports_video, true);
  assert.deepStrictEqual(model.input_modalities, ['text', 'image', 'audio', 'video']);
}
const publicGemini38Models = buildLocalModelsResponse(merged.modelRoutes, 'openai').data.filter(
  (model) => model.id.startsWith('gemini-3.8-flash')
);
assert.deepStrictEqual(
  publicGemini38Models.map((model) => model.id),
  ['gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium']
);
for (const model of publicGemini38Models) {
  assert.strictEqual(model.group, 'gemini');
  assert.match(model.name, /^Gemini 3\.8 Flash/);
  assert.strictEqual(model.supports_vision, true);
  assert.strictEqual(model.supports_audio, true);
  assert.strictEqual(model.supports_video, true);
  assert.deepStrictEqual(model.input_modalities, ['text', 'image', 'audio', 'video']);
}
gemini37High.capabilities.push('mutated');
merged.modelRoutes
  .find((route) => route.from === 'gpt-image-2.5-flare')
  .clientProtocols.push('mutated');
const freshGemini37High = mergeBuiltinModelRoutes(source).modelRoutes.find(
  (route) => route.from === 'Gemini 3.7 Flash High'
);
assert.ok(!freshGemini37High.capabilities.includes('mutated'));
assert.ok(
  !mergeBuiltinModelRoutes(source)
    .modelRoutes.find((route) => route.from === 'gpt-image-2.5-flare')
    .clientProtocols.includes('mutated')
);
assert.strictEqual(
  mergeBuiltinModelRoutes(merged).modelRoutes.length,
  merged.modelRoutes.length,
  'merge must be idempotent'
);

const missingProfiles = mergeBuiltinModelRoutes({ profiles: [], modelRoutes: [] });
assert.deepStrictEqual(missingProfiles.modelRoutes, []);
assert.strictEqual(mergeBuiltinModelRoutes(null), null);
assert.ok(BUILTIN_MODEL_ROUTES.length >= 29);

console.log('[builtin-model-routes.test] ok');
