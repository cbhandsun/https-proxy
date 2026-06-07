const fs = require('fs');
const path = require('path');
const secretCrypto = require('./secret-crypto');

const { encryptKey, decryptKey } = secretCrypto;

const DATA_DIR = process.env.PROXY_DATA_DIR || path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(DATA_DIR, 'proxy.config.json');
const DEFAULT_CONFIG = {
  localServer: {
    host: 'localhost',
    listenPort: 3443,
    basePath: '/v1',
    protocol: 'claude',
  },
  entryServers: [
    { name: 'Claude Messages', host: 'localhost', listenPort: 3443, basePath: '/v1', protocol: 'claude' },
    { name: 'OpenAI Responses', host: 'localhost', listenPort: 3445, basePath: '/v1', protocol: 'openai-responses' },
    { name: 'OpenAI Chat Completions', host: 'localhost', listenPort: 3447, basePath: '/v1', protocol: 'openai-chat' },
  ],
  activeProfile: 'default',
  profiles: [{
    id: 'default',
    name: 'Default (OpenAI)',
    targetUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    apiKey: '',
    modelRewriteRules: [],
    // 协议版本:空字符串表示使用协议默认;显式设置时透传
    //   Claude / Claude Desktop -> anthropic-version header
    //   OpenAI / Responses     -> 透传,管理面 UI 可选展示
    protocolVersion: '',
  }],
  modelRoutes: [],
  appSettings: {
    conversationAuditEnabled: true,
    verifyUpstreamTls: true,
  },
  diagnostics: {
    enabled: false,
    captureGemini: true,
    captureOpenAI: false,
    captureOutboundSse: true,
    captureRequestToolResults: true,
    maxFileBytes: 5 * 1024 * 1024,
    maxTextBytes: 12000,
  },
  protocolOptions: {
    thinkingPolicy: 'drop',
    preserveClaudeMessageShape: true,
    stableToolUseIds: true,
    contextWindowPolicy: 'overflow-drop-oldest',
    maxContextTokens: 0, // 0 means disabled
  },
  claudeDesktop: {
    enabled: false,
    mode: 'proxy',
    profileName: 'HTTPS Proxy',
    baseUrl: 'https://localhost:3443',
    token: '',
    models: [],
  },
};

// Profile 协议版本语义:
//   ""           -> 由 profile.protocol 决定默认版本
//   "2023-06-01" -> Anthropic 风格 (Claude / Claude Desktop)
//   "2.0"        -> OpenAI Responses 风格
//   "v1"         -> OpenAI Chat Completions 风格
//   自定义字符串透传
const PROTOCOL_VERSION_DEFAULTS = {
  claude: '2023-06-01',
  'claude-desktop': '2023-06-01',
  'openai-responses': '2.0',
  'openai-chat': 'v1',
  openai: 'v1',
  gemini: 'v1',
};

function resolveProfileProtocolVersion(profile) {
  if (!profile) return '';
  const explicit = String(profile.protocolVersion || '').trim();
  if (explicit) return explicit;
  const protocol = String(profile.protocol || '').trim();
  return PROTOCOL_VERSION_DEFAULTS[protocol] || '';
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
    const rawContent = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(rawContent);
    
    // Decrypt API keys in memory (supports hpm-dpapi: and legacy hpm-enc:)
    if (config && Array.isArray(config.profiles)) {
      for (const profile of config.profiles) {
        if (profile && typeof profile.apiKey === 'string' && (profile.apiKey.startsWith('hpm-dpapi:') || profile.apiKey.startsWith('hpm-enc:'))) {
          profile.apiKey = decryptKey(profile.apiKey);
        }
      }
    }
    if (config && config.claudeDesktop && typeof config.claudeDesktop.directApiKey === 'string' && (config.claudeDesktop.directApiKey.startsWith('hpm-dpapi:') || config.claudeDesktop.directApiKey.startsWith('hpm-enc:'))) {
      config.claudeDesktop.directApiKey = decryptKey(config.claudeDesktop.directApiKey);
    }
    
    return config;
  } catch (err) {
    console.warn('[config] Failed to read proxy.config.json:', err.message);
    return DEFAULT_CONFIG;
  }
}

function getActiveProfile(config) {
  const profiles = Array.isArray(config.profiles) ? config.profiles : DEFAULT_CONFIG.profiles;
  return profiles.find((profile) => profile.id === config.activeProfile) || profiles[0] || DEFAULT_CONFIG.profiles[0];
}

function getProfiles(config) {
  return Array.isArray(config.profiles) && config.profiles.length > 0 ? config.profiles : DEFAULT_CONFIG.profiles;
}

function getLocalServer(config) {
  const activeProfile = getActiveProfile(config);
  const localServer = config.localServer || {};
  return {
    host: localServer.host || DEFAULT_CONFIG.localServer.host,
    listenPort: parseInt(localServer.listenPort || activeProfile.listenPort || DEFAULT_CONFIG.localServer.listenPort, 10),
    basePath: localServer.basePath || DEFAULT_CONFIG.localServer.basePath,
  };
}

function normalizeEntryProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase();
  if (protocol === 'openai-response' || protocol === 'responses' || protocol === 'response') return 'openai-responses';
  if (protocol === 'openai-chat-completions' || protocol === 'chat' || protocol === 'chat-completions') return 'openai-chat';
  if (protocol === 'openai') return 'openai-chat';
  if (protocol === 'claude-desktop' || protocol === 'desktop') return 'claude-desktop';
  if (protocol === 'claude' || protocol === 'openai-responses' || protocol === 'openai-chat') return protocol;
  return DEFAULT_CONFIG.localServer.protocol;
}

function getEntryServers(config) {
  const localServer = getLocalServer(config);
  const localServerConfig = config.localServer || {};
  const localProtocol = normalizeEntryProtocol(localServerConfig.protocol || DEFAULT_CONFIG.localServer.protocol);
  const defaultEntries = DEFAULT_CONFIG.entryServers.map((entry, index) => ({
    ...entry,
    host: entry.protocol === 'claude-desktop' ? entry.host : localServer.host,
    basePath: entry.protocol === 'claude-desktop' ? entry.basePath : localServer.basePath,
    listenPort: index === 0 ? localServer.listenPort : entry.listenPort,
    protocol: index === 0 ? localProtocol : entry.protocol,
  }));
  let source = Array.isArray(config.entryServers) && config.entryServers.length > 0
    ? config.entryServers.slice()
    : defaultEntries.slice();
  const seen = new Set();
  const entries = [];
  for (const item of source) {
    if (!item || item.enabled === false) continue;
    const listenPort = parseInt(item.listenPort || item.port || localServer.listenPort, 10);
    if (!Number.isFinite(listenPort) || listenPort <= 0) continue;
    const host = item.host || localServer.host || DEFAULT_CONFIG.localServer.host;
    const basePath = item.basePath || localServer.basePath || DEFAULT_CONFIG.localServer.basePath;
    const protocol = normalizeEntryProtocol(item.protocol || localProtocol);
    const key = host + ':' + listenPort;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      name: item.name || protocol,
      host,
      listenPort,
      basePath,
      protocol,
      tls: item.tls === false ? false : protocol !== 'claude-desktop',
    });
  }
  return entries.length > 0 ? entries : [{
    name: localProtocol,
    host: localServer.host,
    listenPort: localServer.listenPort,
    basePath: localServer.basePath,
    protocol: localProtocol,
    tls: true,
  }];
}

function getModelRewriteRules(profile) {
  const rules = Array.isArray(profile.modelRewriteRules) ? profile.modelRewriteRules : [];
  if (rules.length > 0) return rules.filter((rule) => rule && rule.from && rule.to);
  if (profile.modelRewriteFrom && profile.modelRewriteTo) return [{ from: profile.modelRewriteFrom, to: profile.modelRewriteTo }];
  return [];
}

function getModelRoutes(config) {
  if (Array.isArray(config.modelRoutes)) {
    const desktopLabels = new Map();
    const desktopModels = config && config.claudeDesktop && Array.isArray(config.claudeDesktop.models) ? config.claudeDesktop.models : [];
    for (const model of desktopModels) {
      const routeId = String(model && (model.routeId || model.from || model.model) || '').trim();
      if (!routeId) continue;
      desktopLabels.set(routeId, {
        labelOverride: String(model.labelOverride || model.displayName || '').trim(),
        supports1m: model.supports1m,
      });
    }
    return config.modelRoutes
      .filter((route) => route && route.from && route.profileId && route.to)
      .map((route) => {
        const desktop = desktopLabels.get(String(route.from).trim());
        if (!desktop) return route;
        const next = { ...route };
        if (!next.labelOverride && desktop.labelOverride) next.labelOverride = desktop.labelOverride;
        if (next.supports1m === undefined && desktop.supports1m !== undefined) next.supports1m = desktop.supports1m !== false;
        return next;
      });
  }
  const activeProfile = getActiveProfile(config);
  return getModelRewriteRules(activeProfile).map((rule) => ({ from: rule.from, profileId: activeProfile.id, to: rule.to }));
}

module.exports = {
  DATA_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  loadConfig,
  getActiveProfile,
  getProfiles,
  getLocalServer,
  getEntryServers,
  normalizeEntryProtocol,
  getModelRoutes,
  getModelRewriteRules,
  resolveProfileProtocolVersion,
  encryptKey,
  decryptKey,
};
