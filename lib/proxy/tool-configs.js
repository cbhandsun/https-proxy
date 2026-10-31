const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { writeJsonFileAtomically, writeTextFileAtomically } = require('./management-utils');
const { CA_CERT_FILE } = require('./cert');
const { computeCodexDesktopDrift } = require('./tool-config-drift');
const {
  configureCodexToolDiscovery,
  readCodexToolDiscoveryStatus,
  validateCodexToolDiscoveryOptions,
} = require('./codex-tool-discovery-config');

const LOCAL_PROXY_URL = 'https://localhost:3443';
const CODEX_PROXY_URL = 'https://localhost:3445/v1';
const CODEX_HTTP_PROXY_URL = 'http://localhost:3085/v1';
const NODE_EXTRA_CA_CERTS_ENV = 'NODE_EXTRA_CA_CERTS';
const CODEX_MODEL_CATALOG_FILE = 'hpm-model-catalog.json';
const PROXY_MANAGED_TOKEN = 'PROXY_MANAGED';
const CODEX_PROXY_MANAGED_API_KEY = 'sk-proxy-managed';

const STANDARD_CODEX_REASONING_LEVELS = Object.freeze([
  { effort: 'low', description: '快速响应，轻度思考' },
  { effort: 'medium', description: '平衡响应速度与深度思考' },
  { effort: 'high', description: '深度推理，适合复杂任务' },
  { effort: 'xhigh', description: '极致思考，适合最困难任务' },
]);

// Identity lines written into the managed [model_providers.custom] section.
// A section-deletion bug used to strand these lines inside the previously
// declared section (for example [memories]), which made Codex report them as
// unrecognized settings. Keep the exact strings so the orphan cleanup stays
// conservative and never touches user-authored providers.
const MANAGED_PROVIDER_IDENTITY_LINES = Object.freeze([
  'name = "HTTPS Proxy"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'request_max_retries = 1',
  'stream_max_retries = 1',
]);
const MANAGED_PROVIDER_BASE_URLS = Object.freeze([CODEX_HTTP_PROXY_URL, CODEX_PROXY_URL]);

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
  writeJsonFileAtomically(filePath, value);
}

function setTomlValue(content, key, value) {
  const regex = new RegExp('^\\s*' + key + '\\s*=\\s*.*$', 'm');
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const newLine = `${key} = "${escaped}"`;
  if (regex.test(content)) {
    return content.replace(regex, newLine);
  }
  const firstSectionIndex = content.search(/^\[/m);
  if (firstSectionIndex !== -1) {
    const before = content.slice(0, firstSectionIndex);
    const after = content.slice(firstSectionIndex);
    const suffix = before.endsWith('\n') ? '' : '\n';
    return before + suffix + newLine + '\n\n' + after;
  }
  const suffix = content.endsWith('\n') ? '' : '\n';
  return content + suffix + newLine + '\n';
}

function deleteTomlValue(content, key) {
  const regex = new RegExp('^\\s*' + key + '\\s*=\\s*.*$\\r?\\n?', 'gm');
  return content.replace(regex, '');
}

function collapseBlankRuns(content) {
  return String(content).replace(/(\r?\n){3,}/g, '\n\n');
}

function parseTomlSectionHeader(line) {
  const match = String(line)
    .trim()
    .match(/^\[\s*([^\]]+?)\s*\]$/);
  return match ? match[1] : null;
}

// Removes a TOML table together with its body.
//
// The previous regex implementation used a dollar end-of-string alternative
// together with the multiline flag, so that anchor also matched at every line
// end. The lazy body match then stopped right after the section header and only
// the header line was deleted, stranding the section body inside the previously
// declared table. The stranded provider keys made Codex report unrecognized
// configuration settings. Walking the lines keeps the deletion explicit.
function deleteTomlSection(content, sectionName) {
  const text = String(content ?? '');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => parseTomlSectionHeader(line) === sectionName);
  if (start === -1) return text;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (parseTomlSectionHeader(lines[index]) !== null) {
      end = index;
      break;
    }
  }

  lines.splice(start, end - start);
  return collapseBlankRuns(lines.join('\n'));
}

function managedProviderLineSet() {
  const lines = new Set(MANAGED_PROVIDER_IDENTITY_LINES);
  for (const url of MANAGED_PROVIDER_BASE_URLS) {
    lines.add('base_url = "' + url + '"');
  }
  return lines;
}

// Drops managed provider blocks that were stranded outside a provider table by
// the previous section deletion bug.
//
// Only a contiguous run of at least three managed lines outside any
// model_providers table is removed. Requiring contiguity keeps the heal narrow:
// scattered lookalike values and user-authored provider tables are left as-is.
function stripOrphanedManagedProviderLines(content) {
  const text = String(content ?? '');
  if (!text) return text;

  const managedLines = managedProviderLineSet();
  const lines = text.split('\n');
  const kept = [];
  let currentSection = null;
  let removed = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = parseTomlSectionHeader(line);
    if (header !== null) {
      currentSection = header;
      kept.push(line);
      continue;
    }

    const insideProviderTable =
      typeof currentSection === 'string' && currentSection.startsWith('model_providers.');
    if (insideProviderTable || !managedLines.has(line.trim())) {
      kept.push(line);
      continue;
    }

    let runEnd = index;
    while (runEnd + 1 < lines.length && managedLines.has(lines[runEnd + 1].trim())) {
      runEnd += 1;
    }
    const runLength = runEnd - index + 1;
    if (runLength >= 3) {
      removed += runLength;
      index = runEnd;
      continue;
    }
    for (let cursor = index; cursor <= runEnd; cursor += 1) {
      kept.push(lines[cursor]);
    }
    index = runEnd;
  }

  return removed > 0 ? collapseBlankRuns(kept.join('\n')) : text;
}

function setTomlSection(content, sectionName, sectionBody) {
  const cleaned = deleteTomlSection(content, sectionName);
  const trimmedBody = sectionBody.trim();
  const sectionText = `[${sectionName}]\n${trimmedBody}\n`;
  const suffix = cleaned.endsWith('\n\n') ? '' : cleaned.endsWith('\n') ? '\n' : '\n\n';
  return cleaned + suffix + sectionText;
}

function readTomlStringValue(content, key) {
  const regex = new RegExp('^\\s*' + key + '\\s*=\\s*["\']([^"\']*)["\']', 'm');
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

function applyNodeExtraCaCerts(env) {
  if (!env || typeof env !== 'object') return;
  env[NODE_EXTRA_CA_CERTS_ENV] = CA_CERT_FILE;
}

function removeNodeExtraCaCerts(env) {
  if (!env || typeof env !== 'object') return;
  if (env[NODE_EXTRA_CA_CERTS_ENV] === CA_CERT_FILE) {
    delete env[NODE_EXTRA_CA_CERTS_ENV];
  }
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
  return String((route && (route.labelOverride || route.displayName || route.from)) || '').trim();
}

function shouldRetainUnroutedCodexCacheModel(model) {
  return !!(model && (model.visibility === 'hide' || model.supported_in_api === false));
}

function buildCodexModelCatalog(modelRoutes) {
  const cache = readCodexModelCache();
  const baseModels = cache.models.filter((model) => model && model.slug);
  const template =
    baseModels.find((model) => model.base_instructions || model.model_messages) || baseModels[0];
  if (!template || (!template.base_instructions && !template.model_messages)) {
    throw new Error('Codex model cache does not include a usable model template');
  }

  const routeModels = [];
  const seen = new Set();
  for (const route of Array.isArray(modelRoutes) ? modelRoutes : []) {
    const slug = String((route && route.from) || '').trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const targetTo = String((route && route.to) || '').trim();
    const existing =
      baseModels.find((model) => model.slug === slug) ||
      (targetTo ? baseModels.find((model) => model.slug === targetTo) : null);
    const model = cloneJson(existing || template);
    model.slug = slug;
    model.display_name = displayNameForRoute(route) || slug;
    model.description = `HTTPS Proxy route to ${route.profileId || 'default'}:${route.to || '*'}`;
    model.visibility = 'list';
    model.supported_in_api = true;
    model.priority = -100 + routeModels.length;

    // Inject 4-tier reasoning levels so Codex Desktop Power Slider (thinking depth) works natively
    const existingLevels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
      : [];
    if (existingLevels.length < 2) {
      model.supported_reasoning_levels = cloneJson(STANDARD_CODEX_REASONING_LEVELS);
    }
    if (!model.default_reasoning_level || model.default_reasoning_level === 'none') {
      model.default_reasoning_level = 'medium';
    }

    const isTianxiRoute =
      route.profileId === 'tianxi-official' ||
      slug.startsWith('tianxi/') ||
      Boolean(route.tianxiSdkModel || route.tianxiAgentId || route.tianxiLlm);
    if (isTianxiRoute) {
      model.context_window = 12000;
      model.max_context_window = 12000;
      model.auto_compact_token_limit = 8000;
      model.supports_parallel_tool_calls = false;
      model.input_modalities = ['text'];
      model.prefer_websockets = false;
    }

    routeModels.push(model);
  }

  const routedSlugs = new Set(routeModels.map((model) => model.slug));
  return {
    models: routeModels.concat(
      baseModels.filter(
        (model) => !routedSlugs.has(model.slug) && shouldRetainUnroutedCodexCacheModel(model)
      )
    ),
  };
}

function writeCodexModelCatalog(modelRoutes) {
  const routes = Array.isArray(modelRoutes)
    ? modelRoutes.filter((route) => route && route.from)
    : [];
  if (routes.length === 0) return null;
  const catalogPath = getCodexModelCatalogPath();
  const catalog = buildCodexModelCatalog(routes);
  writeJsonFileAtomically(catalogPath, catalog);
  return {
    path: catalogPath,
    modelCount: catalog.models.length,
    routeCount: routes.length,
  };
}

function readCodexCatalogSummary(catalogPath) {
  if (!catalogPath || !fs.existsSync(catalogPath))
    return { exists: false, modelCount: 0, routeCount: 0, routeSlugs: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8').replace(/^\uFEFF/, ''));
    const models = Array.isArray(parsed && parsed.models) ? parsed.models : [];
    const routed = models.filter((model) =>
      String((model && model.description) || '').startsWith('HTTPS Proxy route to ')
    );
    return {
      exists: true,
      modelCount: models.length,
      routeCount: routed.length,
      routeSlugs: routed.map((model) => String((model && model.slug) || '').trim()).filter(Boolean),
    };
  } catch (err) {
    return { exists: true, modelCount: 0, routeCount: 0, routeSlugs: [], error: err.message };
  }
}

function readCodexAuthStatus() {
  const authPath = getCodexAuthPath();
  const authExists = fs.existsSync(authPath);
  const content = authExists ? readJsonFile(authPath) : {};
  const rawAuthMode =
    typeof content.auth_mode === 'string' ? content.auth_mode.trim().toLowerCase() : '';
  const apiKey =
    typeof content.OPENAI_API_KEY === 'string' ? sanitizeCodexApiKey(content.OPENAI_API_KEY) : '';
  const hasManagedApiKey = apiKey === PROXY_MANAGED_TOKEN;
  const hasProxyManagedApiKey = apiKey === CODEX_PROXY_MANAGED_API_KEY;
  const hasUserApiKey = !!apiKey && !hasManagedApiKey;
  const tokens =
    content && typeof content.tokens === 'object' && content.tokens ? content.tokens : null;
  const hasChatGptTokens = !!(
    tokens &&
    (tokens.access_token || tokens.refresh_token || tokens.id_token)
  );
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
    apiBackupExists: fs.existsSync(getCodexAuthBackupPath('api')),
  };
}

function sanitizeCodexApiKey(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim();
}

function hasCodexChatGptTokens(authObj) {
  const tokens =
    authObj && typeof authObj.tokens === 'object' && authObj.tokens ? authObj.tokens : null;
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
    OPENAI_API_KEY: cleaned,
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
    apiKeySource: apiKey === CODEX_PROXY_MANAGED_API_KEY ? 'proxy-managed' : 'user-api-key',
  };
}

function backupCurrentCodexAuth() {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  const chatgptBackedUp = backupCodexAuth('chatgpt', current);
  const apiBackedUp = backupCodexAuth('api', current);
  return {
    chatgptBackedUp,
    apiBackedUp,
    auth: readCodexAuthStatus(),
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
    'try { Start-Transcript -Path $logPath -Append | Out-Null } catch {}',
    '$codexCommand = Get-Command codex.cmd -ErrorAction SilentlyContinue',
    'if (-not $codexCommand) { $codexCommand = Get-Command codex -ErrorAction SilentlyContinue }',
    "if (-not $codexCommand) { Write-Host 'Codex CLI not found in PATH.'; Read-Host 'Press Enter to close'; exit 1 }",
    "Write-Host 'Codex official login is starting...'",
    "Write-Host 'Finish the browser/device login, then return to HTTPS Proxy Manager.'",
    "Write-Host ('Using Codex CLI: ' + $codexCommand.Source)",
  ];
  if (shouldLogout)
    lines.push("Write-Host 'Running codex logout...'; & $codexCommand.Source logout");
  lines.push("Write-Host 'Running codex login...'; & $codexCommand.Source login");
  lines.push("Write-Host ''");
  lines.push(
    "Write-Host 'Codex login command finished. You can close this window after HTTPS Proxy Manager detects the login.'"
  );
  lines.push('try { Stop-Transcript | Out-Null } catch {}');
  lines.push("Read-Host 'Press Enter to close'");
  writeTextFileAtomically(scriptPath, lines.join(os.EOL) + os.EOL);

  const launchCommand = `powershell.exe -NoExit -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const vbsLines = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${quoteVbsString(launchCommand)}, 1, False`,
  ];
  writeTextFileAtomically(launcherPath, vbsLines.join(os.EOL) + os.EOL);
  return { scriptPath, launcherPath, logPath };
}

function buildCodexOfficialLoginLaunchArgs(options = {}) {
  const launcherPath = options.launcherPath || getCodexOfficialLoginLauncherPath();
  const startCommand = [
    `Start-Process -FilePath ${quotePowerShellSingle(launcherPath)} -WindowStyle Normal`,
  ].join('; ');
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', startCommand];
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
      auth: readCodexAuthStatus(),
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
    auth: readCodexAuthStatus(),
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
    throw new Error(
      '未找到 Codex 官方登录备份。请先运行 codex login 完成官方登录，再切换到“代理 + 官方登录”。'
    );
  }
  writeJsonFile(getCodexAuthPath(), backup);
  return { restored: true, source: getCodexAuthBackupPath('chatgpt') };
}

function getDirectCodexApiKey() {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  const currentKey = sanitizeCodexApiKey(current.OPENAI_API_KEY);
  if (
    currentKey &&
    currentKey !== CODEX_PROXY_MANAGED_API_KEY &&
    currentKey !== PROXY_MANAGED_TOKEN
  )
    return currentKey;
  const backup = readCodexAuthBackup('api');
  const backupKey = sanitizeCodexApiKey(backup && backup.OPENAI_API_KEY);
  if (backupKey && backupKey !== CODEX_PROXY_MANAGED_API_KEY && backupKey !== PROXY_MANAGED_TOKEN)
    return backupKey;
  throw new Error(
    '官方直连 + API 登录需要真实 OpenAI API Key；当前只有本地代理占位 Key。请先用真实 Key 执行 codex login --with-api-key。'
  );
}

function prepareCodexAuthSwitch(authMode, connectionMode) {
  const current = fs.existsSync(getCodexAuthPath()) ? readJsonFile(getCodexAuthPath()) : {};
  if (hasCodexChatGptTokens(current)) backupCodexAuth('chatgpt', current);
  if (hasCodexApiKey(current)) backupCodexAuth('api', current);

  if (authMode === 'chatgpt') {
    return () => restoreCodexChatGptAuth();
  }

  if (authMode === 'api') {
    const apiKey =
      connectionMode === 'direct'
        ? getDirectCodexApiKey()
        : sanitizeCodexApiKey(current.OPENAI_API_KEY) || CODEX_PROXY_MANAGED_API_KEY;
    return () => {
      writeCodexApiAuth(apiKey);
      return {
        restored: false,
        source: apiKey === CODEX_PROXY_MANAGED_API_KEY ? 'proxy-managed' : 'user-api-key',
      };
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
    model: env.ANTIGRAVITY_MODEL || content.model || '',
    hasToken: !!env.ANTIGRAVITY_AUTH_TOKEN,
    configPath,
  };
}

function applyAntigravityCliProxy(options = {}) {
  const configPath = getAntigravityCliConfigPath();
  const config = readJsonFile(configPath);
  if (!config.env) config.env = {};
  config.env.ANTIGRAVITY_BASE_URL = LOCAL_PROXY_URL;
  config.env.ANTIGRAVITY_AUTH_TOKEN = PROXY_MANAGED_TOKEN;
  if (options && typeof options.model === 'string' && options.model.trim()) {
    config.env.ANTIGRAVITY_MODEL = options.model.trim();
  }
  applyNodeExtraCaCerts(config.env);
  writeJsonFile(configPath, config);
}

function restoreAntigravityCliProxy() {
  const configPath = getAntigravityCliConfigPath();
  if (!fs.existsSync(configPath)) return;
  const config = readJsonFile(configPath);
  if (config.env) {
    delete config.env.ANTIGRAVITY_BASE_URL;
    delete config.env.ANTIGRAVITY_AUTH_TOKEN;
    delete config.env.ANTIGRAVITY_MODEL;
    removeNodeExtraCaCerts(config.env);
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
    model: env.ANTHROPIC_MODEL || content.model || '',
    fastModel: env.ANTHROPIC_SMALL_FAST_MODEL || '',
    hasToken: !!env.ANTHROPIC_AUTH_TOKEN || !!env.ANTHROPIC_API_KEY,
    configPath,
  };
}

function applyClaudeCodeProxy(options = {}) {
  const configPath = getClaudeCodeConfigPath();
  const config = readJsonFile(configPath);
  if (!config.env) config.env = {};
  config.env.ANTHROPIC_BASE_URL = LOCAL_PROXY_URL;
  config.env.ANTHROPIC_API_KEY = PROXY_MANAGED_TOKEN;
  if (options && typeof options.model === 'string' && options.model.trim()) {
    config.env.ANTHROPIC_MODEL = options.model.trim();
  }
  if (options && typeof options.fastModel === 'string') {
    const fm = options.fastModel.trim();
    if (fm) config.env.ANTHROPIC_SMALL_FAST_MODEL = fm;
    else delete config.env.ANTHROPIC_SMALL_FAST_MODEL;
  }
  applyNodeExtraCaCerts(config.env);
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
    delete config.env.ANTHROPIC_MODEL;
    delete config.env.ANTHROPIC_SMALL_FAST_MODEL;
    removeNodeExtraCaCerts(config.env);
  }
  writeJsonFile(configPath, config);
}

function getCodexStatus(surface = 'cli', options = {}) {
  const tomlPath = getCodexConfigPath();
  const managedCatalogPath = getCodexModelCatalogPath();
  const tomlExists = fs.existsSync(tomlPath);
  const authStatus = readCodexAuthStatus();
  let modelProvider = '';
  let model = '';
  let modelReasoningEffort = '';
  let baseUrl = '';
  let openaiBaseUrl = '';
  let legacyBaseUrl = '';
  let customBaseUrl = '';
  let modelCatalogJson = '';
  let toolDiscovery = { enabled: false, editable: true };

  if (tomlExists) {
    try {
      const content = fs.readFileSync(tomlPath, 'utf8');
      toolDiscovery = readCodexToolDiscoveryStatus(content);
      modelProvider = readTomlStringValue(content, 'model_provider');
      model = readTomlStringValue(content, 'model');
      modelReasoningEffort = readTomlStringValue(content, 'model_reasoning_effort');
      const topLevelContent = content.split(/^\[/m)[0] || '';
      openaiBaseUrl = readTomlStringValue(content, 'openai_base_url');
      legacyBaseUrl = readTomlStringValue(topLevelContent, 'base_url');
      modelCatalogJson = readTomlStringValue(content, 'model_catalog_json');

      const customSectionMatch = content.match(/\[model_providers\.custom\][^[]*/);
      if (customSectionMatch) {
        customBaseUrl = readTomlStringValue(customSectionMatch[0], 'base_url');
      }

      baseUrl = (modelProvider === 'custom' && customBaseUrl) || openaiBaseUrl || legacyBaseUrl;
    } catch (err) {}
  }

  const isCustomModern = modelProvider === 'custom' && !!customBaseUrl;
  const expectedBaseUrl = isCustomModern ? CODEX_HTTP_PROXY_URL : CODEX_PROXY_URL;
  const managedModelCatalog = samePath(modelCatalogJson, managedCatalogPath);
  const modelCatalog = readCodexCatalogSummary(modelCatalogJson);
  const drift = computeCodexDesktopDrift({
    expectedBaseUrl,
    actualBaseUrl: baseUrl,
    catalogSlugs: modelCatalog.routeSlugs,
    routeSlugs: Array.isArray(options.routeSlugs) ? options.routeSlugs : null,
    proxyConfigured: !!baseUrl,
    managedCatalog: managedModelCatalog,
  });

  return {
    exists: tomlExists || authStatus.authExists,
    surface,
    sharedConfig: true,
    capability: surface === 'desktop' ? 'shared-codex-config' : 'codex-config',
    modelProvider,
    model,
    modelReasoningEffort,
    toolDiscoveryEnabled: modelProvider === 'custom' && toolDiscovery.enabled,
    toolDiscoveryEditable: toolDiscovery.editable,
    baseUrl,
    openaiBaseUrl,
    legacyBaseUrl,
    customBaseUrl,
    isCustomModern,
    expectedBaseUrl,
    modelCatalogJson,
    modelCatalogPath: managedCatalogPath,
    modelCatalogConfigured: !!modelCatalogJson,
    managedModelCatalog,
    modelCatalog,
    drift,
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
    requiresRestart: surface === 'desktop',
  };
}

function getCodexDesktopStatus(options = {}) {
  return getCodexStatus('desktop', options);
}

function applyCodexProxy(options = {}) {
  const toolDiscovery = validateCodexToolDiscoveryOptions(options);
  const tomlPath = getCodexConfigPath();
  const tomlDir = path.dirname(tomlPath);
  if (!fs.existsSync(tomlDir)) {
    fs.mkdirSync(tomlDir, { recursive: true });
  }

  let tomlContent = '';
  if (fs.existsSync(tomlPath)) {
    tomlContent = fs.readFileSync(tomlPath, 'utf8');
  }

  // Repair configs damaged by the previous section-deletion bug before any
  // managed section is rewritten.
  tomlContent = stripOrphanedManagedProviderLines(tomlContent);
  const discovery = configureCodexToolDiscovery(tomlContent, toolDiscovery);
  tomlContent = discovery.content;

  const modelRoutes = Array.isArray(options.modelRoutes)
    ? options.modelRoutes.filter((route) => route && route.from)
    : null;

  // Modern configuration: model_provider = "custom", model, model_reasoning_effort, [model_providers.custom]
  tomlContent = setTomlValue(tomlContent, 'model_provider', 'custom');
  if (options.model) {
    tomlContent = setTomlValue(tomlContent, 'model', options.model);
  } else if (!readTomlStringValue(tomlContent, 'model')) {
    const defaultModel = modelRoutes && modelRoutes.length > 0 ? modelRoutes[0].from : 'gpt-5.5';
    tomlContent = setTomlValue(tomlContent, 'model', defaultModel);
  }

  if (options.reasoningEffort) {
    tomlContent = setTomlValue(tomlContent, 'model_reasoning_effort', options.reasoningEffort);
  } else if (!readTomlStringValue(tomlContent, 'model_reasoning_effort')) {
    tomlContent = setTomlValue(tomlContent, 'model_reasoning_effort', 'medium');
  }

  // Maintain backward compatibility for older Codex builds / CLI (top-level keys)
  tomlContent = deleteTomlValue(tomlContent, 'base_url');
  tomlContent = deleteTomlValue(tomlContent, 'model_auto_compact_token_limit');
  tomlContent = deleteTomlValue(tomlContent, 'model_auto_compact_token_limit_scope');
  tomlContent = setTomlValue(tomlContent, 'openai_base_url', CODEX_PROXY_URL);

  const managedCatalogPath = getCodexModelCatalogPath();
  let catalogResult = null;
  let modelCatalogWarning = '';

  if (modelRoutes && modelRoutes.length > 0) {
    try {
      catalogResult = writeCodexModelCatalog(modelRoutes);
      if (catalogResult && catalogResult.path) {
        tomlContent = setTomlValue(
          tomlContent,
          'model_catalog_json',
          normalizeCatalogPathForToml(catalogResult.path)
        );
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

  // Set modern [model_providers.custom] section (placed at bottom)
  const customSectionBody = [
    'name = "HTTPS Proxy"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    `base_url = "${CODEX_HTTP_PROXY_URL}"`,
    'request_max_retries = 1',
    'stream_max_retries = 1',
    ...(discovery.providerHeadersLine ? [discovery.providerHeadersLine] : []),
  ].join('\n');
  tomlContent = setTomlSection(tomlContent, 'model_providers.custom', customSectionBody);

  writeTextFileAtomically(tomlPath, tomlContent);

  return {
    modelCatalog: catalogResult,
    modelCatalogWarning,
    toolDiscoveryEnabled: discovery.enabled,
    auth: readCodexAuthStatus(),
  };
}

function restoreCodexProxy() {
  const tomlPath = getCodexConfigPath();
  const managedCatalogPath = getCodexModelCatalogPath();

  if (fs.existsSync(tomlPath)) {
    let tomlContent = fs.readFileSync(tomlPath, 'utf8');
    const modelCatalogJson = readTomlStringValue(tomlContent, 'model_catalog_json');
    tomlContent = deleteTomlValue(tomlContent, 'model_provider');
    tomlContent = deleteTomlValue(tomlContent, 'model');
    tomlContent = deleteTomlValue(tomlContent, 'model_reasoning_effort');
    tomlContent = deleteTomlValue(tomlContent, 'base_url');
    tomlContent = deleteTomlValue(tomlContent, 'openai_base_url');
    tomlContent = deleteTomlSection(tomlContent, 'model_providers.custom');
    tomlContent = deleteTomlSection(tomlContent, 'model_providers.custom.http_headers');
    if (samePath(modelCatalogJson, managedCatalogPath)) {
      tomlContent = deleteTomlValue(tomlContent, 'model_catalog_json');
    }
    writeTextFileAtomically(tomlPath, tomlContent);
  }

  const legacyManagedApiKeyRemoved = removeLegacyManagedCodexApiKey();
  if (fs.existsSync(managedCatalogPath)) {
    fs.unlinkSync(managedCatalogPath);
  }
  return { modelCatalogRemoved: true, legacyManagedApiKeyRemoved, auth: readCodexAuthStatus() };
}

function switchCodexMode(options = {}) {
  const toolDiscovery = validateCodexToolDiscoveryOptions(options);
  const connectionMode = options.connection === 'direct' ? 'direct' : 'proxy';
  const authMode = options.auth || 'keep';

  // Official direct + API is the one combination where the auth preflight must
  // pass before changing connection. A proxy placeholder key would break direct
  // OpenAI API calls, so keep the current connection untouched in that case.
  if (connectionMode === 'direct' && authMode === 'api') {
    getDirectCodexApiKey();
  }

  const applyAuthSwitch = prepareCodexAuthSwitch(authMode, connectionMode);
  const connectionResult =
    connectionMode === 'proxy'
      ? applyCodexProxy({
          modelRoutes: options.modelRoutes,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          toolDiscovery,
        })
      : restoreCodexProxy();
  let authSwitch;
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
    status: getCodexStatus(options.surface || 'desktop'),
  };
}

function getGeminiCliStatus() {
  const settingsPath = getGeminiSettingsPath();
  const envPath = getGeminiEnvPath();
  const settingsExists = fs.existsSync(settingsPath);
  const envExists = fs.existsSync(envPath);
  let apiEndpoint = '';
  let envBaseUrl = '';
  let model = '';

  if (settingsExists) {
    const content = readJsonFile(settingsPath);
    apiEndpoint = content.apiEndpoint || '';
    if (content.model) model = String(content.model).trim();
  }

  if (envExists) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^\s*GOOGLE_GEMINI_BASE_URL\s*=\s*(.*)$/m);
      if (match) envBaseUrl = match[1].trim();
      const modelMatch = content.match(/^\s*GEMINI_MODEL\s*=\s*(.*)$/m);
      if (modelMatch) model = modelMatch[1].trim();
    } catch (err) {}
  }

  return {
    exists: settingsExists || envExists,
    apiEndpoint,
    envBaseUrl,
    model,
    configPath: settingsPath,
    envPath,
  };
}

function applyGeminiCliProxy(options = {}) {
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
  envContent = setEnvValue(envContent, NODE_EXTRA_CA_CERTS_ENV, CA_CERT_FILE);
  if (options && typeof options.model === 'string' && options.model.trim()) {
    envContent = setEnvValue(envContent, 'GEMINI_MODEL', options.model.trim());
  }
  writeTextFileAtomically(envPath, envContent);
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
    envContent = deleteEnvValue(envContent, NODE_EXTRA_CA_CERTS_ENV);
    envContent = deleteEnvValue(envContent, 'GEMINI_MODEL');
    writeTextFileAtomically(envPath, envContent);
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
  CA_CERT_FILE,
  NODE_EXTRA_CA_CERTS_ENV,
  setTomlValue,
  deleteTomlValue,
  deleteTomlSection,
  stripOrphanedManagedProviderLines,
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
  shouldRetainUnroutedCodexCacheModel,
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
  restoreGeminiCliProxy,
};
