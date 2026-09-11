const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKBUDDY_DEFAULT_TARGET_URL = 'https://copilot.tencent.com/v2';

const WORKBUDDY_FALLBACK_MODELS = [
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    displayName: 'DeepSeek V4 Pro',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 1000000,
    maxOutputTokens: 50000,
    vendor: 'f',
    description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口',
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    displayName: 'DeepSeek V4 Flash',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 1000000,
    maxOutputTokens: 50000,
    vendor: 'f',
    description: 'DeepSeek 高性价比模型，支持 1M 上下文',
  },
  {
    id: 'deepseek-v3-2-volc',
    name: 'DeepSeek-V3.2',
    displayName: 'DeepSeek V3.2',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 96000,
    maxOutputTokens: 32000,
    vendor: 'f',
    description: 'DeepSeek-V3.2 模型，适合日常使用',
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax-M3',
    displayName: 'MiniMax M3',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 512000,
    maxOutputTokens: 48000,
    vendor: 'f',
    description: '原生多模态，擅长代码、智能体任务',
  },
  {
    id: 'minimax-m2.7',
    name: 'MiniMax-M2.7',
    displayName: 'MiniMax M2.7',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 200000,
    maxOutputTokens: 48000,
    vendor: 'f',
    description: '能力均衡，适合日常使用',
  },
  {
    id: 'minimax-m2.5',
    name: 'MiniMax-M2.5',
    displayName: 'MiniMax M2.5',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 200000,
    maxOutputTokens: 48000,
    vendor: 'f',
    description: '能力均衡，适合日常使用',
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    displayName: 'GLM 5.2',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 200000,
    maxOutputTokens: 48000,
    vendor: 'e',
    description: '智谱 GLM-5.2 系列模型',
  },
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    displayName: 'GLM 5.1',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 200000,
    maxOutputTokens: 48000,
    vendor: 'e',
    description: '能力均衡，适合日常使用',
  },
  {
    id: 'glm-5.0',
    name: 'GLM-5.0',
    displayName: 'GLM 5.0',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 200000,
    maxOutputTokens: 48000,
    vendor: 'f',
    description: '能力均衡，适合日常使用',
  },
  {
    id: 'glm-5.0-turbo',
    name: 'GLM-5.0-Turbo',
    displayName: 'GLM 5.0 Turbo',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 200000,
    maxOutputTokens: 48000,
    vendor: 'e',
    description: '面向 Agent 场景进行了深度优化',
  },
  {
    id: 'glm-5v-turbo',
    name: 'GLM-5v-Turbo',
    displayName: 'GLM 5v Turbo',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 200000,
    maxOutputTokens: 38000,
    vendor: 'e',
    description: '原生多模态模型',
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    displayName: 'GLM 4.7',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 200000,
    maxOutputTokens: 48000,
    vendor: 'f',
    description: '能力均衡，适合日常使用',
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi-K2.6',
    displayName: 'Kimi K2.6',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    vendor: 'f',
    description: 'Kimi K2.6 旗舰长文本模型',
  },
  {
    id: 'kimi-k2-thinking',
    name: 'Kimi-K2-Thinking',
    displayName: 'Kimi K2 Thinking',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    vendor: 'f',
    description: 'Kimi 深度思考推理模型',
  },
  {
    id: 'hy3-preview-agent',
    name: 'Hunyuan-3-Preview-Agent',
    displayName: 'Hunyuan 3 Preview Agent',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    vendor: 't',
    description: '腾讯混元 3.0 Agent 预览版',
  },
  {
    id: 'hunyuan-2.0-thinking',
    name: 'Hunyuan-2.0-Thinking',
    displayName: 'Hunyuan 2.0 Thinking',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    vendor: 't',
    description: '腾讯混元 2.0 深度思考模型',
  },
];

function getWorkBuddyAuthInfoPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(
    localAppData,
    'CodeBuddyExtension',
    'Data',
    'Public',
    'auth',
    'workbuddy-desktop.info'
  );
}

function readWorkBuddyAuthInfo(authPath = getWorkBuddyAuthInfoPath()) {
  try {
    if (!fs.existsSync(authPath)) return null;
    const raw = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(raw);
    const auth = parsed && parsed.auth ? parsed.auth : {};
    const account = parsed && parsed.account ? parsed.account : {};
    const accessToken = auth.accessToken || auth.token || null;
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: auth.refreshToken || null,
      tokenType: auth.tokenType || 'Bearer',
      expiresAt: auth.expiresAt || null,
      refreshExpiresAt: auth.refreshExpiresAt || null,
      lastRefreshTime: auth.lastRefreshTime || null,
      domain: auth.domain || 'www.workbuddy.cn',
      uid: account.uid || '',
      uin: account.uin || '',
      nickname: account.nickname || '',
      phoneNumber: account.phoneNumber || '',
      accountType: account.type || 'personal',
      raw: parsed,
    };
  } catch (err) {
    return null;
  }
}

function isWorkBuddyOfficialLoginToken(token) {
  return typeof token === 'string' && token.startsWith('eyJ');
}

function isWorkBuddyOfficialTarget(targetUrl) {
  try {
    const host = new URL(targetUrl || '').hostname.toLowerCase();
    return (
      host.endsWith('copilot.tencent.com') ||
      host.endsWith('workbuddy.cn') ||
      host.endsWith('codebuddy.ai') ||
      host.endsWith('codebuddy.cn') ||
      host === 'copilot.tencent.com' ||
      host === 'workbuddy.cn' ||
      host === 'codebuddy.ai' ||
      host === 'codebuddy.cn'
    );
  } catch (err) {
    return false;
  }
}

function isWorkBuddyOfficialProfile(profileOrId) {
  if (!profileOrId) return false;
  const id = typeof profileOrId === 'string' ? profileOrId : profileOrId.id;
  if (typeof id === 'string') {
    const lower = id.toLowerCase();
    if (lower === 'workbuddy-official' || lower === 'codebuddy-official') return true;
  }
  const protocol =
    typeof profileOrId === 'object' && profileOrId.protocol
      ? String(profileOrId.protocol).toLowerCase()
      : '';
  if (protocol === 'workbuddy') return true;
  if (typeof profileOrId === 'object' && isWorkBuddyOfficialTarget(profileOrId.targetUrl)) {
    return true;
  }
  return false;
}

function getWorkBuddyProductJsonPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(
    localAppData,
    'Programs',
    'WorkBuddy',
    'resources',
    'app.asar.unpacked',
    'cli',
    'product.json'
  );
}

function readWorkBuddyModelsCache(productJsonPath = getWorkBuddyProductJsonPath()) {
  try {
    if (fs.existsSync(productJsonPath)) {
      const raw = fs.readFileSync(productJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed && parsed.models) && parsed.models.length > 0) {
        return {
          source: 'workbuddy-product-json',
          productJsonPath,
          models: parsed.models.map((m) => ({
            id: String(m.id || '').trim(),
            name: m.name || m.id || '',
            displayName: m.name || m.id || '',
            credits: m.credits || '',
            supportsToolCall: m.supportsToolCall !== false,
            supportsImages: m.supportsImages === true,
            supportsReasoning: m.supportsReasoning === true,
            maxInputTokens: Number(m.maxInputTokens || 0),
            maxOutputTokens: Number(m.maxOutputTokens || 0),
            description: m.descriptionZh || m.descriptionEn || '',
            vendor: m.vendor || '',
          })),
        };
      }
    }
  } catch (err) {
    // fallback
  }

  return {
    source: 'workbuddy-fallback-catalog',
    productJsonPath: null,
    models: WORKBUDDY_FALLBACK_MODELS,
  };
}

function normalizeWorkBuddyOfficialModelName(name) {
  const clean = String(name || '')
    .replace(/^(workbuddy|codebuddy)\//i, '')
    .trim();
  const lower = clean.toLowerCase();
  if (lower === 'minimax-m3' || lower === 'minimax-3' || lower === 'minimax-m3-play')
    return 'minimax-m3';
  if (lower === 'deepseek-v4') return 'deepseek-v4-pro';
  return clean;
}

function workBuddyOfficialModelsFromCache(cache, _options = {}) {
  const rawModels = cache && Array.isArray(cache.models) ? cache.models : WORKBUDDY_FALLBACK_MODELS;
  return rawModels
    .map((m) => {
      const rawSlug = String(m.id || m.slug || '').trim();
      const slug = normalizeWorkBuddyOfficialModelName(rawSlug);
      return {
        slug,
        displayName: m.displayName || m.name || m.id || '',
        supportsToolCall: m.supportsToolCall !== false,
        supportsImages: m.supportsImages === true,
        supportsReasoning: m.supportsReasoning === true,
        maxInputTokens: Number(m.maxInputTokens || 0),
        maxOutputTokens: Number(m.maxOutputTokens || 0),
        description: m.description || '',
      };
    })
    .filter((m) => m.slug && m.slug !== 'default');
}

function buildWorkBuddyOfficialModelsResponse(cache = readWorkBuddyModelsCache()) {
  const models = workBuddyOfficialModelsFromCache(cache);
  return {
    ok: true,
    models: models.map((m) => m.slug),
    modelDetails: models,
    authMode: 'official-login',
    source: cache.source || 'workbuddy-product-cache',
    fetchedAt: new Date().toISOString(),
    rawModelCount: models.length,
  };
}

function workBuddyOfficialModelSupport(testModel, cache = readWorkBuddyModelsCache()) {
  const requested = normalizeWorkBuddyOfficialModelName(testModel);
  if (!requested) return { known: false, supported: false, model: requested };
  const models = workBuddyOfficialModelsFromCache(cache);
  const found = models.find((m) => m.slug.toLowerCase() === requested.toLowerCase());
  if (!found) {
    return {
      known: false,
      supported: false,
      model: requested,
    };
  }
  return {
    known: true,
    supported: true,
    model: found.slug,
    displayName: found.displayName,
    supportsToolCall: found.supportsToolCall,
    supportsReasoning: found.supportsReasoning,
  };
}

module.exports = {
  WORKBUDDY_DEFAULT_TARGET_URL,
  WORKBUDDY_FALLBACK_MODELS,
  getWorkBuddyAuthInfoPath,
  readWorkBuddyAuthInfo,
  isWorkBuddyOfficialLoginToken,
  isWorkBuddyOfficialTarget,
  isWorkBuddyOfficialProfile,
  getWorkBuddyProductJsonPath,
  readWorkBuddyModelsCache,
  normalizeWorkBuddyOfficialModelName,
  workBuddyOfficialModelsFromCache,
  buildWorkBuddyOfficialModelsResponse,
  workBuddyOfficialModelSupport,
};
