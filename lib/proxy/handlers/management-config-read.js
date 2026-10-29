'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { CONFIG_FILE, loadConfig } = require('../config');

function redactConfigSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactConfigSecrets);
  const cloned = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(apiKey|directApiKey|key|token|secret|authorization|password|refreshToken|accessToken|idToken)$/i.test(
        key
      )
    ) {
      cloned[key] = child ? '[redacted]' : child;
    } else {
      cloned[key] = redactConfigSecrets(child);
    }
  }
  return cloned;
}

function configRevisionFromText(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || ''), 'utf8')
    .digest('hex');
}

function readRawConfigFile(configFile) {
  if (!fs.existsSync(configFile)) {
    return { config: {}, revision: 'missing', text: '' };
  }
  const text = fs.readFileSync(configFile, 'utf8');
  return {
    config: JSON.parse(text),
    revision: configRevisionFromText(text),
    text,
  };
}

function createManagementConfigReadHandler({
  sendJson,
  configFile = CONFIG_FILE,
  loadConfigFn = loadConfig,
} = {}) {
  if (typeof sendJson !== 'function') throw new Error('sendJson is required');
  if (typeof loadConfigFn !== 'function') throw new TypeError('loadConfigFn is required');
  return function handleLocalGetConfigRequest(clientReq, clientRes) {
    try {
      const rawConfig = loadConfigFn();
      const cloned = redactConfigSecrets(JSON.parse(JSON.stringify(rawConfig)));
      cloned._revision = readRawConfigFile(configFile).revision;
      sendJson(clientRes, 200, cloned);
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  };
}

module.exports = {
  createManagementConfigReadHandler,
  redactConfigSecrets,
  configRevisionFromText,
  readRawConfigFile,
};
