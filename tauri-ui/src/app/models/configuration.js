const MAX_ID_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;
const MAX_HOST_LENGTH = 253;
const MAX_PATH_LENGTH = 512;
const MAX_SECRET_LENGTH = 4096;
const DEFAULT_LOCAL_PORT = 3443;

export const routeClientProtocolOptions = Object.freeze([
  Object.freeze({ id: 'claude', label: 'Claude (3443/3080)' }),
  Object.freeze({ id: 'openai-chat', label: 'OpenAI Chat (3447/3084)' }),
  Object.freeze({ id: 'openai-responses', label: 'OpenAI Responses (3445/3085)' }),
]);

export const recommendedClaudeClientModels = Object.freeze([
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-5-20250929',
]);

const defaultEntryServers = Object.freeze([
  Object.freeze({
    name: 'Claude Messages',
    host: 'localhost',
    listenPort: 3443,
    basePath: '/v1',
    protocol: 'claude',
  }),
  Object.freeze({
    name: 'OpenAI Responses',
    host: 'localhost',
    listenPort: 3445,
    basePath: '/v1',
    protocol: 'openai-responses',
  }),
  Object.freeze({
    name: 'OpenAI Chat Completions',
    host: 'localhost',
    listenPort: 3447,
    basePath: '/v1',
    protocol: 'openai-chat',
  }),
  Object.freeze({
    name: 'Claude Messages HTTP',
    host: 'localhost',
    listenPort: 3080,
    basePath: '/v1',
    protocol: 'claude',
    tls: false,
  }),
  Object.freeze({
    name: 'OpenAI Responses HTTP',
    host: 'localhost',
    listenPort: 3082,
    basePath: '/v1',
    protocol: 'openai-responses',
    tls: false,
  }),
  Object.freeze({
    name: 'OpenAI Chat Completions HTTP',
    host: 'localhost',
    listenPort: 3084,
    basePath: '/v1',
    protocol: 'openai-chat',
    tls: false,
  }),
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedString(value, fallback, maxLength) {
  const candidate =
    typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return (candidate || fallback).slice(0, maxLength);
}

function normalizedPort(value, fallback) {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535 ? candidate : fallback;
}

function unique(values) {
  return Array.from(new Set(values));
}

export function normalizeRouteClientProtocol(value) {
  const protocol = normalizedString(value, '', MAX_ID_LENGTH).toLowerCase();
  if (protocol === 'openai' || protocol === 'chat' || protocol === 'chat-completions') {
    return 'openai-chat';
  }
  if (protocol === 'responses' || protocol === 'response' || protocol === 'openai-response') {
    return 'openai-responses';
  }
  return routeClientProtocolOptions.some((item) => item.id === protocol) ? protocol : '';
}

export function normalizeRouteClientProtocols(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return unique(values.map(normalizeRouteClientProtocol).filter(Boolean));
}

export function inferRouteClientProtocols(modelId) {
  const model = normalizedString(modelId, '', MAX_ID_LENGTH).toLowerCase();
  if (!model) return [];
  if (
    model.startsWith('claude-') ||
    model.startsWith('claude/') ||
    /^claude(?:\s|_|:)/.test(model) ||
    model.startsWith('anthropic/claude-') ||
    model.startsWith('anthropic/claude/')
  ) {
    return ['claude'];
  }
  return ['openai-chat', 'openai-responses'];
}

export function routeClientProtocols(route) {
  const candidate = isRecord(route) ? route : {};
  const explicit = normalizeRouteClientProtocols(candidate.clientProtocols);
  return explicit.length ? explicit : inferRouteClientProtocols(candidate.from);
}

export function routeClientProtocolText(route) {
  const labels = routeClientProtocols(route)
    .map((id) => routeClientProtocolOptions.find((item) => item.id === id)?.label || id)
    .join(' / ');
  return labels || '未指定';
}

export function routeClientProtocolModeText(route) {
  return normalizeRouteClientProtocols(route && route.clientProtocols).length ? '显式' : '推断';
}

export function routeProtocolHintState(from, clientProtocols) {
  const route = { from: normalizedString(from, '', MAX_ID_LENGTH) };
  const explicit = normalizeRouteClientProtocols(clientProtocols);
  if (explicit.length) route.clientProtocols = explicit;
  const text = routeClientProtocolText(route);
  if (explicit.length) return { mode: 'explicit', text: `显式暴露到：${text}` };
  if (route.from) return { mode: 'inferred', text: `按模型名推断：${text}` };
  return {
    mode: 'empty',
    text: '输入客户端模型后会显示将暴露的入口协议；不勾选时按模型名推断。',
  };
}

export function protocolName(value) {
  if (value === 'tianxi') return 'Tianxi';
  if (value === 'workbuddy') return 'WorkBuddy';
  if (value === 'gemini') return 'Gemini';
  if (value === 'claude') return 'Claude';
  if (value === 'claude-desktop') return 'Claude Desktop';
  if (value === 'openai-responses') return 'OpenAI Responses';
  if (value === 'openai-chat') return 'OpenAI Chat';
  return 'OpenAI';
}

export function entryProtocolName(value) {
  if (value === 'claude') return 'Claude Messages';
  if (value === 'claude-desktop') return 'Claude Desktop';
  if (value === 'openai-responses') return 'OpenAI Responses';
  if (value === 'openai-chat') return 'OpenAI Chat Completions';
  return protocolName(value);
}

export function preferredEntryProtocolForProfile(profile) {
  const protocol = normalizedString(profile && profile.protocol, '', MAX_ID_LENGTH).toLowerCase();
  if (protocol === 'claude' || protocol === 'anthropic') return 'claude';
  if (protocol === 'tianxi') return 'openai-responses';
  if (protocol === 'openai-responses' || protocol === 'responses') return 'openai-responses';
  return 'openai-chat';
}

export function normalizeEntryProtocol(value) {
  const protocol = normalizedString(value, '', MAX_ID_LENGTH).toLowerCase();
  if (protocol === 'responses' || protocol === 'response' || protocol === 'openai-response') {
    return 'openai-responses';
  }
  if (
    protocol === 'chat' ||
    protocol === 'chat-completions' ||
    protocol === 'openai-chat-completions' ||
    protocol === 'openai'
  ) {
    return 'openai-chat';
  }
  if (protocol === 'desktop' || protocol === 'claude-desktop') return 'claude-desktop';
  if (protocol === 'claude' || protocol === 'openai-responses' || protocol === 'openai-chat') {
    return protocol;
  }
  return 'claude';
}

export function normalizeLocalServer(localServer, activeProfile) {
  const source = isRecord(localServer) ? localServer : {};
  const active = isRecord(activeProfile) ? activeProfile : {};
  return {
    ...source,
    host: normalizedString(source.host, 'localhost', MAX_HOST_LENGTH),
    listenPort: normalizedPort(
      source.listenPort,
      normalizedPort(active.listenPort, DEFAULT_LOCAL_PORT)
    ),
    basePath: normalizedString(source.basePath, '/v1', MAX_PATH_LENGTH),
    protocol: normalizeEntryProtocol(source.protocol || 'claude'),
  };
}

export function buildDefaultEntryServers(localServer) {
  const local = normalizeLocalServer(localServer);
  return defaultEntryServers.map((entry, index) => ({
    ...entry,
    host: local.host,
    basePath: local.basePath,
    listenPort: index === 0 ? local.listenPort : entry.listenPort,
  }));
}

function entryServerKey(entry) {
  return `${normalizeEntryProtocol(entry && entry.protocol)}:${entry && entry.tls === false ? 'http' : 'https'}`;
}

function normalizeEntryServer(entry, fallback) {
  const source = isRecord(entry) ? entry : {};
  return {
    name: normalizedString(source.name, fallback.name, MAX_LABEL_LENGTH),
    host: normalizedString(source.host, fallback.host, MAX_HOST_LENGTH),
    listenPort: normalizedPort(source.listenPort ?? source.port, fallback.listenPort),
    basePath: normalizedString(source.basePath, fallback.basePath, MAX_PATH_LENGTH),
    protocol: fallback.protocol,
    tls: source.tls === false ? false : fallback.tls !== false,
    enabled: source.enabled !== false,
  };
}

export function normalizeEntryServers(value, localServer) {
  const defaults = buildDefaultEntryServers(localServer);
  const source = Array.isArray(value) ? value.filter(isRecord) : [];
  const byProtocolAndTls = new Map(source.map((entry) => [entryServerKey(entry), entry]));
  const entries = defaults.map((fallback) =>
    normalizeEntryServer(byProtocolAndTls.get(entryServerKey(fallback)), fallback)
  );
  const defaultKeys = new Set(defaults.map(entryServerKey));

  for (const entry of source) {
    if (defaultKeys.has(entryServerKey(entry))) continue;
    const fallback = {
      name: 'Custom Entry',
      host: 'localhost',
      listenPort: 0,
      basePath: '/v1',
      protocol: normalizeEntryProtocol(entry.protocol),
      tls: entry.tls !== false,
    };
    const normalized = normalizeEntryServer(entry, fallback);
    if (normalized.listenPort >= 1) entries.push(normalized);
  }
  return entries;
}

export function splitEntryAuthList(value) {
  return normalizedString(value, '', MAX_SECRET_LENGTH)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeEntryAuthKey(record, index) {
  const item = isRecord(record) ? record : {};
  const keyIndex = Number.isSafeInteger(index) && index >= 0 ? index + 1 : 1;
  return {
    id: normalizedString(item.id, `entry-key-${keyIndex}`, MAX_ID_LENGTH),
    name: normalizedString(item.name, `Entry key ${keyIndex}`, MAX_LABEL_LENGTH),
    key: normalizedString(item.key, '', MAX_SECRET_LENGTH),
    enabled: item.enabled !== false,
    allowedEntryProtocols: unique(
      (Array.isArray(item.allowedEntryProtocols) ? item.allowedEntryProtocols : []).map(
        normalizeEntryProtocol
      )
    ),
    allowedEntryPorts: unique(
      (Array.isArray(item.allowedEntryPorts) ? item.allowedEntryPorts : [])
        .map((port) => normalizedPort(port, 0))
        .filter(Boolean)
    ),
    allowedProfileIds: unique(
      (Array.isArray(item.allowedProfileIds) ? item.allowedProfileIds : [])
        .map((profileId) => normalizedString(profileId, '', MAX_ID_LENGTH))
        .filter(Boolean)
    ),
  };
}

export function createEntryAuthSecret(randomSource) {
  if (!randomSource || typeof randomSource.getRandomValues !== 'function') {
    throw new Error('secure random source is unavailable');
  }
  const bytes = new Uint8Array(24);
  randomSource.getRandomValues(bytes);
  return `hpm_${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function createDefaultEntryAuthKey(entryServers, createSecret) {
  if (typeof createSecret !== 'function') {
    throw new TypeError('createSecret must be a function');
  }
  const enabledEntries = (Array.isArray(entryServers) ? entryServers : []).filter(
    (entry) => isRecord(entry) && entry.enabled !== false
  );
  return {
    id: 'local-default',
    name: '本地默认入口',
    key: createSecret(),
    enabled: true,
    allowedEntryProtocols: unique(
      enabledEntries.map((entry) => normalizeEntryProtocol(entry.protocol))
    ),
    allowedEntryPorts: unique(
      enabledEntries.map((entry) => normalizedPort(entry.listenPort, 0)).filter(Boolean)
    ),
    allowedProfileIds: [],
  };
}

export function normalizeEntryAuth(value, entryServers, createSecret) {
  const source = isRecord(value) ? value : {};
  const allowedOrigins = unique(
    (Array.isArray(source.allowedOrigins) ? source.allowedOrigins : [])
      .map((origin) => normalizedString(origin, '', 2048))
      .filter((origin) => {
        try {
          const parsed = new URL(origin);
          return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin;
        } catch (error) {
          return false;
        }
      })
      .slice(0, 32)
  );
  const keys = (Array.isArray(source.keys) ? source.keys : [])
    .map(normalizeEntryAuthKey)
    .filter((item) => item.id);
  if (keys.length === 0) {
    return {
      enabled: true,
      keys: [createDefaultEntryAuthKey(entryServers, createSecret)],
      allowedOrigins,
    };
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    keys,
    allowedOrigins,
  };
}

export function normalizeAppSettings(value, options = {}) {
  const source = isRecord(value) ? value : {};
  const settings = { ...source };
  const defaults = {
    closeToTray: true,
    stopProxyOnExit: true,
    autoStartProxy: true,
    launchOnLogin: false,
    showTopMenu: true,
    showTrayMenu: true,
    showWindowOnTrayCommand: true,
    desktopNotifications: options.notificationsSupported === true,
    disableLocalProxy: false,
    verifyUpstreamTls: true,
    conversationAuditEnabled: true,
    conversationAuditCaptureContent: false,
    contextRecoveryEnabled: false,
    contextRecoveryPersistenceEnabled: false,
    forceResponseStreaming: false,
    forceChatStreaming: false,
    upstreamWarmupEnabled: false,
    streamDirectRequestBodies: false,
    performanceMode:
      options.cachedPerformanceMode == null ? true : options.cachedPerformanceMode !== 'false',
  };
  for (const [name, fallback] of Object.entries(defaults)) {
    settings[name] = typeof source[name] === 'boolean' ? source[name] : fallback;
  }
  const warmupInterval = Number(source.upstreamWarmupIntervalMs);
  settings.upstreamWarmupIntervalMs =
    Number.isFinite(warmupInterval) && warmupInterval >= 10_000 && warmupInterval <= 600_000
      ? Math.trunc(warmupInterval)
      : 45_000;
  const warmupMaxTargets = Number(source.upstreamWarmupMaxTargets);
  settings.upstreamWarmupMaxTargets =
    Number.isFinite(warmupMaxTargets) && warmupMaxTargets >= 1 && warmupMaxTargets <= 16
      ? Math.trunc(warmupMaxTargets)
      : 4;
  const warmupStaggerMs = Number(source.upstreamWarmupStaggerMs);
  settings.upstreamWarmupStaggerMs =
    Number.isFinite(warmupStaggerMs) && warmupStaggerMs >= 0 && warmupStaggerMs <= 5000
      ? Math.trunc(warmupStaggerMs)
      : 200;
  const rolloutPercent = Number(source.responseStreamingRolloutPercent);
  settings.responseStreamingRolloutPercent =
    Number.isFinite(rolloutPercent) && rolloutPercent >= 0 && rolloutPercent <= 100
      ? rolloutPercent
      : 0;
  return settings;
}

export const PROVIDER_PRESETS = Object.freeze([
  Object.freeze({
    id: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'openai',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    hint: '全系 DeepSeek-V3/R1、Qwen2.5 等，极速高性价比',
    docsUrl: 'https://cloud.siliconflow.cn/models',
    capabilities: ['thinking', 'vision', 'tools'],
  }),
  Object.freeze({
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    defaultModel: 'deepseek-chat',
    hint: 'DeepSeek 官方 API，支持 deepseek-chat 与 deepseek-reasoner',
    docsUrl: 'https://platform.deepseek.com',
    capabilities: ['thinking', 'tools'],
  }),
  Object.freeze({
    id: 'zhipu',
    name: '智谱清言 (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    defaultModel: 'glm-4-plus',
    hint: '智谱开放平台，支持 GLM-4-Plus、GLM-4-Flash、CogView',
    docsUrl: 'https://open.bigmodel.cn',
    capabilities: ['thinking', 'vision', 'tools'],
  }),
  Object.freeze({
    id: 'moonshot',
    name: '月之暗面 (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    defaultModel: 'moonshot-v1-128k',
    hint: '超长上下文 (128k/256k)，深度阅读与长文本分析',
    docsUrl: 'https://platform.moonshot.cn',
    capabilities: ['tools'],
  }),
  Object.freeze({
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    protocol: 'openai',
    defaultModel: 'abab6.5s-chat',
    hint: 'MiniMax 官方开放平台，高吞吐低时延大模型',
    docsUrl: 'https://api.minimax.chat',
    capabilities: ['tools'],
  }),
  Object.freeze({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    hint: '全球模型一站式聚合，支持 Claude、GPT-4o、Llama3 等',
    docsUrl: 'https://openrouter.ai',
    capabilities: ['thinking', 'vision', 'tools'],
  }),
  Object.freeze({
    id: 'ollama',
    name: 'Ollama (本地运行)',
    baseUrl: 'http://localhost:11434/v1',
    protocol: 'openai',
    defaultModel: 'deepseek-r1:7b',
    hint: '本地私有化部署，隐私安全，无需 API Key',
    docsUrl: 'https://ollama.com',
    capabilities: ['thinking', 'vision'],
  }),
]);

export const PROVIDER_PRESET_MAP = Object.freeze({
  workbuddy: {
    name: 'WorkBuddy Official',
    defaultId: 'workbuddy-official',
    protocol: 'workbuddy',
    targetUrl: 'https://copilot.tencent.com',
    keyUrl: 'https://www.workbuddy.cn',
    desc: '腾讯 WorkBuddy 官方登录接口。直接复用本地客户端登录态，支持 DeepSeek-V4、MiniMax-M3、GLM-5.1/5.2、Kimi、混元等全系列大模型。',
    recommendedModels: ['deepseek-v4', 'glm-5.1', 'minimax-m3'],
  },
  tianxi: {
    name: 'Tianxi Official',
    defaultId: 'tianxi-official',
    protocol: 'tianxi',
    targetUrl: 'http://127.0.0.1:49305',
    keyUrl: '',
    desc: '联想天禧 AI 本机模式。通过本地登录态自动直连 tac-server，提供 tianxi/chat 普通文本模型和 tianxi/super 超能模式，均通过 OpenAI Responses 调用。',
    recommendedModels: ['tianxi/chat', 'tianxi/super'],
  },
  openai: {
    name: 'OpenAI Official',
    defaultId: 'openai-official',
    protocol: 'openai',
    targetUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    desc: '官方 OpenAI 接口。适用于 GPT-5.4, GPT-5.3-Codex, o3 等官方模型。',
    recommendedModels: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'o3'],
  },
  'glm-coding-anthropic': {
    name: 'GLM Coding Plan (Anthropic)',
    defaultId: 'glm-coding-anthropic',
    protocol: 'claude',
    targetUrl: 'https://open.bigmodel.cn/api/anthropic',
    keyUrl: 'https://bigmodel.cn/coding-plan',
    desc: '智谱 GLM Coding Plan 的 Anthropic Messages 兼容入口，适合 Claude Code、Roo Code 等 Claude 协议客户端通过本地代理使用套餐模型。',
    recommendedModels: ['glm-5.1', 'glm-4.7', 'glm-4.5-air'],
  },
  'glm-coding-openai': {
    name: 'GLM Coding Plan (OpenAI)',
    defaultId: 'glm-coding-openai',
    protocol: 'openai',
    targetUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    keyUrl: 'https://bigmodel.cn/coding-plan',
    desc: '智谱 GLM Coding Plan 的 OpenAI Chat Completions 兼容入口，适合 OpenAI 兼容客户端通过本地代理使用套餐模型。',
    recommendedModels: ['glm-5.1', 'glm-4.7', 'glm-4.5-air'],
  },
  'minimax-anthropic': {
    name: 'MiniMax (Anthropic)',
    defaultId: 'minimax-anthropic',
    protocol: 'claude',
    targetUrl: 'https://api.minimaxi.com/anthropic',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    desc: 'MiniMax 官方 Anthropic Messages 兼容入口，官方快速开始文档推荐用于 Claude Code 等 Anthropic 协议客户端。',
    recommendedModels: ['MiniMax-M2.7', 'MiniMax-M2.5'],
  },
  'minimax-openai': {
    name: 'MiniMax (OpenAI)',
    defaultId: 'minimax-openai',
    protocol: 'openai',
    targetUrl: 'https://api.minimaxi.com/v1',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    desc: 'MiniMax 官方 OpenAI Chat Completions 兼容入口，适合 OpenAI 兼容客户端通过本地代理调用 MiniMax 模型。',
    recommendedModels: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-Text-01'],
  },
  claude: {
    name: 'Claude Official',
    defaultId: 'claude-official',
    protocol: 'claude',
    targetUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    desc: '官方 Anthropic Claude 接口。适用于 Claude Sonnet 4.6 / Opus 4.6 / Haiku 4.5 官方模型。',
    recommendedModels: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
  },
  gemini: {
    name: 'Gemini Official',
    defaultId: 'google-official',
    protocol: 'gemini',
    targetUrl: 'https://generativelanguage.googleapis.com',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    desc: '官方 Google Gemini 开发者接口（通过 Google AI Studio 服务）。',
    recommendedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  'deepseek-anthropic': {
    name: 'DeepSeek (Anthropic)',
    defaultId: 'deepseek-anthropic',
    protocol: 'claude',
    targetUrl: 'https://api.deepseek.com/anthropic',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    desc: 'DeepSeek 兼容的 Anthropic Messages 接口，适合 Claude Code 等 Anthropic 协议客户端调用。',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  deepseek: {
    name: 'DeepSeek Official',
    defaultId: 'deepseek-official',
    protocol: 'openai',
    targetUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    desc: 'DeepSeek 官方的 OpenAI 兼容接口，提供 deepseek-chat 与 deepseek-reasoner 高性价比编程推理能力。',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  'deepseek-openai': {
    name: 'DeepSeek Official (OpenAI)',
    defaultId: 'deepseek-official',
    protocol: 'openai',
    targetUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    desc: 'DeepSeek 官方的 OpenAI 兼容接口，提供 deepseek-chat 与 deepseek-reasoner 高性价比编程推理能力。',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  moonshot: {
    name: 'Kimi / Moonshot (OpenAI)',
    defaultId: 'moonshot',
    protocol: 'openai',
    targetUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    desc: '月之暗面 Kimi OpenAI 兼容接口，支持 kimi-k2-0905-preview、kimi-k2-turbo-preview 等模型。',
    recommendedModels: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'kimi-thinking-preview'],
  },
  'kimi-coding-anthropic': {
    name: 'Kimi For Coding (Anthropic)',
    defaultId: 'kimi-coding-anthropic',
    protocol: 'claude',
    targetUrl: 'https://api.kimi.com/coding',
    keyUrl: 'https://www.kimi.com/coding',
    desc: 'Kimi For Coding 官方 Anthropic Messages 兼容接口，专为 Claude Code 等编程 Agent 打造。',
    recommendedModels: ['kimi-for-coding', 'kimi-k2-0905-preview'],
  },
  'dashscope-openai': {
    name: '阿里百炼 Qwen (OpenAI)',
    defaultId: 'dashscope-openai',
    protocol: 'openai',
    targetUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    desc: '阿里云百炼 OpenAI 兼容接口，支持 qwen3-coder-plus、qwen-max-latest、qwq-plus 等模型。',
    recommendedModels: ['qwen3-coder-plus', 'qwen-max-latest', 'qwq-plus'],
  },
  'dashscope-anthropic': {
    name: '阿里百炼 Qwen (Anthropic)',
    defaultId: 'dashscope-anthropic',
    protocol: 'claude',
    targetUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    desc: '阿里云百炼 Anthropic Messages 兼容接口，适合 Claude Code 直接接入 Qwen3-Coder。',
    recommendedModels: ['qwen3-coder-plus', 'qwen-max-latest'],
  },
  siliconflow: {
    name: 'SiliconFlow',
    defaultId: 'siliconflow',
    protocol: 'openai',
    targetUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://siliconflow.cn/zh-cn/',
    desc: '硅基流动开源大模型平台，提供 DeepSeek-V3/R1、Qwen3-Coder 等海量模型的超速托管服务。',
    recommendedModels: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    ],
  },
  ollama: {
    name: 'Ollama Local',
    defaultId: 'ollama-local',
    protocol: 'openai',
    targetUrl: 'http://localhost:11434/v1',
    keyUrl: '',
    desc: '本地部署运行的 Ollama 服务，通常用于离线运行开源大模型。注：本地运行，不需要填写 API Key。',
    recommendedModels: ['qwen2.5-coder:32b', 'deepseek-r1:32b', 'glm4:9b'],
  },
  openrouter: {
    name: 'OpenRouter',
    defaultId: 'openrouter',
    protocol: 'openai',
    targetUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    desc: '聚合了大量主流模型与开源模型的第三方转发网关，支持单 API Key 调用数百种模型。',
    recommendedModels: [
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.4',
      'deepseek/deepseek-r1',
      'google/gemini-2.5-pro',
    ],
  },
});

export function matchPresetByUrl(targetUrl) {
  if (!targetUrl) return '';
  const url = targetUrl.toLowerCase().trim();
  if (
    url.includes('copilot.tencent.com') ||
    url.includes('workbuddy.cn') ||
    url.includes('codebuddy')
  )
    return 'workbuddy';
  if (url.includes('127.0.0.1:49305') || url.includes('tianxi')) return 'tianxi';
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('open.bigmodel.cn/api/anthropic')) return 'glm-coding-anthropic';
  if (url.includes('open.bigmodel.cn/api/coding/paas')) return 'glm-coding-openai';
  if (url.includes('api.minimaxi.com/anthropic')) return 'minimax-anthropic';
  if (url.includes('api.minimaxi.com/v1')) return 'minimax-openai';
  if (url.includes('api.kimi.com/coding')) return 'kimi-coding-anthropic';
  if (url.includes('api.moonshot.cn')) return 'moonshot';
  if (url.includes('dashscope.aliyuncs.com/apps/anthropic')) return 'dashscope-anthropic';
  if (url.includes('dashscope.aliyuncs.com')) return 'dashscope-openai';
  if (url.includes('api.anthropic.com')) return 'claude';
  if (url.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (url.includes('api.deepseek.com/anthropic')) return 'deepseek-anthropic';
  if (url.includes('api.deepseek.com')) return 'deepseek-openai';
  if (url.includes('api.siliconflow.cn')) return 'siliconflow';
  if (url.includes('11434')) return 'ollama';
  if (url.includes('openrouter.ai')) return 'openrouter';
  return '';
}
