const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const LOCAL_PROXY_URL = 'https://localhost:3443';
const CODEX_PROXY_URL = 'https://localhost:3445/v1';
const CODEX_MODEL_CATALOG_FILE = 'hpm-model-catalog.json';
const PROXY_MANAGED_TOKEN = 'PROXY_MANAGED';
const CODEX_PROXY_MANAGED_API_KEY = 'sk-proxy-managed';

function getClaudeCodeConfigPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getAntigravityCliConfigPath() {
  return path.join(os.homedir(), '.antigravity', 'settings.json');
}

function getCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function getCodexAuthPath() {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

function getCodexAuthBackupPath(kind) {
  return path.join(os.homedir(), '.codex', `auth.${kind}.backup.json`);
}

function getCodexOfficialLoginScriptPath() {
  return path.join(os.homedir(), '.codex', 'hpm-codex-official-login.ps1');
}

function getCodexOfficialLoginLauncherPath() {
  return path.join(os.homedir(), '.codex', 'hpm-codex-official-login.vbs');
}

function getCodexOfficialLoginLogPath() {
  return path.join(os.homedir(), '.codex', 'hpm-codex-official-login.log');
}

function getCodexModelCachePath() {
  return path.join(os.homedir(), '.codex', 'models_cache.json');
}

function getCodexModelCatalogPath() {
  return path.join(os.homedir(), '.codex', CODEX_MODEL_CATALOG_FILE);
}

function getGeminiSettingsPath() {
  return path.join(os.homedir(), '.gemini', 'settings.json');
}

function getGeminiEnvPath() {
  return path.join(os.homedir(), '.gemini', '.env');
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

function setTomlValue(content, key, value) {
  const regex = new RegExp('^\\s*' + key + '\\s*=\\s*.*$', 'm');
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const newLine = `${key} = "${escaped}"`;
  if (regex.test(content)) {
    return content.replace(regex, newLine);
  }
  const suffix = content.endsWith('\n') ? '' : '\n';
  return content + suffix + newLine + '\n';
}

function deleteTomlValue(content, key) {
  const regex = new RegExp('^\\s*' + key + '\\s*=\\s*.*$\\r?\\n?', 'gm');
  return content.replace(regex, '');
}

function readTomlStringValue(content, key) {
  const regex = new RegExp("^\\s*" + key + "\\s*=\\s*[\"']([^\"']*)[\"']", 'm');
  const match = String(content || '').match(regex);
  return match ? match[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : '';
}

function normalizeCatalogPathForToml(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.normalize(String(a)).toLowerCase() === path.normalize(String(b)).toLowerCase();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readCodexModelCache() {
  const cachePath = getCodexModelCachePath();
  const raw = fs.readFileSync(cachePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error('Codex models_cache.json does not contain a models array');
  }
  return parsed;
}

function displayNameForRoute(route) {
  return String(route && (route.labelOverride || route.displayName || route.from) || '').trim();
}

function buildCodexModelCatalog(modelRoutes) {
  const cache = readCodexModelCache();
  const baseModels = cache.models.filter((model) => model && model.slug);
  const template = baseModels.find((model) => model.base_instructions) || baseModels[0];
  if (!template || !template.base_instructions) {
    throw new Error('Codex model cache does not include a usable model template');
  }

  const routeModels = [];
  const seen = new Set();
  for (const route of Array.isArray(modelRoutes) ? modelRoutes : []) {
    const slug = String(route && route.from || '').trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const existing = baseModels.find((model) => model.slug === slug);
    const model = cloneJson(existing || template);
    model.slug = slug;
    model.display_name = displayNameForRoute(route) || slug;
    model.description = `HTTPS Proxy route to ${route.profileId || 'default'}:${route.to || '*'}`;
    model.visibility = 'list';
    model.supported_in_api = true;
    model.priority = -100 + routeModels.length;
    routeModels.push(model);
  }

  const routedSlugs = new Set(routeModels.map((model) => model.slug));
  return {
    models: routeModels.concat(baseModels.filter((model) => !routedSlugs.has(model.slug))),
  };
}

function writeCodexModelCatalog(modelRoutes) {
  const routes = Array.isArray(modelRoutes) ? modelRoutes.filter((route) => route && route.from) : [];
  if (routes.length === 0) return null;
  const catalogPath = getCodexModelCatalogPath();
  const catalog = buildCodexModelCatalog(routes);
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
  return {
    path: catalogPath,
    modelCount: catalog.models.length,
    routeCount: routes.length,
  };
}

function readCodexCatalogSummary(catalogPath) {
  if (!catalogPath || !fs.existsSync(catalogPath)) return { exists: false, modelCount: 0, routeCount: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8').replace(/^\uFEFF/, ''));
    const models = Array.isArray(parsed && parsed.models) ? parsed.models : [];
    const routeCount = models.filter((model) => String(model && model.description || '').startsWith('HTTPS Proxy route to ')).length;
    return { exists: true, modelCount: models.length, routeCount };
  } catch (err) {
    return { exists: true, modelCount: 0, routeCount: 0, error: err.message };
  }
}

function readCodexAuthStatus() {
  const authPath = getCodexAuthPath();
  const authExists = fs.existsSync(authPath);
  const content = authExists ? readJsonFile(authPath) : {};
  const rawAuthMode = typeof content.auth_mode === 'string' ? content.auth_mode.trim().toLowerCase() : '';
  const apiKey = typeof content.OPENAI_API_KEY === 'string' ? sanitizeCodexApiKey(content.OPENAI_API_KEY) : '';
  const hasManagedApiKey = apiKey === PROXY_MANAGED_TOKEN;
  const hasProxyManagedApiKey = apiKey === CODEX_PROXY_MANAGED_API_KEY;
  const hasUserApiKey = !!apiKey && !hasManagedApiKey;
  const tokens = content && typeof content.tokens === 'object' && content.tokens ? content.tokens : null;
  const hasChatGptTokens = !!(tokens && (tokens.access_token || tokens.refresh_token || tokens.id_token));
  const explicitApiMode = rawAuthMode === 'apikey' || rawAuthMode === 'api';
  const explicitChatGptMode = rawAuthMode === 'chatgpt' || rawAuthMode === 'chat-gpt';

  let authMode = 'none';
  if (explicitApiMode && hasUserApiKey) {
    authMode = 'api';
  } else if (explicitChatGptMode && hasChatGptTokens) {
    authMode = 'chatgpt';
  } else if (hasChatGptTokens && hasUserApiKey) {
    authMode = 'mixed';
  } else if (hasChatGptTokens) {
    authMode = 'chatgpt';
  } else if (hasUserApiKey) {
    authMode = 'api';
  } else if (hasManagedApiKey) {
    authMode = 'legacy-managed-api-key';
  }

  return {
    authPath,
    authExists,
    rawAuthMode,
    authMode,
    hasChatGptTokens,
    hasApiKey: hasUserApiKey || hasManagedApiKey,
    hasUserApiKey,
    hasManagedApiKey,
    hasProxyManagedApiKey,
    authConflict: hasChatGptTokens && hasUserApiKey,
    authGuarded: true,
    chatGptBackupExists: fs.existsSync(getCodexAuthBackupPath('chatgpt')),
    apiBackupExists: fs.existsSync(getCodexAuthBackupPath('api'))
  };
}

function sanitizeCodexApiKey(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim();
}

function hasCodexChatGptTokens(authObj) {
  const tokens = authObj && typeof authObj.tokens === 'object' && authObj.tokens ? authObj.tokens : null;
  return !!(tokens && (tokens.access_token || tokens.refresh_token || tokens.id_token));
}

function hasCodexApiKey(authObj) {
  return !!sanitizeCodexApiKey(authObj && authObj.OPENAI_API_KEY);
}

function backupCodexAuth(kind, authObj = null) {
  const authPath = getCodexAuthPath();
  const current = authObj || (fs.existsSync(authPath) ? readJsonFile(authPath) : {});
  if (!current || Object.keys(current).length === 0) return false;
  if (kind === 'chatgpt' && !hasCodexChatGptTokens(current)) return false;
  if (kind === 'api' && !hasCodexApiKey(current)) return false;
  writeJsonFile(getCodexAuthBackupPath(kind), current);
  return true;
}

function readCodexAuthBackup(kind) {
  const backupPath = getCodexAuthBackupPath(kind);
  if (!fs.existsSync(backupPath)) return null;
  const backup = readJsonFile(backupPath);
  return backup && Object.keys(backup).length > 0 ? backup : null;
}

function writeCodexApiAuth(apiKey = CODEX_PROXY_MANAGED_API_KEY) {
  const cleaned = sanitizeCodexApiKey(apiKey);
  if (!cleaned) throw new Error('Codex API Key 为空，无法切换到 API 登录。');
  writeJsonFile(getCodexAuthPath(), {
    auth_mode: 'apikey',
    OPENAI_API_KEY: cleaned
  });
}

function applyCodexApiLogin(options = {}) {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  if (hasCodexChatGptTokens(current)) backupCodexAuth('chatgpt', current);
  if (hasCodexApiKey(current)) backupCodexAuth('api', current);
  const apiKey = sanitizeCodexApiKey(options.apiKey) || CODEX_PROXY_MANAGED_API_KEY;
  writeCodexApiAuth(apiKey);
  return {
    auth: readCodexAuthStatus(),
    apiKeySource: apiKey === CODEX_PROXY_MANAGED_API_KEY ? 'proxy-managed' : 'user-api-key'
  };
}

function backupCurrentCodexAuth() {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  const chatgptBackedUp = backupCodexAuth('chatgpt', current);
  const apiBackedUp = backupCodexAuth('api', current);
  return {
    chatgptBackedUp,
    apiBackedUp,
    auth: readCodexAuthStatus()
  };
}

function quotePowerShellSingle(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function quoteVbsString(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function writeCodexOfficialLoginScript(options = {}) {
  const codexDir = path.dirname(getCodexAuthPath());
  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

  const scriptPath = getCodexOfficialLoginScriptPath();
  const launcherPath = getCodexOfficialLoginLauncherPath();
  const logPath = getCodexOfficialLoginLogPath();
  const shouldLogout = options.logout !== false;
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    `$logPath = ${quotePowerShellSingle(logPath)}`,
    "try { Start-Transcript -Path $logPath -Append | Out-Null } catch {}",
    "$codexCommand = Get-Command codex.cmd -ErrorAction SilentlyContinue",
    "if (-not $codexCommand) { $codexCommand = Get-Command codex -ErrorAction SilentlyContinue }",
    "if (-not $codexCommand) { Write-Host 'Codex CLI not found in PATH.'; Read-Host 'Press Enter to close'; exit 1 }",
    "Write-Host 'Codex official login is starting...'",
    "Write-Host 'Finish the browser/device login, then return to HTTPS Proxy Manager.'",
    "Write-Host ('Using Codex CLI: ' + $codexCommand.Source)",
  ];
  if (shouldLogout) lines.push("Write-Host 'Running codex logout...'; & $codexCommand.Source logout");
  lines.push("Write-Host 'Running codex login...'; & $codexCommand.Source login");
  lines.push("Write-Host ''");
  lines.push("Write-Host 'Codex login command finished. You can close this window after HTTPS Proxy Manager detects the login.'");
  lines.push("try { Stop-Transcript | Out-Null } catch {}");
  lines.push("Read-Host 'Press Enter to close'");
  fs.writeFileSync(scriptPath, lines.join(os.EOL) + os.EOL, 'utf8');

  const launchCommand = `powershell.exe -NoExit -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const vbsLines = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${quoteVbsString(launchCommand)}, 1, False`,
  ];
  fs.writeFileSync(launcherPath, vbsLines.join(os.EOL) + os.EOL, 'utf8');
  return { scriptPath, launcherPath, logPath };
}

function buildCodexOfficialLoginLaunchArgs(options = {}) {
  const launcherPath = options.launcherPath || getCodexOfficialLoginLauncherPath();
  const startCommand = [
    `Start-Process -FilePath ${quotePowerShellSingle(launcherPath)} -WindowStyle Normal`,
  ].join('; ');
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    startCommand,
  ];
}

function launchCodexOfficialLogin(options = {}) {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  if (hasCodexApiKey(current)) backupCodexAuth('api', current);

  const launchFiles = writeCodexOfficialLoginScript(options);
  if (options.launch === false) {
    return {
      launched: false,
      scriptPath: launchFiles.scriptPath,
      launcherPath: launchFiles.launcherPath,
      logPath: launchFiles.logPath,
      auth: readCodexAuthStatus()
    };
  }

  const child = cp.spawn('wscript.exe', [launchFiles.launcherPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  return {
    launched: true,
    pid: child.pid,
    scriptPath: launchFiles.scriptPath,
    launcherPath: launchFiles.launcherPath,
    logPath: launchFiles.logPath,
    auth: readCodexAuthStatus()
  };
}

function restoreCodexChatGptAuth() {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  if (hasCodexChatGptTokens(current)) {
    backupCodexAuth('chatgpt', current);
    return { restored: false, source: 'current' };
  }
  const backup = readCodexAuthBackup('chatgpt');
  if (!backup || !hasCodexChatGptTokens(backup)) {
    throw new Error('未找到 Codex 官方登录备份。请先运行 codex login 完成官方登录，再切换到“代理 + 官方登录”。');
  }
  writeJsonFile(getCodexAuthPath(), backup);
  return { restored: true, source: getCodexAuthBackupPath('chatgpt') };
}

function getDirectCodexApiKey() {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  const currentKey = sanitizeCodexApiKey(current.OPENAI_API_KEY);
  if (currentKey && currentKey !== CODEX_PROXY_MANAGED_API_KEY && currentKey !== PROXY_MANAGED_TOKEN) return currentKey;
  const backup = readCodexAuthBackup('api');
  const backupKey = sanitizeCodexApiKey(backup && backup.OPENAI_API_KEY);
  if (backupKey && backupKey !== CODEX_PROXY_MANAGED_API_KEY && backupKey !== PROXY_MANAGED_TOKEN) return backupKey;
  throw new Error('官方直连 + API 登录需要真实 OpenAI API Key；当前只有本地代理占位 Key。请先用真实 Key 执行 codex login --with-api-key。');
}

function prepareCodexAuthSwitch(authMode, connectionMode) {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  if (hasCodexChatGptTokens(current)) backupCodexAuth('chatgpt', current);
  if (hasCodexApiKey(current)) backupCodexAuth('api', current);

  if (authMode === 'chatgpt') {
    return () => restoreCodexChatGptAuth();
  }

  if (authMode === 'api') {
    const apiKey = connectionMode === 'direct' ? getDirectCodexApiKey() : sanitizeCodexApiKey(current.OPENAI_API_KEY) || CODEX_PROXY_MANAGED_API_KEY;
    return () => {
      writeCodexApiAuth(apiKey);
      return { restored: false, source: apiKey === CODEX_PROXY_MANAGED_API_KEY ? 'proxy-managed' : 'user-api-key' };
    };
  }

  if (authMode === 'keep') return () => ({ restored: false, source: 'unchanged' });
  throw new Error(`不支持的 Codex 登录模式: ${authMode}`);
}

function removeLegacyManagedCodexApiKey() {
  const authPath = getCodexAuthPath();
  if (!fs.existsSync(authPath)) return false;
  const authObj = readJsonFile(authPath);
  if (!authObj || authObj.OPENAI_API_KEY !== PROXY_MANAGED_TOKEN) return false;
  delete authObj.OPENAI_API_KEY;
  writeJsonFile(authPath, authObj);
  return true;
}

function setEnvValue(content, key, value) {
  const regex = new RegExp('^\\s*' + key + '\\s*=\\s*.*$', 'm');
  const newLine = `${key}=${value}`;
  if (regex.test(content)) {
    return content.replace(regex, newLine);
  }
  const suffix = content.endsWith('\n') ? '' : '\n';
  return content + suffix + newLine + '\n';
}

function deleteEnvValue(content, key) {
  const regex = new RegExp('^\\s*' + key + '\\s*=\\s*.*$\\r?\\n?', 'gm');
  return content.replace(regex, '');
}

function getAntigravityCliStatus() {
  const configPath = getAntigravityCliConfigPath();
  const exists = fs.existsSync(configPath);
  const content = readJsonFile(configPath);
  const env = content && content.env ? content.env : {};
  return {
    exists,
    baseUrl: env.ANTIGRAVITY_BASE_URL || '',
    hasToken: !!env.ANTIGRAVITY_AUTH_TOKEN,
    configPath
  };
}

function applyAntigravityCliProxy() {
  const configPath = getAntigravityCliConfigPath();
  const config = readJsonFile(configPath);
  if (!config.env) config.env = {};
  config.env.ANTIGRAVITY_BASE_URL = LOCAL_PROXY_URL;
  config.env.ANTIGRAVITY_AUTH_TOKEN = PROXY_MANAGED_TOKEN;
  writeJsonFile(configPath, config);
}

function restoreAntigravityCliProxy() {
  const configPath = getAntigravityCliConfigPath();
  if (!fs.existsSync(configPath)) return;
  const config = readJsonFile(configPath);
  if (config.env) {
    delete config.env.ANTIGRAVITY_BASE_URL;
    delete config.env.ANTIGRAVITY_AUTH_TOKEN;
  }
  writeJsonFile(configPath, config);
}

function getClaudeCodeStatus() {
  const configPath = getClaudeCodeConfigPath();
  const exists = fs.existsSync(configPath);
  const content = readJsonFile(configPath);
  const env = content && content.env ? content.env : {};
  return {
    exists,
    baseUrl: env.ANTHROPIC_BASE_URL || '',
    hasToken: !!env.ANTHROPIC_AUTH_TOKEN || !!env.ANTHROPIC_API_KEY,
    configPath
  };
}

function applyClaudeCodeProxy() {
  const configPath = getClaudeCodeConfigPath();
  const config = readJsonFile(configPath);
  if (!config.env) config.env = {};
  config.env.ANTHROPIC_BASE_URL = LOCAL_PROXY_URL;
  config.env.ANTHROPIC_API_KEY = PROXY_MANAGED_TOKEN;
  delete config.env.ANTHROPIC_AUTH_TOKEN;
  writeJsonFile(configPath, config);
}

function restoreClaudeCodeProxy() {
  const configPath = getClaudeCodeConfigPath();
  if (!fs.existsSync(configPath)) return;
  const config = readJsonFile(configPath);
  if (config.env) {
    delete config.env.ANTHROPIC_BASE_URL;
    delete config.env.ANTHROPIC_AUTH_TOKEN;
    delete config.env.ANTHROPIC_API_KEY;
  }
  writeJsonFile(configPath, config);
}

function getCodexStatus(surface = 'cli') {
  const tomlPath = getCodexConfigPath();
  const managedCatalogPath = getCodexModelCatalogPath();
  const tomlExists = fs.existsSync(tomlPath);
  const authStatus = readCodexAuthStatus();
  let modelProvider = '';
  let baseUrl = '';
  let openaiBaseUrl = '';
  let legacyBaseUrl = '';
  let modelCatalogJson = '';

  if (tomlExists) {
    try {
      const content = fs.readFileSync(tomlPath, 'utf8');
      modelProvider = readTomlStringValue(content, 'model_provider');
      openaiBaseUrl = readTomlStringValue(content, 'openai_base_url');
      legacyBaseUrl = readTomlStringValue(content, 'base_url');
      modelCatalogJson = readTomlStringValue(content, 'model_catalog_json');
      baseUrl = openaiBaseUrl || legacyBaseUrl;
    } catch (err) {}
  }

  return {
    exists: tomlExists || authStatus.authExists,
    surface,
    sharedConfig: true,
    capability: surface === 'desktop' ? 'shared-codex-config' : 'codex-config',
    modelProvider,
    baseUrl,
    openaiBaseUrl,
    legacyBaseUrl,
    expectedBaseUrl: CODEX_PROXY_URL,
    modelCatalogJson,
    modelCatalogPath: managedCatalogPath,
    modelCatalogConfigured: !!modelCatalogJson,
    managedModelCatalog: samePath(modelCatalogJson, managedCatalogPath),
    modelCatalog: readCodexCatalogSummary(modelCatalogJson),
    rawAuthMode: authStatus.rawAuthMode,
    authMode: authStatus.authMode,
    hasApiKey: authStatus.hasApiKey,
    hasUserApiKey: authStatus.hasUserApiKey,
    hasManagedApiKey: authStatus.hasManagedApiKey,
    hasProxyManagedApiKey: authStatus.hasProxyManagedApiKey,
    hasChatGptTokens: authStatus.hasChatGptTokens,
    authConflict: authStatus.authConflict,
    authGuarded: authStatus.authGuarded,
    chatGptBackupExists: authStatus.chatGptBackupExists,
    apiBackupExists: authStatus.apiBackupExists,
    configPath: tomlPath,
    authPath: authStatus.authPath,
    requiresRestart: surface === 'desktop'
  };
}

function getCodexDesktopStatus() {
  return getCodexStatus('desktop');
}

function applyCodexProxy(options = {}) {
  const tomlPath = getCodexConfigPath();
  const tomlDir = path.dirname(tomlPath);
  if (!fs.existsSync(tomlDir)) {
    fs.mkdirSync(tomlDir, { recursive: true });
  }

  let tomlContent = '';
  if (fs.existsSync(tomlPath)) {
    tomlContent = fs.readFileSync(tomlPath, 'utf8');
  }
  tomlContent = deleteTomlValue(tomlContent, 'model_provider');
  tomlContent = deleteTomlValue(tomlContent, 'base_url');
  tomlContent = setTomlValue(tomlContent, 'openai_base_url', CODEX_PROXY_URL);
  const managedCatalogPath = getCodexModelCatalogPath();
  let catalogResult = null;
  let modelCatalogWarning = '';
  const modelRoutes = Array.isArray(options.modelRoutes) ? options.modelRoutes.filter((route) => route && route.from) : null;
  if (modelRoutes && modelRoutes.length > 0) {
    try {
      catalogResult = writeCodexModelCatalog(modelRoutes);
      if (catalogResult && catalogResult.path) {
        tomlContent = setTomlValue(tomlContent, 'model_catalog_json', normalizeCatalogPathForToml(catalogResult.path));
      }
    } catch (err) {
      modelCatalogWarning = err.message;
    }
  } else if (modelRoutes) {
    const modelCatalogJson = readTomlStringValue(tomlContent, 'model_catalog_json');
    if (samePath(modelCatalogJson, managedCatalogPath)) {
      tomlContent = deleteTomlValue(tomlContent, 'model_catalog_json');
    }
    if (fs.existsSync(managedCatalogPath)) {
      fs.unlinkSync(managedCatalogPath);
    }
  }
  fs.writeFileSync(tomlPath, tomlContent, 'utf8');

  return { modelCatalog: catalogResult, modelCatalogWarning, auth: readCodexAuthStatus() };
}

function restoreCodexProxy() {
  const tomlPath = getCodexConfigPath();
  const managedCatalogPath = getCodexModelCatalogPath();

  if (fs.existsSync(tomlPath)) {
    let tomlContent = fs.readFileSync(tomlPath, 'utf8');
    const modelCatalogJson = readTomlStringValue(tomlContent, 'model_catalog_json');
    tomlContent = deleteTomlValue(tomlContent, 'model_provider');
    tomlContent = deleteTomlValue(tomlContent, 'base_url');
    tomlContent = deleteTomlValue(tomlContent, 'openai_base_url');
    if (samePath(modelCatalogJson, managedCatalogPath)) {
      tomlContent = deleteTomlValue(tomlContent, 'model_catalog_json');
    }
    fs.writeFileSync(tomlPath, tomlContent, 'utf8');
  }

  const legacyManagedApiKeyRemoved = removeLegacyManagedCodexApiKey();
  if (fs.existsSync(managedCatalogPath)) {
    fs.unlinkSync(managedCatalogPath);
  }
  return { modelCatalogRemoved: true, legacyManagedApiKeyRemoved, auth: readCodexAuthStatus() };
}

function switchCodexMode(options = {}) {
  const connectionMode = options.connection === 'direct' ? 'direct' : 'proxy';
  const authMode = options.auth || 'keep';

  // Official direct + API is the one combination where the auth preflight must
  // pass before changing connection. A proxy placeholder key would break direct
  // OpenAI API calls, so keep the current connection untouched in that case.
  if (connectionMode === 'direct' && authMode === 'api') {
    getDirectCodexApiKey();
  }

  const applyAuthSwitch = prepareCodexAuthSwitch(authMode, connectionMode);
  const connectionResult = connectionMode === 'proxy'
    ? applyCodexProxy({ modelRoutes: options.modelRoutes })
    : restoreCodexProxy();
  let authSwitch = null;
  let authWarning = '';
  try {
    authSwitch = applyAuthSwitch();
  } catch (err) {
    authSwitch = { restored: false, source: 'failed', error: err.message };
    authWarning = err.message;
  }
  return {
    connectionMode,
    authMode,
    connection: connectionResult,
    authSwitch,
    authWarning,
    partial: !!authWarning,
    auth: readCodexAuthStatus(),
    status: getCodexStatus(options.surface || 'desktop')
  };
}

function getGeminiCliStatus() {
  const settingsPath = getGeminiSettingsPath();
  const envPath = getGeminiEnvPath();
  const settingsExists = fs.existsSync(settingsPath);
  const envExists = fs.existsSync(envPath);
  let apiEndpoint = '';
  let envBaseUrl = '';

  if (settingsExists) {
    const content = readJsonFile(settingsPath);
    apiEndpoint = content.apiEndpoint || '';
  }

  if (envExists) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^\s*GOOGLE_GEMINI_BASE_URL\s*=\s*(.*)$/m);
      if (match) envBaseUrl = match[1].trim();
    } catch (err) {}
  }

  return {
    exists: settingsExists || envExists,
    apiEndpoint,
    envBaseUrl,
    configPath: settingsPath,
    envPath
  };
}

function applyGeminiCliProxy() {
  const settingsPath = getGeminiSettingsPath();
  const envPath = getGeminiEnvPath();
  const settingsObj = readJsonFile(settingsPath);
  settingsObj.apiEndpoint = LOCAL_PROXY_URL;
  writeJsonFile(settingsPath, settingsObj);

  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  envContent = setEnvValue(envContent, 'GOOGLE_GEMINI_BASE_URL', LOCAL_PROXY_URL);
  fs.writeFileSync(envPath, envContent, 'utf8');
}

function restoreGeminiCliProxy() {
  const settingsPath = getGeminiSettingsPath();
  const envPath = getGeminiEnvPath();

  if (fs.existsSync(settingsPath)) {
    const settingsObj = readJsonFile(settingsPath);
    delete settingsObj.apiEndpoint;
    writeJsonFile(settingsPath, settingsObj);
  }

  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    envContent = deleteEnvValue(envContent, 'GOOGLE_GEMINI_BASE_URL');
    fs.writeFileSync(envPath, envContent, 'utf8');
  }
}

module.exports = {
  getClaudeCodeConfigPath,
  getAntigravityCliConfigPath,
  getCodexConfigPath,
  getCodexAuthPath,
  getCodexAuthBackupPath,
  getCodexModelCachePath,
  getCodexModelCatalogPath,
  readCodexAuthStatus,
  getGeminiSettingsPath,
  getGeminiEnvPath,
  setTomlValue,
  deleteTomlValue,
  readTomlStringValue,
  setEnvValue,
  deleteEnvValue,
  getAntigravityCliStatus,
  applyAntigravityCliProxy,
  restoreAntigravityCliProxy,
  getClaudeCodeStatus,
  applyClaudeCodeProxy,
  restoreClaudeCodeProxy,
  getCodexStatus,
  getCodexDesktopStatus,
  buildCodexModelCatalog,
  writeCodexModelCatalog,
  applyCodexApiLogin,
  backupCurrentCodexAuth,
  buildCodexOfficialLoginLaunchArgs,
  launchCodexOfficialLogin,
  applyCodexProxy,
  restoreCodexProxy,
  switchCodexMode,
  getGeminiCliStatus,
  applyGeminiCliProxy,
  restoreGeminiCliProxy
};
