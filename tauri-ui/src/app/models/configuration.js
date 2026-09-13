const MAX_ID_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;
const MAX_HOST_LENGTH = 253;
const MAX_PATH_LENGTH = 512;
const MAX_SECRET_LENGTH = 4096;
const DEFAULT_LOCAL_PORT = 3443;

export const routeClientProtocolOptions = Object.freeze([
  Object.freeze({ id: 'claude', label: 'Claude' }),
  Object.freeze({ id: 'openai-chat', label: 'OpenAI Chat' }),
  Object.freeze({ id: 'openai-responses', label: 'OpenAI Responses' }),
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
  if (model.startsWith('claude-')) return ['claude'];
  return ['openai-chat', 'openai-responses'];
}

export function routeClientProtocols(route) {
  const candidate = isRecord(route) ? route : {};
  const explicit = normalizeRouteClientProtocols(candidate.clientProtocols);
  return explicit.length ? explicit : inferRouteClientProtocols(candidate.from);
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
