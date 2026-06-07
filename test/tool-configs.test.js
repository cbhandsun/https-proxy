const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-tool-configs-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
fs.mkdirSync(path.join(tempHome, '.codex'), { recursive: true });
const authPath = path.join(tempHome, '.codex', 'auth.json');
const chatGptAuth = {
  tokens: {
    access_token: 'chatgpt-access',
    refresh_token: 'chatgpt-refresh',
  },
};
fs.writeFileSync(authPath, JSON.stringify(chatGptAuth, null, 2), 'utf8');
fs.writeFileSync(path.join(tempHome, '.codex', 'models_cache.json'), JSON.stringify({
  models: [{
    slug: 'gpt-5.5',
    display_name: 'GPT-5.5',
    description: 'Template model',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    base_instructions: 'You are Codex.',
  }],
}, null, 2), 'utf8');

const {
  applyCodexProxy,
  getCodexDesktopStatus,
  readCodexAuthStatus,
  getCodexModelCatalogPath,
  getCodexStatus,
  restoreCodexProxy,
  applyCodexApiLogin,
  backupCurrentCodexAuth,
  buildCodexOfficialLoginLaunchArgs,
  switchCodexMode,
} = require('../lib/proxy/tool-configs');

assert.deepStrictEqual(readCodexAuthStatus(), {
  authPath,
  authExists: true,
  rawAuthMode: '',
  authMode: 'chatgpt',
  hasChatGptTokens: true,
  hasApiKey: false,
  hasUserApiKey: false,
  hasManagedApiKey: false,
  hasProxyManagedApiKey: false,
  authConflict: false,
  authGuarded: true,
  chatGptBackupExists: false,
  apiBackupExists: false,
});

const initialBackup = backupCurrentCodexAuth();
assert.strictEqual(initialBackup.chatgptBackedUp, true);
assert.strictEqual(initialBackup.apiBackedUp, false);
assert.strictEqual(initialBackup.auth.chatGptBackupExists, true);

const apiLoginResult = applyCodexApiLogin();
assert.strictEqual(apiLoginResult.auth.authMode, 'api');
assert.strictEqual(apiLoginResult.auth.hasProxyManagedApiKey, true);
assert.strictEqual(apiLoginResult.apiKeySource, 'proxy-managed');
assert.strictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY, 'sk-proxy-managed');
fs.writeFileSync(authPath, JSON.stringify(chatGptAuth, null, 2), 'utf8');

const officialLoginArgs = buildCodexOfficialLoginLaunchArgs();
assert.deepStrictEqual(officialLoginArgs.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command']);
assert.match(officialLoginArgs[4], /Start-Process -FilePath /);
assert.match(officialLoginArgs[4], /hpm-codex-official-login\.vbs/);
assert.ok(!officialLoginArgs.includes('/c'));
assert.ok(!officialLoginArgs.includes('start'));
assert.ok(!officialLoginArgs.includes('Official'));

const applyResult = applyCodexProxy({
  modelRoutes: [
    { from: 'codex/deepseek-v4-flash', profileId: 'deepseek', to: 'deepseek-v4-flash', labelOverride: 'DeepSeek V4 Flash' },
    { from: 'gpt-5.5', profileId: 'openai-official', to: 'gpt-5.5', labelOverride: 'GPT-5.5 Routed' },
  ],
});
assert.strictEqual(applyResult.modelCatalog.routeCount, 2);

const cliStatus = getCodexStatus();
const desktopStatus = getCodexDesktopStatus();
assert.strictEqual(cliStatus.baseUrl, 'https://localhost:3445/v1');
assert.strictEqual(cliStatus.openaiBaseUrl, 'https://localhost:3445/v1');
assert.strictEqual(cliStatus.legacyBaseUrl, '');
assert.strictEqual(cliStatus.managedModelCatalog, true);
assert.strictEqual(cliStatus.modelCatalog.exists, true);
assert.strictEqual(cliStatus.modelCatalog.routeCount, 2);
assert.strictEqual(desktopStatus.surface, 'desktop');
assert.strictEqual(desktopStatus.sharedConfig, true);
assert.strictEqual(desktopStatus.requiresRestart, true);
assert.strictEqual(desktopStatus.authMode, 'chatgpt');
assert.strictEqual(desktopStatus.hasManagedApiKey, false);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), chatGptAuth);

const configPath = path.join(tempHome, '.codex', 'config.toml');
const content = fs.readFileSync(configPath, 'utf8');
assert.match(content, /^openai_base_url = "https:\/\/localhost:3445\/v1"$/m);
assert.match(content, /^model_catalog_json = ".+hpm-model-catalog\.json"$/m);
assert.doesNotMatch(content, /^base_url\s*=/m);
assert.doesNotMatch(content, /^model_provider\s*=/m);

const catalogPath = getCodexModelCatalogPath();
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
assert.deepStrictEqual(catalog.models.map((model) => model.slug), ['codex/deepseek-v4-flash', 'gpt-5.5']);
assert.strictEqual(catalog.models[0].display_name, 'DeepSeek V4 Flash');
assert.strictEqual(catalog.models[1].display_name, 'GPT-5.5 Routed');

const proxyApiResult = switchCodexMode({
  connection: 'proxy',
  auth: 'api',
  modelRoutes: [
    { from: 'codex/deepseek-v4-flash', profileId: 'deepseek', to: 'deepseek-v4-flash', labelOverride: 'DeepSeek V4 Flash' },
  ],
});
assert.strictEqual(proxyApiResult.connectionMode, 'proxy');
assert.strictEqual(proxyApiResult.authMode, 'api');
assert.strictEqual(proxyApiResult.auth.authMode, 'api');
assert.strictEqual(proxyApiResult.auth.hasProxyManagedApiKey, true);
assert.strictEqual(proxyApiResult.auth.chatGptBackupExists, true);
assert.strictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY, 'sk-proxy-managed');
assert.throws(() => switchCodexMode({ connection: 'direct', auth: 'api' }), /真实 OpenAI API Key/);

fs.rmSync(path.join(tempHome, '.codex', 'auth.chatgpt.backup.json'), { force: true });
const directOfficialWithoutBackup = switchCodexMode({ connection: 'direct', auth: 'chatgpt' });
assert.strictEqual(directOfficialWithoutBackup.connectionMode, 'direct');
assert.strictEqual(directOfficialWithoutBackup.partial, true);
assert.match(directOfficialWithoutBackup.authWarning, /未找到 Codex 官方登录备份/);
assert.strictEqual(getCodexStatus().baseUrl, '');

fs.writeFileSync(authPath, JSON.stringify(chatGptAuth, null, 2), 'utf8');
const proxyOfficialResult = switchCodexMode({
  connection: 'proxy',
  auth: 'chatgpt',
  modelRoutes: [
    { from: 'codex/deepseek-v4-flash', profileId: 'deepseek', to: 'deepseek-v4-flash' },
  ],
});
assert.strictEqual(proxyOfficialResult.auth.authMode, 'chatgpt');
assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), chatGptAuth);

restoreCodexProxy();
const restored = fs.readFileSync(configPath, 'utf8');
assert.doesNotMatch(restored, /^openai_base_url\s*=/m);
assert.doesNotMatch(restored, /^model_catalog_json\s*=/m);
assert.strictEqual(fs.existsSync(catalogPath), false);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), chatGptAuth);

fs.writeFileSync(authPath, JSON.stringify({
  tokens: chatGptAuth.tokens,
  OPENAI_API_KEY: 'PROXY_MANAGED',
}, null, 2), 'utf8');
const cleanupResult = restoreCodexProxy();
assert.strictEqual(cleanupResult.legacyManagedApiKeyRemoved, true);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), chatGptAuth);

fs.writeFileSync(authPath, JSON.stringify({
  auth_mode: 'apikey',
  OPENAI_API_KEY: 'sk-user-owned',
}, null, 2), 'utf8');
const userApiKeyCleanupResult = restoreCodexProxy();
assert.strictEqual(userApiKeyCleanupResult.legacyManagedApiKeyRemoved, false);
assert.strictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY, 'sk-user-owned');
assert.strictEqual(readCodexAuthStatus().authMode, 'api');
const directApiResult = switchCodexMode({ connection: 'direct', auth: 'api' });
assert.strictEqual(directApiResult.connectionMode, 'direct');
assert.strictEqual(directApiResult.auth.authMode, 'api');
assert.strictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY, 'sk-user-owned');

fs.writeFileSync(authPath, JSON.stringify({
  auth_mode: 'apikey',
  tokens: chatGptAuth.tokens,
  OPENAI_API_KEY: 'sk-user-owned',
}, null, 2), 'utf8');
const explicitApiStatus = readCodexAuthStatus();
assert.strictEqual(explicitApiStatus.rawAuthMode, 'apikey');
assert.strictEqual(explicitApiStatus.authMode, 'api');
assert.strictEqual(explicitApiStatus.authConflict, true);

fs.rmSync(tempHome, { recursive: true, force: true });
console.log('[tool-configs.test] ok');
