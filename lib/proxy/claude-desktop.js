const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonFileAtomically } = require('./management-utils');

const PROFILE_ID = '00000000-0000-4000-8000-000000157210';
const PROFILE_NAME = 'HTTPS Proxy';
const PROXY_PREFIX = '/claude-desktop';
const DEFAULT_PROXY_ROUTES = [
  { routeId: 'claude-sonnet-4-6', labelOverride: 'Sonnet', supports1m: true },
  { routeId: 'claude-opus-4-8', labelOverride: 'Opus', supports1m: true },
  { routeId: 'claude-haiku-4-5', labelOverride: 'Haiku', supports1m: true },
  { routeId: 'claude-fable-5', labelOverride: 'Fable', supports1m: true },
];
const OFFICIAL_CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
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
  const processStyle = cleanString(
    source.traeProcessStyle || source.claudeProcessStyle
  ).toLowerCase();
  return {
    enabled: source.enabled !== false,
    mode: source.mode === 'direct' || source.mode === 'official' ? source.mode : 'proxy',
    profileName: cleanString(source.profileName) || PROFILE_NAME,
    token: cleanString(source.token),
    baseUrl: cleanString(source.baseUrl),
    models: Array.isArray(source.models) ? source.models : [],
    traeProcessStyle:
      processStyle === 'off' || processStyle === 'none' || processStyle === 'false'
        ? ''
        : processStyle === 'auto' || !processStyle
          ? 'auto'
          : processStyle === 'text' || processStyle === 'claude-text'
            ? 'text'
            : processStyle === 'thinking' ||
                processStyle === 'claude-thinking' ||
                processStyle === 'process'
              ? 'thinking'
              : 'auto',
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

function getClaudeDesktopTraeProcessStyle(config, options = {}) {
  const desktop = normalizeClaudeDesktopConfig(config);
  if (desktop.mode === 'official') return '';
  if (desktop.traeProcessStyle === 'auto') {
    return options.claudeDesktop3p ? 'text' : 'thinking';
  }
  return desktop.traeProcessStyle;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const lowerName = String(name || '').toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === lowerName) return cleanString(headers[key]);
  }
  return '';
}

function isClaudeDesktop3pRequest(headers) {
  const userAgent = headerValue(headers, 'user-agent').toLowerCase();
  const billingHeader = headerValue(headers, 'x-anthropic-billing-header').toLowerCase();
  const xApp = headerValue(headers, 'x-app').toLowerCase();
  return (
    userAgent.includes('claude-desktop-3p') ||
    billingHeader.includes('cc_entrypoint=claude-desktop-3p') ||
    (xApp === 'cli' && userAgent.includes('claude-cli') && userAgent.includes('agent-sdk'))
  );
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

function isLocalClaudeDesktopGatewayUrl(value) {
  try {
    const parsed = new URL(cleanString(value));
    const hostname = parsed.hostname.toLowerCase();
    const localHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    return localHost && stripClaudeDesktopPrefix(parsed.pathname) !== parsed.pathname;
  } catch (err) {
    return false;
  }
}

function getClaudeDesktopGatewayConfig() {
  const configPath = getClaudeDesktopConfigPath();
  const contentObj = readJsonFile(configPath);
  const gw =
    contentObj &&
    contentObj.primaryProvider === 'gateway' &&
    contentObj.providers &&
    contentObj.providers.gateway
      ? contentObj.providers.gateway
      : null;
  const baseUrl = cleanString(gw && gw.inferenceGatewayBaseUrl);
  return {
    baseUrl,
    token: cleanString(gw && gw.inferenceGatewayApiKey),
    isLocalProxy: isLocalClaudeDesktopGatewayUrl(baseUrl),
  };
}

function addTokenVariants(tokens, value, decryptToken) {
  const token = cleanString(value);
  if (!token) return;
  tokens.add(token);
  if (
    typeof decryptToken === 'function' &&
    (token.startsWith('hpm-enc:') ||
      token.startsWith('hpm-dpapi:') ||
      token.startsWith('hpm-aes-v2:'))
  ) {
    const decrypted = cleanString(decryptToken(token));
    if (decrypted) tokens.add(decrypted);
  }
}

function isAuthorizedClaudeDesktopRequest(config, headers, decryptToken) {
  const token = normalizeClaudeDesktopConfig(config).token;
  const acceptedTokens = new Set();
  addTokenVariants(acceptedTokens, token, decryptToken);
  const desktopGateway = getClaudeDesktopGatewayConfig();
  if (desktopGateway.isLocalProxy && desktopGateway.token) {
    acceptedTokens.add(desktopGateway.token);
  }
  if (acceptedTokens.size === 0) return true;
  const authorization = cleanString(headers && headers.authorization);
  const xApiKey = cleanString(headers && (headers['x-api-key'] || headers['api-key']));
  for (const candidate of acceptedTokens) {
    if (authorization === 'Bearer ' + candidate || xApiKey === candidate) return true;
  }
  return false;
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
  writeJsonFileAtomically(filePath, value);
}

function writeProxyConfigFile(configFile, config, protectForStorage) {
  const nextConfig = typeof protectForStorage === 'function' ? protectForStorage(config) : config;
  writeJsonFileAtomically(configFile, nextConfig);
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

function backupClaudeDesktopConfig(configPath) {
  if (!fs.existsSync(configPath)) return false;
  try {
    const backupPath = configPath + '.bak';
    fs.copyFileSync(configPath, backupPath);
    return true;
  } catch (err) {
    return false;
  }
}

function restoreClaudeDesktopConfigBackup(configPath = getClaudeDesktopConfigPath()) {
  const backupPath = configPath + '.bak';
  if (!fs.existsSync(backupPath)) return false;
  try {
    fs.copyFileSync(backupPath, configPath);
    return true;
  } catch (err) {
    return false;
  }
}

function formatMcpServersForClaudeDesktop(mcpHub, decryptKey) {
  const servers = Array.isArray(mcpHub && mcpHub.servers) ? mcpHub.servers : [];
  const result = {};
  for (const server of servers) {
    if (!server || server.enabled === false) continue;
    const id = cleanString(server.id || server.name);
    if (!id) continue;
    if (server.command) {
      result[id] = {
        command: cleanString(server.command),
        args: Array.isArray(server.args) ? server.args.map(String) : [],
        ...(server.env && typeof server.env === 'object' ? { env: server.env } : {}),
        _managedBy: 'https-proxy',
      };
    } else if (server.url) {
      const entry = {
        url: cleanString(server.url),
        _managedBy: 'https-proxy',
      };
      let token = cleanString(server.bearerToken);
      if (
        token &&
        typeof decryptKey === 'function' &&
        (token.startsWith('hpm-enc:') ||
          token.startsWith('hpm-dpapi:') ||
          token.startsWith('hpm-aes-v2:'))
      ) {
        token = cleanString(decryptKey(token));
      }
      if (token && token !== '[redacted]' && token !== '***') {
        entry.headers = { Authorization: 'Bearer ' + token };
      }
      result[id] = entry;
    }
  }
  return result;
}

function mergeMcpServersIntoClaudeDesktop(contentObj, mcpServers) {
  const next = contentObj && typeof contentObj === 'object' ? contentObj : {};
  const currentServers =
    next.mcpServers && typeof next.mcpServers === 'object' ? next.mcpServers : {};
  const merged = {};
  for (const [key, val] of Object.entries(currentServers)) {
    if (!val || val._managedBy !== 'https-proxy') {
      merged[key] = val;
    }
  }
  for (const [key, val] of Object.entries(mcpServers || {})) {
    merged[key] = val;
  }
  next.mcpServers = merged;
  return next;
}

function removeManagedMcpServersFromClaudeDesktop(contentObj) {
  const next = contentObj && typeof contentObj === 'object' ? contentObj : {};
  if (next.mcpServers && typeof next.mcpServers === 'object') {
    for (const key of Object.keys(next.mcpServers)) {
      if (next.mcpServers[key] && next.mcpServers[key]._managedBy === 'https-proxy') {
        delete next.mcpServers[key];
      }
    }
    if (Object.keys(next.mcpServers).length === 0) {
      delete next.mcpServers;
    }
  }
  return next;
}

function inspectClaudeDesktopMcpServers(contentObj) {
  const servers =
    contentObj && typeof contentObj.mcpServers === 'object' && contentObj.mcpServers
      ? contentObj.mcpServers
      : {};
  const keys = Object.keys(servers);
  const managedIds = keys.filter((k) => servers[k] && servers[k]._managedBy === 'https-proxy');
  return {
    totalCount: keys.length,
    managedCount: managedIds.length,
    customCount: keys.length - managedIds.length,
    managedIds,
  };
}

function syncClaudeDesktopMcpServers(config, decryptKey) {
  const configPath = getClaudeDesktopConfigPath();
  const contentObj = readJsonFile(configPath);
  backupClaudeDesktopConfig(configPath);
  const mcpServers = formatMcpServersForClaudeDesktop(config && config.mcpHub, decryptKey);
  mergeMcpServersIntoClaudeDesktop(contentObj, mcpServers);
  writeJsonFile(configPath, contentObj);
  return inspectClaudeDesktopMcpServers(contentObj);
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

  const mcpStatus = inspectClaudeDesktopMcpServers(contentObj);
  const backupPath = configPath + '.bak';
  const backupExists = fs.existsSync(backupPath);

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
    backupExists,
    mcpStatus,
  };
}

function getClaudeDesktopStatus() {
  const configPath = getClaudeDesktopConfigPath();
  const exists = fs.existsSync(configPath);
  return claudeDesktopStatusFromConfig(readJsonFile(configPath), exists, configPath);
}

function parsePowerShellJson(text) {
  const raw = cleanString(text);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (err) {
    return [];
  }
}

function readClaudeDesktopProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const command =
      'Get-CimInstance Win32_Process -Filter "name=\'claude.exe\'" | ' +
      'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
    return parsePowerShellJson(
      execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
        encoding: 'utf8',
        timeout: 2500,
        windowsHide: true,
      })
    );
  } catch (err) {
    return [];
  }
}

function extractClaudeCodeProcess(processInfo) {
  const commandLine = cleanString(processInfo && processInfo.CommandLine);
  const normalizedCommandLine = commandLine.replace(/\\/g, '/');
  if (!normalizedCommandLine.toLowerCase().includes('/claude-3p/claude-code/')) {
    return null;
  }
  const modelMatch = commandLine.match(/--model\s+([^\s"]+)/i);
  const resumeMatch = commandLine.match(/--resume\s+([^\s"]+)/i);
  return {
    pid: Number(processInfo.ProcessId) || 0,
    parentPid: Number(processInfo.ParentProcessId) || 0,
    model: modelMatch ? modelMatch[1] : '',
    cliSessionId: resumeMatch ? resumeMatch[1] : '',
  };
}

function listJsonFiles(rootDir, limit = 80) {
  const files = [];
  const stack = [rootDir];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        try {
          files.push({ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
        } catch (err) {}
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findClaudeCodeSession(userDataDir, cliSessionId) {
  const rootDir = path.join(userDataDir, 'claude-code-sessions');
  if (!fs.existsSync(rootDir)) return null;
  const candidates = listJsonFiles(rootDir, 200);
  for (const file of candidates) {
    const parsed = readJsonFile(file.path);
    if (!parsed || !parsed.sessionId) continue;
    if (cliSessionId && parsed.cliSessionId !== cliSessionId) continue;
    return {
      sessionId: parsed.sessionId || '',
      cliSessionId: parsed.cliSessionId || '',
      model: parsed.model || '',
      cwd: parsed.cwd || '',
      completedTurns: Number(parsed.completedTurns) || 0,
      lastActivityAt: parsed.lastActivityAt || 0,
      path: file.path,
    };
  }
  return null;
}

function readRecentCcdLog(userDataDir, sessionId) {
  const logPath = path.join(userDataDir, 'logs', 'main.log');
  if (!fs.existsSync(logPath)) return [];
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => line.includes('[CCD') || (sessionId && line.includes(sessionId)))
      .slice(-8);
  } catch (err) {
    return [];
  }
}

function getClaudeDesktopClientEvidence() {
  const userDataDir =
    process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'Claude-3p')
      : path.join(os.homedir(), '.config', 'Claude-3p');
  const processes = readClaudeDesktopProcesses();
  const codeProcesses = processes.map(extractClaudeCodeProcess).filter(Boolean);
  const mainProcess =
    processes.find((item) => {
      const commandLine = cleanString(item && item.CommandLine);
      return /WindowsApps\\Claude_/i.test(commandLine) && !/\s--type=/i.test(commandLine);
    }) || null;
  const activeCodeProcess = codeProcesses[0] || null;
  const latestCodeSession = findClaudeCodeSession(
    userDataDir,
    activeCodeProcess && activeCodeProcess.cliSessionId
  );
  return {
    userDataDir,
    userDataDirExists: fs.existsSync(userDataDir),
    processCount: processes.length,
    mainWindowPid: mainProcess ? Number(mainProcess.ProcessId) || 0 : 0,
    codeProcessCount: codeProcesses.length,
    activeCodeProcess,
    latestCodeSession,
    recentCcdLog: readRecentCcdLog(userDataDir, latestCodeSession && latestCodeSession.sessionId),
  };
}

function applyClaudeDesktopConfig(config, configFile, decryptKey, protectForStorage) {
  const configPath = getClaudeDesktopConfigPath();
  const desktop = config.claudeDesktop || {};
  const mode = desktop.mode || 'proxy';
  const contentObj = readJsonFile(configPath);
  backupClaudeDesktopConfig(configPath);

  if (mode === 'official') {
    removeClaudeDesktopGatewayProvider(contentObj);
    removeManagedMcpServersFromClaudeDesktop(contentObj);
  } else {
    let baseUrl = '';
    let apiKey = '';
    let models = [];

    if (mode === 'proxy') {
      baseUrl = claudeDesktopBaseUrl(config) + PROXY_PREFIX;
      if (!desktop.token) {
        desktop.token = generateGatewayToken();
        writeProxyConfigFile(configFile, config, protectForStorage);
      }
      apiKey = desktop.token;
      models = getClaudeDesktopInferenceModels(config);
    } else if (mode === 'direct') {
      baseUrl = desktop.directBaseUrl || '';
      let decKey = desktop.directApiKey || '';
      if (
        (decKey.startsWith('hpm-enc:') ||
          decKey.startsWith('hpm-dpapi:') ||
          decKey.startsWith('hpm-aes-v2:')) &&
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

    const mcpServers = formatMcpServersForClaudeDesktop(config && config.mcpHub, decryptKey);
    mergeMcpServersIntoClaudeDesktop(contentObj, mcpServers);
  }

  writeJsonFile(configPath, contentObj);

  if (mode !== 'official') {
    desktop.enabled = true;
  }
  writeProxyConfigFile(configFile, config, protectForStorage);

  return { configured: mode !== 'official' };
}

function restoreClaudeDesktopConfig(config, configFile, protectForStorage) {
  const configPath = getClaudeDesktopConfigPath();

  if (fs.existsSync(configPath)) {
    backupClaudeDesktopConfig(configPath);
    let contentObj = removeClaudeDesktopGatewayProvider(readJsonFile(configPath));
    contentObj = removeManagedMcpServersFromClaudeDesktop(contentObj);
    writeJsonFile(configPath, contentObj);
  }

  const desktop = config.claudeDesktop || {};
  desktop.mode = 'official';
  writeProxyConfigFile(configFile, config, protectForStorage);
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
  getClaudeDesktopTraeProcessStyle,
  isClaudeDesktop3pRequest,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
  isLocalClaudeDesktopGatewayUrl,
  getClaudeDesktopGatewayConfig,
  getClaudeDesktopClientEvidence,
  isAuthorizedClaudeDesktopRequest,
  buildGatewayProfile,
  getClaudeDesktopConfigPath,
  backupClaudeDesktopConfig,
  restoreClaudeDesktopConfigBackup,
  formatMcpServersForClaudeDesktop,
  mergeMcpServersIntoClaudeDesktop,
  removeManagedMcpServersFromClaudeDesktop,
  inspectClaudeDesktopMcpServers,
  syncClaudeDesktopMcpServers,
  removeClaudeDesktopGatewayProvider,
  claudeDesktopStatusFromConfig,
  getClaudeDesktopStatus,
  applyClaudeDesktopConfig,
  restoreClaudeDesktopConfig,
};
