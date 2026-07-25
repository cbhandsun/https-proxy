'use strict';

const BUILTIN_MODEL_ROUTES = [
  { from: 'gpt-5.6', profileId: 'openai-official', to: 'gpt-5.6-sol' },
  { from: 'gpt-5.6-sol', profileId: 'openai-official', to: 'gpt-5.6-sol' },
  { from: 'gpt-5.6-terra', profileId: 'openai-official', to: 'gpt-5.6-terra' },
  { from: 'gpt-5.6-luna', profileId: 'openai-official', to: 'gpt-5.6-luna' },
  { from: 'codex/gpt-5.6-sol', profileId: 'openai-official', to: 'gpt-5.6-sol' },
  { from: 'codex/gpt-5.6-terra', profileId: 'openai-official', to: 'gpt-5.6-terra' },
  { from: 'codex/gpt-5.6-luna', profileId: 'openai-official', to: 'gpt-5.6-luna' },
  { from: 'gemini-3.6-flash', profileId: 'google-official', to: 'gemini-3.6-flash' },
  { from: 'gemini-3.6-flash-medium', profileId: 'google-official', to: 'gemini-3.6-flash' },
  { from: 'gemini-3.6-flash-high', profileId: 'google-official', to: 'gemini-3.6-flash' },
  { from: 'gemini-3.6-flash-low', profileId: 'google-official', to: 'gemini-3.6-flash' },
  { from: 'Gemini 3.6 Flash (Medium)', profileId: 'google-official', to: 'gemini-3.6-flash' },
  { from: 'Gemini 3.6 Flash (High)', profileId: 'google-official', to: 'gemini-3.6-flash' },
  { from: 'Gemini 3.6 Flash (Low)', profileId: 'google-official', to: 'gemini-3.6-flash' },
];

function mergeBuiltinModelRoutes(config) {
  if (!config || typeof config !== 'object') return config;
  const profiles = new Set(
    (Array.isArray(config.profiles) ? config.profiles : [])
      .map((profile) => String((profile && profile.id) || '').trim())
      .filter(Boolean)
  );
  const routes = Array.isArray(config.modelRoutes) ? config.modelRoutes.slice() : [];
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
    routes.push({ ...route });
    existing.add(key);
  }

  return { ...config, modelRoutes: routes };
}

module.exports = {
  BUILTIN_MODEL_ROUTES,
  mergeBuiltinModelRoutes,
};
