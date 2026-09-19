'use strict';

const GEMINI_FLASH_CAPABILITIES = Object.freeze([
  'function-call',
  'reasoning',
  'image-recognition',
  'audio-recognition',
  'video-recognition',
]);
const GEMINI_FLASH_INPUT_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video']);
const GEMINI_TRANSCRIBE_CAPABILITIES = Object.freeze(['audio-recognition', 'audio-transcription']);
const GEMINI_IMAGE_GENERATION_CAPABILITIES = Object.freeze(['image-input', 'image-generation']);
const OPENAI_IMAGE_GENERATION_CAPABILITIES = Object.freeze(['image-input', 'image-generation']);
const TIANXI_SUPER_CAPABILITIES = Object.freeze(['function-call']);
const TIANXI_TEXT_CAPABILITIES = Object.freeze([]);

function geminiFlashRoute(from, to, options = {}) {
  return {
    from,
    profileId: 'google-official',
    to,
    group: 'gemini',
    ...(options.labelOverride ? { labelOverride: options.labelOverride } : {}),
    capabilities: [...GEMINI_FLASH_CAPABILITIES],
    inputModalities: [...GEMINI_FLASH_INPUT_MODALITIES],
    outputModalities: ['text'],
    supportsStreaming: true,
    ...(options.exposeInModels === false ? { exposeInModels: false } : {}),
  };
}

function geminiTranscribeRoute(from, options = {}) {
  return {
    from,
    profileId: 'google-official',
    to: 'models/proactive-observer-v10',
    group: 'gemini',
    ...(options.labelOverride ? { labelOverride: options.labelOverride } : {}),
    capabilities: [...GEMINI_TRANSCRIBE_CAPABILITIES],
    inputModalities: ['audio'],
    outputModalities: ['text'],
    supportsStreaming: false,
    ...(options.exposeInModels === false ? { exposeInModels: false } : {}),
  };
}

function geminiImageGenerationRoute(from, options = {}) {
  return {
    from,
    profileId: 'google-official',
    to: 'gemini-3.1-flash-image',
    group: 'gemini',
    ...(options.labelOverride ? { labelOverride: options.labelOverride } : {}),
    capabilities: [...GEMINI_IMAGE_GENERATION_CAPABILITIES],
    inputModalities: ['text', 'image'],
    outputModalities: ['text', 'image'],
    supportsStreaming: true,
    ...(options.exposeInModels === false ? { exposeInModels: false } : {}),
  };
}

function openAIImageGenerationRoute(from, options = {}) {
  return {
    from,
    profileId: 'openai-official',
    to: '*',
    group: 'openai',
    ...(options.labelOverride ? { labelOverride: options.labelOverride } : {}),
    capabilities: [...OPENAI_IMAGE_GENERATION_CAPABILITIES],
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    supportsStreaming: false,
    clientProtocols: ['openai-chat'],
    responsesModel: options.responsesModel || 'gpt-6-astra',
    ...(options.exposeInModels === false ? { exposeInModels: false } : {}),
  };
}

const BUILTIN_MODEL_ROUTES = [
  { from: 'gpt-6-astra', profileId: 'openai-official', to: 'gpt-6-astra' },
  { from: 'codex/gpt-6-astra', profileId: 'openai-official', to: 'gpt-6-astra' },
  { from: 'gpt-5.6', profileId: 'openai-official', to: 'gpt-5.6-sol' },
  { from: 'gpt-5.6-sol', profileId: 'openai-official', to: 'gpt-5.6-sol' },
  { from: 'gpt-5.6-terra', profileId: 'openai-official', to: 'gpt-5.6-terra' },
  { from: 'gpt-5.6-luna', profileId: 'openai-official', to: 'gpt-5.6-luna' },
  { from: 'codex/gpt-5.6-sol', profileId: 'openai-official', to: 'gpt-5.6-sol' },
  { from: 'codex/gpt-5.6-terra', profileId: 'openai-official', to: 'gpt-5.6-terra' },
  { from: 'codex/gpt-5.6-luna', profileId: 'openai-official', to: 'gpt-5.6-luna' },
  openAIImageGenerationRoute('gpt-image-2.5-flare', {
    labelOverride: 'GPT Image 2.5 Flare',
  }),
  openAIImageGenerationRoute('gpt-image-2.5-sunburst', {
    labelOverride: 'GPT Image 2.5 Sunburst',
  }),
  {
    from: 'tianxi/super',
    profileId: 'tianxi-official',
    to: 'super',
    group: 'tianxi',
    labelOverride: 'Tianxi Super',
    capabilities: [...TIANXI_SUPER_CAPABILITIES],
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsStreaming: true,
    clientProtocols: ['openai-responses'],
    tianxiAgentId: 'super',
    tianxiLlm: 'dfmodel',
  },
  {
    from: 'tianxi/chat',
    profileId: 'tianxi-official',
    to: 'chat',
    group: 'tianxi',
    labelOverride: 'Tianxi Chat',
    capabilities: [...TIANXI_TEXT_CAPABILITIES],
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsStreaming: true,
    clientProtocols: ['openai-responses'],
    tianxiAgentId: 'chat',
  },
  {
    from: 'workbuddy/deepseek-v4.1-flash',
    profileId: 'workbuddy-official',
    to: 'deepseek-v4.1-flash',
  },
  {
    from: 'workbuddy/deepseek-v4.1',
    profileId: 'workbuddy-official',
    to: 'deepseek-v4.1-flash',
  },
  { from: 'workbuddy/deepseek-v4-pro', profileId: 'workbuddy-official', to: 'deepseek-v4-pro' },
  { from: 'workbuddy/deepseek-v4-flash', profileId: 'workbuddy-official', to: 'deepseek-v4-flash' },
  { from: 'workbuddy/minimax-m3', profileId: 'workbuddy-official', to: 'minimax-m3' },
  { from: 'workbuddy/minimax-m3-play', profileId: 'workbuddy-official', to: 'minimax-m3' },
  { from: 'workbuddy/minimax-m2.7', profileId: 'workbuddy-official', to: 'minimax-m2.7' },
  { from: 'workbuddy/minimax-m2.5', profileId: 'workbuddy-official', to: 'minimax-m2.5' },
  { from: 'workbuddy/glm-5.3', profileId: 'workbuddy-official', to: 'glm-5.3' },
  { from: 'workbuddy/glm-5.3-flash', profileId: 'workbuddy-official', to: 'glm-5.3-flash' },
  { from: 'workbuddy/glm-5.2', profileId: 'workbuddy-official', to: 'glm-5.2' },
  { from: 'workbuddy/glm-5.1', profileId: 'workbuddy-official', to: 'glm-5.1' },
  { from: 'workbuddy/glm-5.0', profileId: 'workbuddy-official', to: 'glm-5.0' },
  { from: 'workbuddy/glm-5.0-turbo', profileId: 'workbuddy-official', to: 'glm-5.0-turbo' },
  { from: 'workbuddy/glm-5v-turbo', profileId: 'workbuddy-official', to: 'glm-5v-turbo' },
  { from: 'workbuddy/glm-4.7', profileId: 'workbuddy-official', to: 'glm-4.7' },
  { from: 'workbuddy/kimi-k2.6', profileId: 'workbuddy-official', to: 'kimi-k2.6' },
  { from: 'workbuddy/kimi-k2-thinking', profileId: 'workbuddy-official', to: 'kimi-k2-thinking' },
  { from: 'workbuddy/hy4-preview', profileId: 'workbuddy-official', to: 'hy4-preview-f' },
  { from: 'workbuddy/hy4-preview-f', profileId: 'workbuddy-official', to: 'hy4-preview-f' },
  { from: 'workbuddy/hy4', profileId: 'workbuddy-official', to: 'hy4-preview-f' },
  { from: 'workbuddy/hy3', profileId: 'workbuddy-official', to: 'hy3' },
  { from: 'workbuddy/hy3-x', profileId: 'workbuddy-official', to: 'hy3-x' },
  { from: 'workbuddy/hy3-preview-agent', profileId: 'workbuddy-official', to: 'hy3-preview-agent' },
  {
    from: 'workbuddy/hunyuan-2.0-thinking',
    profileId: 'workbuddy-official',
    to: 'hunyuan-2.0-thinking',
  },
  geminiFlashRoute('Gemini 3.8 Flash', 'gemini-3.8-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.8 Flash Low', 'gemini-3.8-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.8 Flash Medium', 'gemini-3.8-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.8 Flash High', 'gemini-3.8-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('gemini-3.8-flash', 'gemini-3.8-flash-tiered', {
    labelOverride: 'Gemini 3.8 Flash',
  }),
  geminiFlashRoute('gemini-3.8-flash-tiered', 'gemini-3.8-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('gemini-3.8-flash-medium', 'gemini-3.8-flash-tiered', {
    labelOverride: 'Gemini 3.8 Flash Medium',
  }),
  geminiFlashRoute('gemini-3.8-flash-high', 'gemini-3.8-flash-tiered', {
    labelOverride: 'Gemini 3.8 Flash High',
  }),
  geminiFlashRoute('gemini-3.8-flash-low', 'gemini-3.8-flash-tiered', {
    labelOverride: 'Gemini 3.8 Flash Low',
  }),
  geminiFlashRoute('Gemini 3.8 Flash (Medium)', 'gemini-3.8-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.8 Flash (High)', 'gemini-3.8-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.8 Flash (Low)', 'gemini-3.8-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.7 Flash', 'gemini-3.7-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.7 Flash Low', 'gemini-3.7-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.7 Flash Medium', 'gemini-3.7-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.7 Flash High', 'gemini-3.7-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('gemini-3.7-flash', 'gemini-3.7-flash-tiered', {
    labelOverride: 'Gemini 3.7 Flash',
  }),
  geminiFlashRoute('gemini-3.7-flash-tiered', 'gemini-3.7-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('gemini-3.7-flash-medium', 'gemini-3.7-flash-tiered', {
    labelOverride: 'Gemini 3.7 Flash Medium',
  }),
  geminiFlashRoute('gemini-3.7-flash-high', 'gemini-3.7-flash-tiered', {
    labelOverride: 'Gemini 3.7 Flash High',
  }),
  geminiFlashRoute('gemini-3.7-flash-low', 'gemini-3.7-flash-tiered', {
    labelOverride: 'Gemini 3.7 Flash Low',
  }),
  geminiFlashRoute('Gemini 3.7 Flash (Medium)', 'gemini-3.7-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.7 Flash (High)', 'gemini-3.7-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.7 Flash (Low)', 'gemini-3.7-flash-tiered', {
    exposeInModels: false,
  }),
  geminiFlashRoute('gemini-3.6-flash', 'gemini-3.6-flash-medium'),
  geminiFlashRoute('gemini-3.6-flash-medium', 'gemini-3.6-flash-medium'),
  geminiFlashRoute('gemini-3.6-flash-high', 'gemini-3.6-flash-high'),
  geminiFlashRoute('gemini-3.6-flash-low', 'gemini-3.6-flash-low'),
  geminiFlashRoute('Gemini 3.6 Flash (Medium)', 'gemini-3.6-flash-medium', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.6 Flash (High)', 'gemini-3.6-flash-high', {
    exposeInModels: false,
  }),
  geminiFlashRoute('Gemini 3.6 Flash (Low)', 'gemini-3.6-flash-low', {
    exposeInModels: false,
  }),
  geminiTranscribeRoute('Gemini 3.5 Transcribe', { exposeInModels: false }),
  geminiTranscribeRoute('gemini-3.5-transcribe', {
    labelOverride: 'Gemini 3.5 Transcribe',
  }),
  geminiTranscribeRoute('proactive-observer-v10', { exposeInModels: false }),
  geminiTranscribeRoute('models/proactive-observer-v10', { exposeInModels: false }),
  geminiImageGenerationRoute('gemini-3.1-flash-image', {
    labelOverride: 'Gemini 3.1 Flash Image',
  }),
  geminiImageGenerationRoute('Gemini 3.1 Flash Image', { exposeInModels: false }),
];

const LEGACY_BUILTIN_MODEL_ROUTE_FIXES = new Map([
  ['google-official\0gemini 3.7 flash\0gemini-3.7-flash', 'gemini-3.7-flash-tiered'],
  ['google-official\0gemini-3.7-flash\0gemini-3.7-flash', 'gemini-3.7-flash-tiered'],
]);

function cloneBuiltinModelRoute(route) {
  return {
    ...route,
    ...(Array.isArray(route.capabilities) ? { capabilities: [...route.capabilities] } : {}),
    ...(Array.isArray(route.inputModalities)
      ? { inputModalities: [...route.inputModalities] }
      : {}),
    ...(Array.isArray(route.outputModalities)
      ? { outputModalities: [...route.outputModalities] }
      : {}),
    ...(Array.isArray(route.clientProtocols)
      ? { clientProtocols: [...route.clientProtocols] }
      : {}),
  };
}

function legacyBuiltinModelRouteFixKey(route) {
  return [route.profileId, route.from, route.to]
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .join('\0');
}

function upgradeLegacyBuiltinModelRoute(route, builtinRoutesByFrom) {
  if (!route || typeof route !== 'object') return route;
  const expectedTo = LEGACY_BUILTIN_MODEL_ROUTE_FIXES.get(legacyBuiltinModelRouteFixKey(route));
  if (!expectedTo) return route;

  const from = String(route.from || '')
    .trim()
    .toLowerCase();
  const builtin = builtinRoutesByFrom.get(from);
  if (!builtin || builtin.profileId !== route.profileId || builtin.to !== expectedTo) return route;

  return { ...route, ...cloneBuiltinModelRoute(builtin) };
}

function mergeBuiltinModelRoutes(config) {
  if (!config || typeof config !== 'object') return config;
  const profiles = new Set(
    (Array.isArray(config.profiles) ? config.profiles : [])
      .map((profile) => String((profile && profile.id) || '').trim())
      .filter(Boolean)
  );
  const builtinRoutesByFrom = new Map(
    BUILTIN_MODEL_ROUTES.map((route) => [route.from.toLowerCase(), route])
  );
  const routes = (Array.isArray(config.modelRoutes) ? config.modelRoutes : []).map((route) =>
    upgradeLegacyBuiltinModelRoute(route, builtinRoutesByFrom)
  );
  const existing = new Set(
    routes
      .map((route) =>
        String((route && route.from) || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );

  for (const route of BUILTIN_MODEL_ROUTES) {
    const key = route.from.toLowerCase();
    if (!profiles.has(route.profileId) || existing.has(key)) continue;
    routes.push(cloneBuiltinModelRoute(route));
    existing.add(key);
  }

  return { ...config, modelRoutes: routes };
}

module.exports = {
  GEMINI_FLASH_CAPABILITIES,
  GEMINI_FLASH_INPUT_MODALITIES,
  GEMINI_TRANSCRIBE_CAPABILITIES,
  GEMINI_IMAGE_GENERATION_CAPABILITIES,
  OPENAI_IMAGE_GENERATION_CAPABILITIES,
  TIANXI_SUPER_CAPABILITIES,
  TIANXI_TEXT_CAPABILITIES,
  geminiFlashRoute,
  geminiTranscribeRoute,
  geminiImageGenerationRoute,
  openAIImageGenerationRoute,
  BUILTIN_MODEL_ROUTES,
  mergeBuiltinModelRoutes,
};
