const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCAL_PROXY_URL = 'https://localhost:3443';
const CODEX_PROXY_URL = 'https://localhost:3447';
const PROXY_MANAGED_TOKEN = 'PROXY_MANAGED';

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
  const newLine = `${key} = "${value}"`;
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

function getCodexStatus() {
  const tomlPath = getCodexConfigPath();
  const authPath = getCodexAuthPath();
  const tomlExists = fs.existsSync(tomlPath);
  const authExists = fs.existsSync(authPath);
  let modelProvider = '';
  let baseUrl = '';
  let hasApiKey = false;

  if (tomlExists) {
    try {
      const content = fs.readFileSync(tomlPath, 'utf8');
      const providerMatch = content.match(/^\s*model_provider\s*=\s*["']([^"']+)["']/m);
      const urlMatch = content.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m);
      if (providerMatch) modelProvider = providerMatch[1];
      if (urlMatch) baseUrl = urlMatch[1];
    } catch (err) {}
  }

  if (authExists) {
    const content = readJsonFile(authPath);
    hasApiKey = content && content.OPENAI_API_KEY === PROXY_MANAGED_TOKEN;
  }

  return {
    exists: tomlExists || authExists,
    modelProvider,
    baseUrl,
    hasApiKey,
    configPath: tomlPath,
    authPath
  };
}

function applyCodexProxy() {
  const tomlPath = getCodexConfigPath();
  const authPath = getCodexAuthPath();
  const tomlDir = path.dirname(tomlPath);
  if (!fs.existsSync(tomlDir)) {
    fs.mkdirSync(tomlDir, { recursive: true });
  }

  let tomlContent = '';
  if (fs.existsSync(tomlPath)) {
    tomlContent = fs.readFileSync(tomlPath, 'utf8');
  }
  tomlContent = setTomlValue(tomlContent, 'model_provider', 'custom');
  tomlContent = setTomlValue(tomlContent, 'base_url', CODEX_PROXY_URL);
  fs.writeFileSync(tomlPath, tomlContent, 'utf8');

  const authObj = readJsonFile(authPath);
  authObj.OPENAI_API_KEY = PROXY_MANAGED_TOKEN;
  writeJsonFile(authPath, authObj);
}

function restoreCodexProxy() {
  const tomlPath = getCodexConfigPath();
  const authPath = getCodexAuthPath();

  if (fs.existsSync(tomlPath)) {
    let tomlContent = fs.readFileSync(tomlPath, 'utf8');
    tomlContent = deleteTomlValue(tomlContent, 'model_provider');
    tomlContent = deleteTomlValue(tomlContent, 'base_url');
    fs.writeFileSync(tomlPath, tomlContent, 'utf8');
  }

  if (fs.existsSync(authPath)) {
    const authObj = readJsonFile(authPath);
    authObj.OPENAI_API_KEY = null;
    writeJsonFile(authPath, authObj);
  }
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
  getGeminiSettingsPath,
  getGeminiEnvPath,
  setTomlValue,
  deleteTomlValue,
  setEnvValue,
  deleteEnvValue,
  getAntigravityCliStatus,
  applyAntigravityCliProxy,
  restoreAntigravityCliProxy,
  getClaudeCodeStatus,
  applyClaudeCodeProxy,
  restoreClaudeCodeProxy,
  getCodexStatus,
  applyCodexProxy,
  restoreCodexProxy,
  getGeminiCliStatus,
  applyGeminiCliProxy,
  restoreGeminiCliProxy
};
