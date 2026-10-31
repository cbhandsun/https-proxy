'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonFileAtomically } = require('./management-utils');

const DEFAULT_HTTP_BASE_URL = 'http://localhost:3085/v1';
const MANAGED_API_KEY = 'sk-proxy-managed';

function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getOpenCodeConfigPath() {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return path.join(process.env.OPENCODE_CONFIG_DIR, 'opencode.json');
  }
  return path.join(getHomeDir(), '.config', 'opencode', 'opencode.json');
}

function getAiderConfigPath() {
  return path.join(getHomeDir(), '.aider.conf.yml');
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function getOpenCodeStatus() {
  const configPath = getOpenCodeConfigPath();
  const data = readJsonSafe(configPath);
  const provider =
    data.provider && typeof data.provider === 'object' && data.provider.hpm
      ? data.provider.hpm
      : null;
  const baseUrl =
    provider && provider.options && typeof provider.options.baseURL === 'string'
      ? provider.options.baseURL
      : '';
  const rawModel = typeof data.model === 'string' ? data.model.trim() : '';
  const model = rawModel.startsWith('hpm/') ? rawModel.slice(4) : rawModel;
  return {
    configPath,
    baseUrl,
    model,
    managed: Boolean(provider && baseUrl),
  };
}

function applyOpenCodeProxy(options = {}) {
  const configPath = getOpenCodeConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = readJsonSafe(configPath);
  if (!data.$schema) {
    data.$schema = 'https://opencode.ai/config.json';
  }
  if (!data.provider || typeof data.provider !== 'object' || Array.isArray(data.provider)) {
    data.provider = {};
  }
  const existingHpm =
    data.provider.hpm && typeof data.provider.hpm === 'object' ? data.provider.hpm : {};
  const existingModels =
    existingHpm.models && typeof existingHpm.models === 'object' ? { ...existingHpm.models } : {};
  const modelName = options && typeof options.model === 'string' ? options.model.trim() : '';
  if (modelName) {
    existingModels[modelName] = {
      name: `${modelName} (HPM)`,
    };
    data.model = `hpm/${modelName}`;
  }
  const baseUrl =
    options && typeof options.baseUrl === 'string' && options.baseUrl.trim()
      ? options.baseUrl.trim()
      : DEFAULT_HTTP_BASE_URL;
  data.provider.hpm = {
    ...existingHpm,
    npm: '@ai-sdk/openai-compatible',
    name: 'HTTPS Proxy Manager',
    options: {
      ...(existingHpm.options && typeof existingHpm.options === 'object'
        ? existingHpm.options
        : {}),
      baseURL: baseUrl,
      apiKey: MANAGED_API_KEY,
    },
    models: existingModels,
  };
  writeJsonFileAtomically(configPath, data, 2);
  return getOpenCodeStatus();
}

function restoreOpenCodeProxy() {
  const configPath = getOpenCodeConfigPath();
  if (!fs.existsSync(configPath)) return getOpenCodeStatus();
  const data = readJsonSafe(configPath);
  if (data.provider && typeof data.provider === 'object') {
    delete data.provider.hpm;
    if (Object.keys(data.provider).length === 0) {
      delete data.provider;
    }
  }
  if (typeof data.model === 'string' && data.model.startsWith('hpm/')) {
    delete data.model;
  }
  writeJsonFileAtomically(configPath, data, 2);
  return getOpenCodeStatus();
}

function readYamlScalar(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`^${escaped}\\s*:\\s*(.+)$`, 'm'));
  if (!match) return '';
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function setYamlScalar(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = `${key}: "${String(value).replace(/"/g, '\\"')}"`;
  const regex = new RegExp(`^${escaped}\\s*:.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, line);
  }
  const prefix = content && !content.endsWith('\n') ? `${content}\n` : content || '';
  return `${prefix}${line}\n`;
}

function deleteYamlScalar(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(content || '').replace(new RegExp(`^${escaped}\\s*:.*(?:\\r?\\n)?`, 'gm'), '');
}

function getAiderStatus() {
  const configPath = getAiderConfigPath();
  let content = '';
  try {
    if (fs.existsSync(configPath)) {
      content = fs.readFileSync(configPath, 'utf8');
    }
  } catch (_err) {}
  const baseUrl = readYamlScalar(content, 'openai-api-base');
  const rawModel = readYamlScalar(content, 'model');
  const model = rawModel.startsWith('openai/') ? rawModel.slice(7) : rawModel;
  const rawWeak = readYamlScalar(content, 'weak-model');
  const fastModel = rawWeak.startsWith('openai/') ? rawWeak.slice(7) : rawWeak;
  return {
    configPath,
    baseUrl,
    model,
    fastModel,
    managed: Boolean(baseUrl && baseUrl.includes('localhost')),
  };
}

function applyAiderProxy(options = {}) {
  const configPath = getAiderConfigPath();
  let content = '';
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf8');
  }
  const baseUrl =
    options && typeof options.baseUrl === 'string' && options.baseUrl.trim()
      ? options.baseUrl.trim()
      : DEFAULT_HTTP_BASE_URL;
  content = setYamlScalar(content, 'openai-api-base', baseUrl);
  content = setYamlScalar(content, 'openai-api-key', MANAGED_API_KEY);
  if (options && typeof options.model === 'string' && options.model.trim()) {
    const rawModel = options.model.trim();
    const formatted = rawModel.includes('/') ? rawModel : `openai/${rawModel}`;
    content = setYamlScalar(content, 'model', formatted);
  }
  fs.writeFileSync(configPath, content, 'utf8');
  return getAiderStatus();
}

function restoreAiderProxy() {
  const configPath = getAiderConfigPath();
  if (!fs.existsSync(configPath)) return getAiderStatus();
  let content = fs.readFileSync(configPath, 'utf8');
  content = deleteYamlScalar(content, 'openai-api-base');
  if (readYamlScalar(content, 'openai-api-key') === MANAGED_API_KEY) {
    content = deleteYamlScalar(content, 'openai-api-key');
  }
  fs.writeFileSync(configPath, content, 'utf8');
  return getAiderStatus();
}

module.exports = {
  getOpenCodeConfigPath,
  getOpenCodeStatus,
  applyOpenCodeProxy,
  restoreOpenCodeProxy,
  getAiderConfigPath,
  getAiderStatus,
  applyAiderProxy,
  restoreAiderProxy,
};
