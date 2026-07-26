const fs = require('fs');
const os = require('os');
const path = require('path');

function isOpenAIOfficialCodexTarget(targetUrl) {
  try {
    const url = new URL(targetUrl || '');
    return url.hostname === 'chatgpt.com' && url.pathname.includes('/backend-api/codex');
  } catch (e) {
    return false;
  }
}

function getCodexModelsCachePath() {
  return path.join(os.homedir(), '.codex', 'models_cache.json');
}

function readCodexModelsCache(cachePath = getCodexModelsCachePath()) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function normalizeOpenAIOfficialCodexModelName(name) {
  return String(name || '')
    .replace(/^(openai|codex)\//i, '')
    .trim();
}

function codexOfficialModelsFromCache(cache, options = {}) {
  const includeHidden = options.includeHidden === true;
  const includeUnsupported = options.includeUnsupported === true;
  const rawModels = cache && Array.isArray(cache.models) ? cache.models : [];
  return rawModels
    .map((model) => ({
      slug: String((model && model.slug) || '').trim(),
      displayName: (model && (model.display_name || model.displayName)) || '',
      supportedInApi: model && model.supported_in_api !== false,
      visibility: (model && model.visibility) || '',
      defaultReasoningLevel: (model && model.default_reasoning_level) || '',
      priority: Number((model && model.priority) || 0),
    }))
    .filter((model) => model.slug)
    .filter((model) => includeHidden || model.visibility !== 'hide')
    .filter((model) => includeUnsupported || model.supportedInApi)
    .sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
}

function buildOpenAIOfficialCodexModelsResponse(cache = readCodexModelsCache()) {
  if (!cache) {
    return {
      ok: false,
      authMode: 'official-login',
      source: 'codex-model-cache',
      error: '未找到 Codex 模型缓存，请先运行或登录 Codex CLI 以刷新 ~/.codex/models_cache.json。',
    };
  }

  const visibleSupported = codexOfficialModelsFromCache(cache);
  const allModels = codexOfficialModelsFromCache(cache, {
    includeHidden: true,
    includeUnsupported: true,
  });
  return {
    ok: true,
    models: visibleSupported.map((model) => model.slug),
    authMode: 'official-login',
    source: 'codex-model-cache',
    fetchedAt: cache.fetched_at || cache.fetchedAt || null,
    rawModelCount: allModels.length,
    hiddenModels: allModels
      .filter((model) => model.visibility === 'hide')
      .map((model) => model.slug),
    unsupportedModels: allModels
      .filter((model) => !model.supportedInApi)
      .map((model) => model.slug),
  };
}

function openAIOfficialCodexModelSupport(testModel, cache = readCodexModelsCache()) {
  const requested = normalizeOpenAIOfficialCodexModelName(testModel);
  if (!requested || !cache) return { known: false, supported: false, model: requested };
  const allModels = codexOfficialModelsFromCache(cache, {
    includeHidden: true,
    includeUnsupported: true,
  });
  const found = allModels.find((model) => model.slug === requested);
  if (!found) return { known: false, supported: false, model: requested };
  return {
    known: true,
    supported: found.supportedInApi && found.visibility !== 'hide',
    model: found.slug,
    visibility: found.visibility,
    supportedInApi: found.supportedInApi,
  };
}

module.exports = {
  isOpenAIOfficialCodexTarget,
  getCodexModelsCachePath,
  readCodexModelsCache,
  normalizeOpenAIOfficialCodexModelName,
  codexOfficialModelsFromCache,
  buildOpenAIOfficialCodexModelsResponse,
  openAIOfficialCodexModelSupport,
};
