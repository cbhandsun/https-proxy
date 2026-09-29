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
fs.writeFileSync(
  path.join(tempHome, '.codex', 'models_cache.json'),
  JSON.stringify(
    {
      models: [
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          description: 'Template model',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
          shell_type: 'shell_command',
          visibility: 'list',
          supported_in_api: true,
          priority: 0,
          model_messages: { persistent_instructions: 'You are Codex.' },
        },
      ],
    },
    null,
    2
  ),
  'utf8'
);

const {
  applyCodexProxy,
  applyAntigravityCliProxy,
  applyClaudeCodeProxy,
  applyGeminiCliProxy,
  CA_CERT_FILE,
  getCodexDesktopStatus,
  readCodexAuthStatus,
  getAntigravityCliConfigPath,
  getClaudeCodeConfigPath,
  getCodexModelCatalogPath,
  getCodexStatus,
  getGeminiEnvPath,
  restoreCodexProxy,
  restoreAntigravityCliProxy,
  restoreClaudeCodeProxy,
  restoreGeminiCliProxy,
  applyCodexApiLogin,
  backupCurrentCodexAuth,
  buildCodexOfficialLoginLaunchArgs,
  deleteEnvValue,
  deleteTomlValue,
  deleteTomlSection,
  setEnvValue,
  setTomlValue,
  stripOrphanedManagedProviderLines,
  switchCodexMode,
} = require('../lib/proxy/tool-configs');

const toml = 'theme = "dark"\nbase_url = "https://old.example"\n';
const updatedToml = setTomlValue(toml, 'base_url', 'https://localhost:3447');
assert.strictEqual(updatedToml, 'theme = "dark"\nbase_url = "https://localhost:3447"\n');
assert.strictEqual(setTomlValue('', 'model_provider', 'custom'), '\nmodel_provider = "custom"\n');
assert.strictEqual(deleteTomlValue(updatedToml, 'base_url'), 'theme = "dark"\n');

// Regression: deleteTomlSection must remove the whole table, not just the
// header. The previous regex anchor stopped after the header at line ends and
// stranded the body inside the preceding table, which made Codex report the
// provider keys as unrecognized settings.
const sectionSource = [
  '[features]',
  'memories = true',
  '',
  '[memories]',
  'generate_memories = true',
  '',
  '[model_providers.custom]',
  'name = "HTTPS Proxy"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'base_url = "http://localhost:3085/v1"',
  '',
  '[desktop]',
  'appearanceTheme = "dark"',
  '',
].join('\n');
const sectionRemoved = deleteTomlSection(sectionSource, 'model_providers.custom');
assert.ok(!sectionRemoved.includes('[model_providers.custom]'));
assert.ok(!sectionRemoved.includes('requires_openai_auth = true'));
assert.ok(!sectionRemoved.includes('http://localhost:3085/v1'));
assert.match(sectionRemoved, /^\[memories\]$/m);
assert.match(sectionRemoved, /^generate_memories = true$/m);
assert.match(sectionRemoved, /^\[desktop\]$/m);
assert.match(sectionRemoved, /^appearanceTheme = "dark"$/m);

// The middle-of-file case used to leave the provider body behind as well.
const sectionRemovedMid = deleteTomlSection(sectionSource, 'memories');
assert.ok(!sectionRemovedMid.includes('generate_memories = true'));
assert.match(sectionRemovedMid, /^\[model_providers\.custom\]$/m);
assert.match(sectionRemovedMid, /^requires_openai_auth = true$/m);

// Unknown tables must be left byte-identical.
assert.strictEqual(deleteTomlSection(sectionSource, 'no.such.section'), sectionSource);

// A config damaged by the old bug is healed: the stranded provider lines are
// dropped while unrelated tables stay intact.
const damaged = [
  '[memories]',
  'generate_memories = true',
  '',
  'name = "HTTPS Proxy"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'base_url = "http://localhost:3085/v1"',
  '[model_providers.custom]',
  'name = "HTTPS Proxy"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'base_url = "http://localhost:3085/v1"',
  '',
].join('\n');
const healed = stripOrphanedManagedProviderLines(damaged);
assert.match(healed, /^generate_memories = true$/m);
const healedProviderSection = healed.slice(healed.indexOf('[model_providers.custom]'));
assert.strictEqual((healedProviderSection.match(/^name = "HTTPS Proxy"$/gm) || []).length, 1);
assert.strictEqual(
  (healedProviderSection.match(/^requires_openai_auth = true$/gm) || []).length,
  1
);
assert.ok(!/^name = "HTTPS Proxy"\nwire_api/m.test(healed.split('[model_providers.custom]')[0]));

// User-authored providers and lookalike values must never be stripped.
const foreignProvider = [
  '[model_providers.mine]',
  'name = "My Own Provider"',
  'wire_api = "responses"',
  'base_url = "https://api.example.com"',
  '',
].join('\n');
assert.strictEqual(stripOrphanedManagedProviderLines(foreignProvider), foreignProvider);
assert.strictEqual(stripOrphanedManagedProviderLines(''), '');

// A short scattered run (fewer than three managed lines) is not treated as an
// orphaned provider block, which keeps the heal conservative.
const scattered = [
  '[features]',
  'memories = true',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  '',
].join('\n');
assert.strictEqual(stripOrphanedManagedProviderLines(scattered), scattered);

const env = 'KEEP=yes\nGOOGLE_GEMINI_BASE_URL=https://old.example\n';
const updatedEnv = setEnvValue(env, 'GOOGLE_GEMINI_BASE_URL', 'https://localhost:3443');
assert.strictEqual(updatedEnv, 'KEEP=yes\nGOOGLE_GEMINI_BASE_URL=https://localhost:3443\n');
assert.strictEqual(
  setEnvValue('', 'ANTHROPIC_BASE_URL', 'https://localhost:3443'),
  '\nANTHROPIC_BASE_URL=https://localhost:3443\n'
);
assert.strictEqual(deleteEnvValue(updatedEnv, 'GOOGLE_GEMINI_BASE_URL'), 'KEEP=yes\n');

applyClaudeCodeProxy();
const claudeCodeConfig = JSON.parse(fs.readFileSync(getClaudeCodeConfigPath(), 'utf8'));
assert.strictEqual(claudeCodeConfig.env.ANTHROPIC_BASE_URL, 'https://localhost:3443');
assert.strictEqual(claudeCodeConfig.env.NODE_EXTRA_CA_CERTS, CA_CERT_FILE);
restoreClaudeCodeProxy();
const restoredClaudeCodeConfig = JSON.parse(fs.readFileSync(getClaudeCodeConfigPath(), 'utf8'));
assert.strictEqual(restoredClaudeCodeConfig.env.NODE_EXTRA_CA_CERTS, undefined);

applyAntigravityCliProxy();
const antigravityConfig = JSON.parse(fs.readFileSync(getAntigravityCliConfigPath(), 'utf8'));
assert.strictEqual(antigravityConfig.env.ANTIGRAVITY_BASE_URL, 'https://localhost:3443');
assert.strictEqual(antigravityConfig.env.NODE_EXTRA_CA_CERTS, CA_CERT_FILE);
restoreAntigravityCliProxy();
const restoredAntigravityConfig = JSON.parse(
  fs.readFileSync(getAntigravityCliConfigPath(), 'utf8')
);
assert.strictEqual(restoredAntigravityConfig.env.NODE_EXTRA_CA_CERTS, undefined);

applyGeminiCliProxy();
const geminiEnv = fs.readFileSync(getGeminiEnvPath(), 'utf8');
assert.match(geminiEnv, /^GOOGLE_GEMINI_BASE_URL=https:\/\/localhost:3443$/m);
assert.match(
  geminiEnv,
  new RegExp(
    '^NODE_EXTRA_CA_CERTS=' + CA_CERT_FILE.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '$',
    'm'
  )
);
restoreGeminiCliProxy();
assert.doesNotMatch(fs.readFileSync(getGeminiEnvPath(), 'utf8'), /^NODE_EXTRA_CA_CERTS=/m);

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
assert.strictEqual(
  JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY,
  'sk-proxy-managed'
);
fs.writeFileSync(authPath, JSON.stringify(chatGptAuth, null, 2), 'utf8');

const officialLoginArgs = buildCodexOfficialLoginLaunchArgs();
assert.deepStrictEqual(officialLoginArgs.slice(0, 4), [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
]);
assert.match(officialLoginArgs[4], /Start-Process -FilePath /);
assert.match(officialLoginArgs[4], /hpm-codex-official-login\.vbs/);
assert.ok(!officialLoginArgs.includes('/c'));
assert.ok(!officialLoginArgs.includes('start'));
assert.ok(!officialLoginArgs.includes('Official'));

const applyResult = applyCodexProxy({
  modelRoutes: [
    {
      from: 'codex/deepseek-v4-flash',
      profileId: 'deepseek',
      to: 'deepseek-v4-flash',
      labelOverride: 'DeepSeek V4 Flash',
    },
    {
      from: 'gpt-5.5',
      profileId: 'openai-official',
      to: 'gpt-5.5',
      labelOverride: 'GPT-5.5 Routed',
    },
  ],
});
assert.strictEqual(applyResult.modelCatalog.routeCount, 2);

const cliStatus = getCodexStatus();
const desktopStatus = getCodexDesktopStatus();
assert.strictEqual(cliStatus.baseUrl, 'http://localhost:3085/v1');
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
assert.match(content, /^model_provider = "custom"$/m);
assert.match(content, /^model = "codex\/deepseek-v4-flash"$/m);
assert.match(content, /^model_reasoning_effort = "medium"$/m);
assert.match(content, /^\[model_providers\.custom\]/m);
assert.match(content, /wire_api = "responses"/);
assert.match(content, /base_url = "http:\/\/localhost:3085\/v1"/);
assert.match(content, /^openai_base_url = "https:\/\/localhost:3445\/v1"$/m);
assert.match(content, /^model_catalog_json = ".+hpm-model-catalog\.json"$/m);
const topLevel = content.split(/^\[/m)[0] || '';
assert.doesNotMatch(topLevel, /^base_url\s*=/m);

const catalogPath = getCodexModelCatalogPath();
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
assert.deepStrictEqual(
  catalog.models.map((model) => model.slug),
  ['codex/deepseek-v4-flash', 'gpt-5.5']
);
assert.strictEqual(catalog.models[0].display_name, 'DeepSeek V4 Flash');
assert.strictEqual(catalog.models[1].display_name, 'GPT-5.5 Routed');
assert.strictEqual(catalog.models[0].supported_reasoning_levels.length, 4);
assert.strictEqual(catalog.models[0].default_reasoning_level, 'medium');

const proxyApiResult = switchCodexMode({
  connection: 'proxy',
  auth: 'api',
  modelRoutes: [
    {
      from: 'codex/deepseek-v4-flash',
      profileId: 'deepseek',
      to: 'deepseek-v4-flash',
      labelOverride: 'DeepSeek V4 Flash',
    },
  ],
});
assert.strictEqual(proxyApiResult.connectionMode, 'proxy');
assert.strictEqual(proxyApiResult.authMode, 'api');
assert.strictEqual(proxyApiResult.auth.authMode, 'api');
assert.strictEqual(proxyApiResult.auth.hasProxyManagedApiKey, true);
assert.strictEqual(proxyApiResult.auth.chatGptBackupExists, true);
assert.strictEqual(
  JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY,
  'sk-proxy-managed'
);
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

fs.writeFileSync(
  authPath,
  JSON.stringify(
    {
      tokens: chatGptAuth.tokens,
      OPENAI_API_KEY: 'PROXY_MANAGED',
    },
    null,
    2
  ),
  'utf8'
);
const cleanupResult = restoreCodexProxy();
assert.strictEqual(cleanupResult.legacyManagedApiKeyRemoved, true);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), chatGptAuth);

fs.writeFileSync(
  authPath,
  JSON.stringify(
    {
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-user-owned',
    },
    null,
    2
  ),
  'utf8'
);
const userApiKeyCleanupResult = restoreCodexProxy();
assert.strictEqual(userApiKeyCleanupResult.legacyManagedApiKeyRemoved, false);
assert.strictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY, 'sk-user-owned');
assert.strictEqual(readCodexAuthStatus().authMode, 'api');
const directApiResult = switchCodexMode({ connection: 'direct', auth: 'api' });
assert.strictEqual(directApiResult.connectionMode, 'direct');
assert.strictEqual(directApiResult.auth.authMode, 'api');
assert.strictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY, 'sk-user-owned');

fs.writeFileSync(
  authPath,
  JSON.stringify(
    {
      auth_mode: 'apikey',
      tokens: chatGptAuth.tokens,
      OPENAI_API_KEY: 'sk-user-owned',
    },
    null,
    2
  ),
  'utf8'
);
const explicitApiStatus = readCodexAuthStatus();
assert.strictEqual(explicitApiStatus.rawAuthMode, 'apikey');
assert.strictEqual(explicitApiStatus.authMode, 'api');
assert.strictEqual(explicitApiStatus.authConflict, true);

fs.rmSync(tempHome, { recursive: true, force: true });
console.log('[tool-configs.test] ok');
