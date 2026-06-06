const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Machine-specific key derivation
const salt = 'hpm-local-salt-987654321';
let secretStr = salt;
try {
  secretStr += os.hostname() + (os.userInfo().username || '');
} catch (e) {}
const encKey = crypto.createHash('sha256').update(secretStr).digest(); // 32 bytes key

function decryptKey(cipherText) {
  if (!cipherText || !cipherText.startsWith('hpm-enc:')) return cipherText;
  try {
    const parts = cipherText.substring(8).split(':');
    if (parts.length !== 3) return cipherText;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    if (iv.length !== 12 || tag.length !== 16) return cipherText;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.warn('[crypto] Failed to decrypt key:', err.message);
    return cipherText;
  }
}

function encryptKey(text) {
  if (!text) return '';
  if (text.startsWith('hpm-enc:')) return text; // Already encrypted
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return 'hpm-enc:' + iv.toString('hex') + ':' + encrypted + ':' + tag;
  } catch (err) {
    console.error('[crypto] Encryption failed:', err.message);
    return text;
  }
}

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
  activeProfile: 'yhrouter',
  profiles: [{
    id: 'yhrouter',
    name: '永辉路由',
    targetUrl: 'http://yhrouter.coding.yonghui.cn:80/v1',
    protocol: 'openai',
    apiKey: '',
    modelRewriteRules: [{ from: 'claude-haiku-4-5-20251001', to: 'gpt-5.5' }],
  }],
  modelRoutes: [{ from: 'claude-haiku-4-5-20251001', profileId: 'yhrouter', to: 'gpt-5.5' }],
  appSettings: {
    conversationAuditEnabled: true,
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
  },
  claudeDesktop: {
    enabled: false,
    mode: 'proxy',
    profileName: 'HTTPS Proxy',
    baseUrl: 'https://localhost:3443',
    token: '',
    models: [
      {
        routeId: 'claude-sonnet-4-6',
        labelOverride: 'GPT-5.5',
        supports1m: true,
        profileId: 'yhrouter',
        upstreamModel: 'gpt-5.5',
      },
    ],
  },
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
    const rawContent = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(rawContent);
    
    // Decrypt API keys in memory
    if (config && Array.isArray(config.profiles)) {
      for (const profile of config.profiles) {
        if (profile && typeof profile.apiKey === 'string' && profile.apiKey.startsWith('hpm-enc:')) {
          profile.apiKey = decryptKey(profile.apiKey);
        }
      }
    }
    if (config && config.claudeDesktop && typeof config.claudeDesktop.directApiKey === 'string' && config.claudeDesktop.directApiKey.startsWith('hpm-enc:')) {
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
  encryptKey,
  decryptKey,
};
