const fs = require('fs');
const path = require('path');
const secretCrypto = require('./secret-crypto');
const { validateConfig } = require('./validator');
const { mergeBuiltinModelRoutes } = require('./builtin-model-routes');
const { createLogger } = require('./logger');
const { ensurePrivateDirectorySync, ensurePrivateFileSync } = require('./secure-files');
const { writeJsonFileAtomically } = require('./management-utils');

const safeLog = createLogger('config');
const { encryptKey, decryptKey, decryptKeysStrict, SECRET_DECRYPTION_ERROR_CODE } = secretCrypto;
const emittedConfigWarnings = new Set();

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LEGACY_DATA_DIR = process.env.PROXY_DATA_DIR || '';
const CONFIG_DIR = path.resolve(process.env.PROXY_CONFIG_DIR || LEGACY_DATA_DIR || PROJECT_ROOT);
const DATA_DIR = path.resolve(
  process.env.PROXY_RUNTIME_DIR || LEGACY_DATA_DIR || path.join(PROJECT_ROOT, '.hpm-runtime')
);
const CONFIG_FILE = path.join(CONFIG_DIR, 'proxy.config.json');

function isPathInside(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isLegacyRuntimeArtifactName(name) {
  return (
    name === '.certs' ||
    name === '.mgmt-token' ||
    name.startsWith('.mgmt-token-') ||
    name === '.proxy.pid' ||
    name === '.proxy.lock' ||
    name === 'eslint-stats.json' ||
    name === 'test.json' ||
    name === 'prev_electron_ui.html' ||
    /\.log(\.|$)/.test(name) ||
    /\.jsonl(\.|$)/.test(name)
  );
}

function migrateLegacyRuntimeFiles(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const legacyDataDir =
    options.legacyDataDir === undefined ? LEGACY_DATA_DIR : options.legacyDataDir;
  const result = {
    enabled: false,
    moved: [],
    skipped: [],
    errors: [],
  };

  if (legacyDataDir || projectRoot === dataDir || !isPathInside(projectRoot, dataDir)) {
    return result;
  }

  result.enabled = true;
  try {
    ensurePrivateDirectorySync(dataDir);
  } catch (err) {
    result.errors.push({ name: path.basename(dataDir), error: err.message });
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch (err) {
    result.errors.push({ name: path.basename(projectRoot), error: err.message });
    return result;
  }

  for (const entry of entries) {
    if (!isLegacyRuntimeArtifactName(entry.name)) continue;
    if (entry.name === path.basename(dataDir)) continue;
    if (!entry.isFile() && !entry.isDirectory()) continue;

    const source = path.join(projectRoot, entry.name);
    const target = path.join(dataDir, entry.name);
    if (fs.existsSync(target)) {
      result.skipped.push({ name: entry.name, reason: 'target-exists' });
      continue;
    }

    try {
      fs.renameSync(source, target);
      result.moved.push(entry.name);
    } catch (err) {
      result.errors.push({ name: entry.name, error: err.message });
    }
  }

  return result;
}
const DEFAULT_CONFIG = {
  localServer: {
    host: 'localhost',
    listenPort: 3443,
    basePath: '/v1',
    protocol: 'claude',
  },
  entryServers: [
    {
      name: 'Claude Messages',
      host: 'localhost',
      listenPort: 3443,
      basePath: '/v1',
      protocol: 'claude',
    },
    {
      name: 'OpenAI Responses',
      host: 'localhost',
      listenPort: 3445,
      basePath: '/v1',
      protocol: 'openai-responses',
    },
    {
      name: 'OpenAI Chat Completions',
      host: 'localhost',
      listenPort: 3447,
      basePath: '/v1',
      protocol: 'openai-chat',
    },
    {
      name: 'Claude Messages HTTP',
      host: 'localhost',
      listenPort: 3080,
      basePath: '/v1',
      protocol: 'claude',
      tls: false,
    },
    {
      name: 'OpenAI Responses HTTP',
      host: 'localhost',
      listenPort: 3082,
      basePath: '/v1',
      protocol: 'openai-responses',
      tls: false,
    },
    {
      name: 'OpenAI Chat Completions HTTP',
      host: 'localhost',
      listenPort: 3084,
      basePath: '/v1',
      protocol: 'openai-chat',
      tls: false,
    },
  ],
  activeProfile: 'default',
  profiles: [
    {
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
    },
  ],
  modelRoutes: [],
  appSettings: {
    conversationAuditEnabled: false,
    conversationAuditCaptureContent: false,
    verifyUpstreamTls: true,
    forceResponseStreaming: false,
    responseStreamingRolloutPercent: 0,
    forceChatStreaming: false,
    upstreamWarmupEnabled: false,
    upstreamWarmupIntervalMs: 45 * 1000,
    upstreamWarmupMaxTargets: 4,
    upstreamWarmupStaggerMs: 200,
    streamDirectRequestBodies: false,
  },
  entryAuth: {
    enabled: true,
    keys: [],
    allowedOrigins: [],
  },
  diagnostics: {
    enabled: false,
    captureGemini: true,
    captureOpenAI: false,
    captureOutboundSse: true,
    captureRequestToolResults: true,
    maxFileBytes: 5 * 1024 * 1024,
    maxTextBytes: 12000,
    externalIngressUrl: '',
    externalIngressTimeoutMs: 5000,
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
    traeProcessStyle: 'text',
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

const MIN_LISTEN_PORT = 1;
const MAX_LISTEN_PORT = 65535;

function parseListenPortValue(value) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
  if (Number.isFinite(parsed)) {
    const integer = Math.trunc(parsed);
    if (integer >= MIN_LISTEN_PORT && integer <= MAX_LISTEN_PORT) return integer;
  }
  return null;
}

function normalizeListenPort(value, defaultValue = DEFAULT_CONFIG.localServer.listenPort) {
  return (
    parseListenPortValue(value) ||
    parseListenPortValue(defaultValue) ||
    DEFAULT_CONFIG.localServer.listenPort
  );
}

function isEncryptedSecret(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('hpm-dpapi:') ||
      value.startsWith('hpm-enc:') ||
      value.startsWith('hpm-aes-v2:'))
  );
}

function encryptSecretValue(value) {
  if (!value || typeof value !== 'string') return value || '';
  return isEncryptedSecret(value) ? value : encryptKey(value);
}

function encryptConfigSecretsForStorage(config) {
  const cloned = JSON.parse(JSON.stringify(config || {}));
  if (cloned && Array.isArray(cloned.profiles)) {
    for (const profile of cloned.profiles) {
      if (profile && typeof profile.apiKey === 'string' && profile.apiKey) {
        profile.apiKey = encryptSecretValue(profile.apiKey);
      }
    }
  }
  if (cloned && cloned.claudeDesktop) {
    for (const key of ['token', 'directApiKey']) {
      if (typeof cloned.claudeDesktop[key] === 'string' && cloned.claudeDesktop[key]) {
        cloned.claudeDesktop[key] = encryptSecretValue(cloned.claudeDesktop[key]);
      }
    }
  }
  if (cloned && cloned.mcpHub && Array.isArray(cloned.mcpHub.servers)) {
    for (const server of cloned.mcpHub.servers) {
      if (server && typeof server.bearerToken === 'string' && server.bearerToken) {
        server.bearerToken = encryptSecretValue(server.bearerToken);
      }
    }
  }
  if (cloned && cloned.entryAuth && Array.isArray(cloned.entryAuth.keys)) {
    for (const entryKey of cloned.entryAuth.keys) {
      if (entryKey && typeof entryKey.key === 'string' && entryKey.key) {
        entryKey.key = encryptSecretValue(entryKey.key);
      }
    }
  }
  return cloned;
}

function migratePlaintextConfigSecrets(config, configFile = CONFIG_FILE) {
  const encryptedConfig = encryptConfigSecretsForStorage(config);
  if (JSON.stringify(encryptedConfig) === JSON.stringify(config)) return false;
  writeJsonFileAtomically(configFile, encryptedConfig);
  return true;
}

function resolveProfileProtocolVersion(profile) {
  if (!profile) return '';
  const explicit = String(profile.protocolVersion || '').trim();
  if (explicit) return explicit;
  const protocol = String(profile.protocol || '').trim();
  return PROTOCOL_VERSION_DEFAULTS[protocol] || '';
}

function decryptConfigSecretsInPlace(config) {
  const secretSlots = [];
  function addSecretSlot(owner, key) {
    if (owner && typeof owner[key] === 'string') secretSlots.push({ owner, key });
  }

  if (config && Array.isArray(config.profiles)) {
    for (const profile of config.profiles) {
      addSecretSlot(profile, 'apiKey');
    }
  }
  if (config && config.claudeDesktop) {
    for (const key of ['token', 'directApiKey']) {
      addSecretSlot(config.claudeDesktop, key);
    }
  }
  if (config && config.mcpHub && Array.isArray(config.mcpHub.servers)) {
    for (const server of config.mcpHub.servers) {
      addSecretSlot(server, 'bearerToken');
    }
  }
  if (config && config.entryAuth && Array.isArray(config.entryAuth.keys)) {
    for (const entryKey of config.entryAuth.keys) {
      addSecretSlot(entryKey, 'key');
    }
  }

  const decryptedValues = decryptKeysStrict(secretSlots.map(({ owner, key }) => owner[key]));
  secretSlots.forEach(({ owner, key }, index) => {
    owner[key] = decryptedValues[index];
  });
  return config;
}

function validateLoadedConfig(config, options = {}) {
  const validation = validateConfig(config, { allowLegacyInsecureHttpUpstream: true });
  if (!validation.valid) {
    throw new Error('Invalid proxy configuration: ' + validation.errors.join(', '));
  }
  if (options.logWarnings !== false) {
    for (const warning of validation.warnings || []) {
      if (emittedConfigWarnings.has(warning)) continue;
      emittedConfigWarnings.add(warning);
      safeLog.warn('[config] Security warning:', warning);
    }
  }
  return config;
}

function ensureDefaultOfficialProfiles(config) {
  if (!config || !Array.isArray(config.profiles)) return config;
  const existingWorkbuddy = config.profiles.find(
    (p) => String((p && p.id) || '').trim() === 'workbuddy-official'
  );
  if (!existingWorkbuddy) {
    config.profiles.push({
      id: 'workbuddy-official',
      name: 'WorkBuddy Official',
      targetUrl: 'https://copilot.tencent.com/v2',
      protocol: 'workbuddy',
      authMode: 'official-login',
      apiKey: null,
    });
  } else if (
    !existingWorkbuddy.targetUrl ||
    existingWorkbuddy.targetUrl === 'https://copilot.tencent.com'
  ) {
    existingWorkbuddy.targetUrl = 'https://copilot.tencent.com/v2';
  }
  return config;
}

function loadConfig(options = {}) {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
    ensurePrivateFileSync(CONFIG_FILE);
    const rawContent = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsedConfig = JSON.parse(rawContent);
    ensureDefaultOfficialProfiles(parsedConfig);
    migratePlaintextConfigSecrets(parsedConfig);
    const config = mergeBuiltinModelRoutes(decryptConfigSecretsInPlace(parsedConfig));
    return validateLoadedConfig(config, options);
  } catch (err) {
    if (options.throwOnError === true || err.code === SECRET_DECRYPTION_ERROR_CODE) throw err;
    safeLog.warn('[config] Failed to read proxy.config.json:', err.message);
    return DEFAULT_CONFIG;
  }
}

function getActiveProfile(config) {
  const profiles = Array.isArray(config.profiles) ? config.profiles : DEFAULT_CONFIG.profiles;
  return (
    profiles.find((profile) => profile.id === config.activeProfile) ||
    profiles[0] ||
    DEFAULT_CONFIG.profiles[0]
  );
}

function getProfiles(config) {
  return Array.isArray(config.profiles) && config.profiles.length > 0
    ? config.profiles
    : DEFAULT_CONFIG.profiles;
}

function getLocalServer(config) {
  const activeProfile = getActiveProfile(config);
  const localServer = config.localServer || {};
  const fallbackPort =
    activeProfile.listenPort != null
      ? activeProfile.listenPort
      : DEFAULT_CONFIG.localServer.listenPort;
  return {
    host: localServer.host || DEFAULT_CONFIG.localServer.host,
    listenPort: normalizeListenPort(localServer.listenPort, fallbackPort),
    basePath: localServer.basePath || DEFAULT_CONFIG.localServer.basePath,
  };
}

function normalizeEntryProtocol(value) {
  const protocol = String(value || '')
    .trim()
    .toLowerCase();
  if (protocol === 'openai-response' || protocol === 'responses' || protocol === 'response')
    return 'openai-responses';
  if (
    protocol === 'openai-chat-completions' ||
    protocol === 'chat' ||
    protocol === 'chat-completions'
  )
    return 'openai-chat';
  if (protocol === 'openai') return 'openai-chat';
  if (protocol === 'claude-desktop' || protocol === 'desktop') return 'claude-desktop';
  if (protocol === 'claude' || protocol === 'openai-responses' || protocol === 'openai-chat')
    return protocol;
  return DEFAULT_CONFIG.localServer.protocol;
}

function shouldAppendDefaultEntry(source, entry) {
  if (!entry || entry.tls !== false) return false;
  const defaultPort = parseListenPortValue(entry.listenPort);
  const defaultName = String(entry.name || '')
    .trim()
    .toLowerCase();
  return !source.some((item) => {
    if (!item) return false;
    const itemName = String(item.name || '')
      .trim()
      .toLowerCase();
    const itemPort = parseListenPortValue(item.listenPort != null ? item.listenPort : item.port);
    return (defaultName && itemName === defaultName) || (defaultPort && itemPort === defaultPort);
  });
}

function hasStandardHttpsEntrySet(source) {
  const protocols = new Set();
  for (const item of source) {
    if (!item || item.enabled === false || item.tls === false) continue;
    const protocol = normalizeEntryProtocol(item.protocol);
    const port = parseListenPortValue(item.listenPort != null ? item.listenPort : item.port);
    if (port === 3443 && protocol === 'claude') protocols.add('claude');
    if (port === 3445 && protocol === 'openai-responses') protocols.add('openai-responses');
    if (port === 3447 && protocol === 'openai-chat') protocols.add('openai-chat');
  }
  return (
    protocols.has('claude') && protocols.has('openai-responses') && protocols.has('openai-chat')
  );
}

function getEntryServers(config) {
  const localServer = getLocalServer(config);
  const localServerConfig = config.localServer || {};
  const localProtocol = normalizeEntryProtocol(
    localServerConfig.protocol || DEFAULT_CONFIG.localServer.protocol
  );
  const defaultEntries = DEFAULT_CONFIG.entryServers.map((entry, index) => ({
    ...entry,
    host: entry.protocol === 'claude-desktop' ? entry.host : localServer.host,
    basePath: entry.protocol === 'claude-desktop' ? entry.basePath : localServer.basePath,
    listenPort: index === 0 ? localServer.listenPort : entry.listenPort,
    protocol: index === 0 ? localProtocol : entry.protocol,
  }));
  const source =
    Array.isArray(config.entryServers) && config.entryServers.length > 0
      ? config.entryServers.slice()
      : defaultEntries.slice();
  if (
    Array.isArray(config.entryServers) &&
    config.entryServers.length > 0 &&
    hasStandardHttpsEntrySet(source)
  ) {
    for (const entry of defaultEntries) {
      if (shouldAppendDefaultEntry(source, entry)) source.push(entry);
    }
  }
  const seen = new Set();
  const entries = [];
  for (const item of source) {
    if (!item || item.enabled === false) continue;
    const rawListenPort = item.listenPort != null ? item.listenPort : item.port;
    const listenPort =
      rawListenPort == null ? localServer.listenPort : parseListenPortValue(rawListenPort);
    if (!listenPort) continue;
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
  return entries.length > 0
    ? entries
    : [
        {
          name: localProtocol,
          host: localServer.host,
          listenPort: localServer.listenPort,
          basePath: localServer.basePath,
          protocol: localProtocol,
          tls: true,
        },
      ];
}

function getModelRewriteRules(profile) {
  const rules = Array.isArray(profile.modelRewriteRules) ? profile.modelRewriteRules : [];
  if (rules.length > 0) return rules.filter((rule) => rule && rule.from && rule.to);
  if (profile.modelRewriteFrom && profile.modelRewriteTo)
    return [{ from: profile.modelRewriteFrom, to: profile.modelRewriteTo }];
  return [];
}

function getModelRoutes(config) {
  if (Array.isArray(config.modelRoutes)) {
    const desktopLabels = new Map();
    const desktopModels =
      config && config.claudeDesktop && Array.isArray(config.claudeDesktop.models)
        ? config.claudeDesktop.models
        : [];
    for (const model of desktopModels) {
      const routeId = String((model && (model.routeId || model.from || model.model)) || '').trim();
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
        if (!next.labelOverride && desktop.labelOverride)
          next.labelOverride = desktop.labelOverride;
        if (next.supports1m === undefined && desktop.supports1m !== undefined)
          next.supports1m = desktop.supports1m !== false;
        return next;
      });
  }
  const activeProfile = getActiveProfile(config);
  return getModelRewriteRules(activeProfile).map((rule) => ({
    from: rule.from,
    profileId: activeProfile.id,
    to: rule.to,
  }));
}

module.exports = {
  PROJECT_ROOT,
  CONFIG_DIR,
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
  encryptConfigSecretsForStorage,
  migratePlaintextConfigSecrets,
  migrateLegacyRuntimeFiles,
  normalizeListenPort,
  parseListenPortValue,
  encryptKey,
  decryptKey,
  decryptConfigSecretsInPlace,
  validateLoadedConfig,
};
