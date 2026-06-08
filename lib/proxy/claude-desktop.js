const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILE_ID = '00000000-0000-4000-8000-000000157210';
const PROFILE_NAME = 'HTTPS Proxy';
const PROXY_PREFIX = '/claude-desktop';
const DEFAULT_PROXY_ROUTES = [
  { routeId: 'claude-sonnet-4-6', labelOverride: 'Sonnet', supports1m: true },
  { routeId: 'claude-opus-4-7', labelOverride: 'Opus', supports1m: true },
  { routeId: 'claude-haiku-4-5', labelOverride: 'Haiku', supports1m: true },
];
const OFFICIAL_CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-opus-4-5',
];

function cleanString(value) {
  return String(value == null ? '' : value).trim();
}

function isClaudeSafeModelId(value) {
  const model = cleanString(value);
  return /^claude-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model);
}

function normalizeClaudeDesktopConfig(config) {
  const source = config && typeof config === 'object' ? config.claudeDesktop || {} : {};
  return {
    enabled: source.enabled !== false,
    mode: source.mode === 'direct' || source.mode === 'official' ? source.mode : 'proxy',
    profileName: cleanString(source.profileName) || PROFILE_NAME,
    token: cleanString(source.token),
    baseUrl: cleanString(source.baseUrl),
    models: Array.isArray(source.models) ? source.models : [],
  };
}

function generateGatewayToken() {
  return 'hpm-' + crypto.randomBytes(16).toString('hex');
}

function claudeDesktopEntry(config) {
  const entries = Array.isArray(config && config.entryServers) ? config.entryServers : [];
  return (
    entries.find(
      (entry) => entry && entry.enabled !== false && entry.protocol === 'claude-desktop'
    ) || null
  );
}

function claudeDesktopBaseUrl(config) {
  const desktop = normalizeClaudeDesktopConfig(config);
  if (desktop.baseUrl) return desktop.baseUrl.replace(/\/+$/, '');
  const entries = Array.isArray(config && config.entryServers) ? config.entryServers : [];
  const entry =
    entries.find((item) => item && item.enabled !== false && item.protocol === 'claude') ||
    claudeDesktopEntry(config);
  const host = entry && entry.host ? entry.host : 'localhost';
  const port = entry && entry.listenPort ? entry.listenPort : 3443;
  const basePath = entry && entry.basePath && entry.basePath !== '/v1' ? entry.basePath : '';
  const normalizedHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host;
  const scheme = entry && entry.tls === false ? 'http' : 'https';
  return scheme + '://' + normalizedHost + ':' + port + String(basePath || '').replace(/\/+$/, '');
}

function defaultProfileId(config) {
  const profiles = Array.isArray(config && config.profiles) ? config.profiles : [];
  if (profiles.some((profile) => profile && profile.id === config.activeProfile))
    return config.activeProfile;
  return profiles[0] && profiles[0].id ? profiles[0].id : '';
}

function repairRouteId(routeId, used) {
  const candidate = cleanString(routeId);
  if (isClaudeSafeModelId(candidate) && !used.has(candidate)) return candidate;

  const fallback = OFFICIAL_CLAUDE_MODELS.find((id) => !used.has(id));
  if (fallback) return fallback;

  let index = 1;
  while (used.has('claude-local-' + index)) index += 1;
  return 'claude-local-' + index;
}

function getClaudeDesktopRoutes(config) {
  const desktop = normalizeClaudeDesktopConfig(config);
  const fallbackProfileId = defaultProfileId(config);
  const modelRoutes = Array.isArray(config && config.modelRoutes) ? config.modelRoutes : [];
  const routeByFrom = new Map();
  for (const route of modelRoutes) {
    const from = cleanString(route && route.from);
    if (from && !routeByFrom.has(from)) routeByFrom.set(from, route);
  }
  const source =
    desktop.models.length > 0
      ? desktop.models.map((item) => {
          const from = cleanString(item && (item.routeId || item.from || item.model));
          const route = routeByFrom.get(from) || {};
          return {
            from,
            profileId: item.profileId || route.profileId,
            to: item.upstreamModel || item.to || route.to,
            labelOverride: item.labelOverride || item.displayName,
            supports1m: item.supports1m,
            enabled: item.enabled,
          };
        })
      : modelRoutes;

  const used = new Set();
  const routes = [];
  for (const item of source) {
    if (!item || item.enabled === false) continue;
    const upstreamModel = cleanString(item.to || item.upstreamModel || item.model);
    if (!upstreamModel) continue;
    const routeId = repairRouteId(item.from || item.routeId, used);
    used.add(routeId);
    routes.push({
      from: routeId,
      profileId: cleanString(item.profileId) || fallbackProfileId,
      to: upstreamModel,
      labelOverride: cleanString(item.labelOverride || item.displayName),
      supports1m: item.supports1m !== false,
    });
  }

  if (routes.length > 0) return routes;
  return DEFAULT_PROXY_ROUTES.slice(0, 1).map((route) => ({
    from: route.routeId,
    profileId: fallbackProfileId,
    to: 'gpt-5.5',
    labelOverride: route.labelOverride,
    supports1m: route.supports1m,
  }));
}

function routeToInferenceModel(route) {
  const item = { name: route.from };
  if (route.labelOverride) item.labelOverride = route.labelOverride;
  if (route.supports1m) item.supports1m = true;
  return item.labelOverride || item.supports1m ? item : route.from;
}

function getClaudeDesktopInferenceModels(config) {
  return getClaudeDesktopRoutes(config).map(routeToInferenceModel);
}

function stripClaudeDesktopPrefix(urlPath) {
  const prefix = PROXY_PREFIX;
  const value = String(urlPath || '/');
  if (value === prefix) return '/';
  if (value.indexOf(prefix + '/') === 0 || value.indexOf(prefix + '?') === 0) {
    const suffix = value.slice(prefix.length) || '/';
    return suffix[0] === '/' || suffix[0] === '?' ? suffix : '/' + suffix;
  }
  return value;
}

function isClaudeDesktopRequest(entry, urlPath) {
  return (
    (entry && entry.protocol === 'claude-desktop') ||
    String(urlPath || '').indexOf(PROXY_PREFIX) === 0
  );
}

function isAuthorizedClaudeDesktopRequest(config, headers) {
  const token = normalizeClaudeDesktopConfig(config).token;
  if (!token) return true;
  const authorization = cleanString(headers && headers.authorization);
  const xApiKey = cleanString(headers && (headers['x-api-key'] || headers['api-key']));
  return authorization === 'Bearer ' + token || xApiKey === token;
}

function buildGatewayProfile(baseUrl, apiKey, models) {
  const profile = {
    disableDeploymentModeChooser: true,
    inferenceGatewayApiKey: apiKey,
    inferenceGatewayAuthScheme: 'bearer',
    inferenceGatewayBaseUrl: baseUrl,
    inferenceProvider: 'gateway',
  };
  if (Array.isArray(models) && models.length > 0) profile.inferenceModels = models;
  return profile;
}

function getClaudeDesktopConfigPath() {
  const homeDir = os.homedir();
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json'
    );
  }
  if (process.platform === 'darwin') {
    return path.join(
      homeDir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }
  return path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeJsonFile(filePath, value) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function removeClaudeDesktopGatewayProvider(contentObj) {
  const next = contentObj && typeof contentObj === 'object' ? contentObj : {};
  delete next.primaryProvider;
  if (next.providers) {
    delete next.providers.gateway;
    if (Object.keys(next.providers).length === 0) {
      delete next.providers;
    }
  }
  return next;
}

function claudeDesktopStatusFromConfig(contentObj, exists, configPath) {
  let mode = 'official';
  let gatewayUrl = '';
  let hasToken = false;
  let configured = false;

  if (exists && contentObj && contentObj.primaryProvider === 'gateway') {
    const gw = contentObj.providers && contentObj.providers.gateway;
    if (gw) {
      configured = true;
      gatewayUrl = gw.inferenceGatewayBaseUrl || '';
      hasToken = !!gw.inferenceGatewayApiKey;
      mode =
        gatewayUrl.includes('localhost') || gatewayUrl.includes('127.0.0.1') ? 'proxy' : 'direct';
    }
  }

  return {
    exists,
    supported: true,
    configured,
    mode,
    gatewayUrl,
    actualBaseUrl: gatewayUrl,
    hasToken,
    configPath,
    profilePath: configPath,
  };
}

function getClaudeDesktopStatus() {
  const configPath = getClaudeDesktopConfigPath();
  const exists = fs.existsSync(configPath);
  return claudeDesktopStatusFromConfig(readJsonFile(configPath), exists, configPath);
}

function applyClaudeDesktopConfig(config, configFile, decryptKey) {
  const configPath = getClaudeDesktopConfigPath();
  const desktop = config.claudeDesktop || {};
  const mode = desktop.mode || 'proxy';
  const contentObj = readJsonFile(configPath);

  if (mode === 'official') {
    removeClaudeDesktopGatewayProvider(contentObj);
  } else {
    let baseUrl = '';
    let apiKey = '';
    let models = [];

    if (mode === 'proxy') {
      baseUrl = claudeDesktopBaseUrl(config) + PROXY_PREFIX;
      if (!desktop.token) {
        desktop.token = generateGatewayToken();
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
      }
      apiKey = desktop.token;
      models = getClaudeDesktopInferenceModels(config);
    } else if (mode === 'direct') {
      baseUrl = desktop.directBaseUrl || '';
      let decKey = desktop.directApiKey || '';
      if (
        (decKey.startsWith('hpm-enc:') || decKey.startsWith('hpm-dpapi:')) &&
        typeof decryptKey === 'function'
      ) {
        decKey = decryptKey(decKey);
      }
      apiKey = decKey;
      models = getClaudeDesktopInferenceModels(config);
    }

    contentObj.primaryProvider = 'gateway';
    if (!contentObj.providers) {
      contentObj.providers = {};
    }
    contentObj.providers.gateway = buildGatewayProfile(baseUrl, apiKey, models);
  }

  writeJsonFile(configPath, contentObj);

  if (mode !== 'official') {
    desktop.enabled = true;
  }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

  return { configured: mode !== 'official' };
}

function restoreClaudeDesktopConfig(config, configFile) {
  const configPath = getClaudeDesktopConfigPath();

  if (fs.existsSync(configPath)) {
    const contentObj = removeClaudeDesktopGatewayProvider(readJsonFile(configPath));
    writeJsonFile(configPath, contentObj);
  }

  const desktop = config.claudeDesktop || {};
  desktop.mode = 'official';
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = {
  PROFILE_ID,
  PROFILE_NAME,
  PROXY_PREFIX,
  DEFAULT_PROXY_ROUTES,
  isClaudeSafeModelId,
  normalizeClaudeDesktopConfig,
  generateGatewayToken,
  claudeDesktopEntry,
  claudeDesktopBaseUrl,
  getClaudeDesktopRoutes,
  getClaudeDesktopInferenceModels,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
  isAuthorizedClaudeDesktopRequest,
  buildGatewayProfile,
  getClaudeDesktopConfigPath,
  removeClaudeDesktopGatewayProvider,
  claudeDesktopStatusFromConfig,
  getClaudeDesktopStatus,
  applyClaudeDesktopConfig,
  restoreClaudeDesktopConfig,
};
