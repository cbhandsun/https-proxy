'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const { isPlaintextServiceAccountToken } = require('./tianxi-agentcore-local');

const DEFAULT_REFRESH_ATTEMPTS = 4;
const DEFAULT_REFRESH_POLL_INTERVAL_MS = 750;
const DEFAULT_TIANXI_SMART_UI_EXE_PATH = 'C:\\Program Files\\Lenovo\\AIAgent\\XLSmartUI.exe';

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreshQoderToken(cache) {
  const credentialExpiry =
    cache && cache.credentialExpiry && typeof cache.credentialExpiry === 'object'
      ? cache.credentialExpiry
      : {};
  const qoderExpiry =
    credentialExpiry.qoder_token && typeof credentialExpiry.qoder_token === 'object'
      ? credentialExpiry.qoder_token
      : null;
  const token =
    cache &&
    cache.credentials &&
    typeof cache.credentials === 'object' &&
    typeof cache.credentials.qoder_token === 'string'
      ? cache.credentials.qoder_token.trim()
      : '';
  return token &&
    isPlaintextServiceAccountToken(token) &&
    qoderExpiry &&
    qoderExpiry.expired === false
    ? token
    : '';
}

function hasFreshEncryptedQoderCache(cache) {
  const credentialExpiry =
    cache && cache.credentialExpiry && typeof cache.credentialExpiry === 'object'
      ? cache.credentialExpiry
      : {};
  const qoderExpiry =
    credentialExpiry.qoder_token && typeof credentialExpiry.qoder_token === 'object'
      ? credentialExpiry.qoder_token
      : null;
  const hasPlaintext = Boolean(getFreshQoderToken(cache));
  return Boolean(
    !hasPlaintext && cache && cache.hasQoderToken && qoderExpiry && qoderExpiry.expired === false
  );
}

function sanitizeRefreshState(result) {
  const source = result && typeof result === 'object' ? result : {};
  return {
    attempted: Boolean(source.attempted),
    status: typeof source.status === 'string' ? source.status : '',
    source: typeof source.source === 'string' ? source.source : '',
    injected: Boolean(source.injected),
    errorCode: typeof source.errorCode === 'string' ? source.errorCode : '',
  };
}

function buildSetTokenHeader(header) {
  const source = header && typeof header === 'object' ? header : {};
  const result = {};
  for (const key of [
    'app_id',
    'app_version',
    'device_id',
    'device_type',
    'resource_id',
    'role',
    'request_id',
    'session_id',
    'tab_id',
    'user_id',
  ]) {
    const value = typeof source[key] === 'string' ? source[key].trim() : '';
    if (value) result[key] = value;
  }
  return result;
}

function buildTianxiSuperModeOpenTabMessage(options = {}) {
  const source =
    typeof options.source === 'string' && options.source.trim() ? options.source.trim() : 'Codex';
  const content =
    typeof options.content === 'string' && options.content.trim()
      ? options.content.trim()
      : 'refresh super mode';
  return JSON.stringify({
    type: 'OpenTab',
    source,
    data: {
      id: 'XT_SuperMode',
      data: JSON.stringify({
        handleType: 2,
        content,
        source,
        tabRouter: 'AIConversationIndex',
      }),
    },
  });
}

async function triggerTianxiSuperModeRefresh(options = {}) {
  if (process.platform !== 'win32' && !options.forceWindows) {
    return { attempted: false, status: 'unsupported_platform', source: 'native-ui' };
  }
  const exePath = options.exePath || DEFAULT_TIANXI_SMART_UI_EXE_PATH;
  const existsSync = options.existsSync || fs.existsSync;
  if (!existsSync(exePath)) {
    return { attempted: false, status: 'missing_executable', source: 'native-ui' };
  }
  const spawn = options.spawn || childProcess.spawn;
  const source =
    typeof options.source === 'string' && options.source.trim() ? options.source.trim() : 'Codex';
  const message = buildTianxiSuperModeOpenTabMessage({
    source,
    content: options.content,
  });
  const child = spawn(
    exePath,
    ['--xlcommunicationdata', `--xlsource=${source}`, `--xlmessage=${message}`],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  if (child && typeof child.unref === 'function') child.unref();
  return {
    attempted: true,
    status: 'started',
    source: 'native-ui',
    pid: child && Number.isSafeInteger(child.pid) ? child.pid : 0,
  };
}

async function injectTianxiServiceAccountToken(transport, token, context = {}, options = {}) {
  if (!transport || typeof transport.sendControlCommand !== 'function') {
    return { attempted: false, status: 'unsupported', source: 'tac-server' };
  }
  if (typeof token !== 'string' || !token.trim()) {
    return { attempted: false, status: 'missing_token', source: 'tac-server' };
  }
  try {
    const header = buildSetTokenHeader(options.header);
    await transport.sendControlCommand(
      {
        type: 'set_token',
        ...(Object.keys(header).length > 0 ? { header } : {}),
        token: token.trim(),
      },
      context
    );
    return { attempted: true, status: 'ok', source: 'tac-server', injected: true };
  } catch (_err) {
    return {
      attempted: true,
      status: 'failed',
      source: 'tac-server',
      errorCode: 'tianxi_set_token_failed',
    };
  }
}

async function refreshTianxiQoderToken(options = {}, context = {}) {
  const readCache = options.readCache;
  if (typeof readCache !== 'function') {
    return { attempted: false, status: 'unsupported', source: 'registry' };
  }
  const attempts = toPositiveInteger(options.attempts, DEFAULT_REFRESH_ATTEMPTS);
  const pollIntervalMs = toPositiveInteger(
    options.pollIntervalMs,
    DEFAULT_REFRESH_POLL_INTERVAL_MS
  );
  const read = () => readCache({ userId: options.userId, now: context.now });

  let cache = read();
  let token = getFreshQoderToken(cache);
  if (token && options.force !== true) {
    return { attempted: false, status: 'fresh_cache', source: 'registry', token, cache };
  }
  if (hasFreshEncryptedQoderCache(cache) && options.force !== true) {
    return { attempted: false, status: 'fresh_encrypted_cache', source: 'registry', cache };
  }

  if (typeof options.triggerNativeRefresh !== 'function') {
    return { attempted: false, status: 'no_native_refresh', source: 'registry', cache };
  }

  try {
    await options.triggerNativeRefresh({ userId: options.userId, now: context.now });
  } catch (_err) {
    return {
      attempted: true,
      status: 'native_refresh_failed',
      source: 'native',
      errorCode: 'tianxi_native_refresh_failed',
      cache,
    };
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await (options.sleep || sleep)(pollIntervalMs);
    cache = read();
    token = getFreshQoderToken(cache);
    if (token) {
      return { attempted: true, status: 'refreshed', source: 'native', token, cache };
    }
    if (hasFreshEncryptedQoderCache(cache)) {
      return {
        attempted: true,
        status: 'refreshed_encrypted_cache',
        source: 'native',
        cache,
      };
    }
  }
  return { attempted: true, status: 'refresh_no_fresh_token', source: 'native', cache };
}

module.exports = {
  DEFAULT_REFRESH_ATTEMPTS,
  DEFAULT_REFRESH_POLL_INTERVAL_MS,
  DEFAULT_TIANXI_SMART_UI_EXE_PATH,
  buildSetTokenHeader,
  buildTianxiSuperModeOpenTabMessage,
  getFreshQoderToken,
  hasFreshEncryptedQoderCache,
  injectTianxiServiceAccountToken,
  refreshTianxiQoderToken,
  sanitizeRefreshState,
  triggerTianxiSuperModeRefresh,
};
