'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const {
  inspectTianxiCredentialExpiry,
  isPlaintextServiceAccountToken,
} = require('./tianxi-agentcore-local');

const DEFAULT_REFRESH_ATTEMPTS = 20;
const DEFAULT_REFRESH_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIANXI_SMART_UI_EXE_PATH = 'C:\\Program Files\\Lenovo\\AIAgent\\XLSmartUI.exe';
const DEFAULT_NATIVE_REFRESH_COOLDOWN_MS = 20000;
const recentNativeRefreshes = new Map();

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

function getFreshAgentCoreHeader(readHeader, userId, context = {}, previousToken = '') {
  if (typeof readHeader !== 'function') return null;
  try {
    const header = readHeader();
    if (!header || typeof header !== 'object' || header.user_id !== userId) return null;
    const token = getFreshQoderToken({
      credentials: header.credentials,
      credentialExpiry: inspectTianxiCredentialExpiry(header.credentials, { now: context.now }),
    });
    if (!token || (previousToken && token === previousToken)) return null;
    return { header, token };
  } catch (_err) {
    return null;
  }
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
  const source = nativeRefreshSource(options.source);
  const content =
    typeof options.content === 'string' && options.content.trim()
      ? options.content.trim()
      : '只回答OK';
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
  }).replace(/\s/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function nativeRefreshSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(source) ? source : 'Codex';
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
  const source = nativeRefreshSource(options.source);
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const cooldownMs = toPositiveInteger(options.cooldownMs, DEFAULT_NATIVE_REFRESH_COOLDOWN_MS);
  const refreshKey = `${exePath}\0${source}\0${options.userId || ''}`;
  for (const [key, startedAt] of recentNativeRefreshes) {
    if (nowMs < startedAt || nowMs - startedAt >= cooldownMs) {
      recentNativeRefreshes.delete(key);
    }
  }
  if (recentNativeRefreshes.has(refreshKey)) {
    return { attempted: true, status: 'already_started', source: 'native-ui' };
  }
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
      windowsVerbatimArguments: true,
    }
  );
  recentNativeRefreshes.set(refreshKey, nowMs);
  if (child && typeof child.on === 'function') {
    child.on('error', () => recentNativeRefreshes.delete(refreshKey));
  }
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
  const initialToken = token;
  const initialQoderExpiry = cache?.credentialExpiry?.qoder_token?.expiresAtMs;
  const initialHeader =
    options.force === true
      ? null
      : getFreshAgentCoreHeader(options.readHeader, options.userId, context);
  if (initialHeader) {
    return {
      attempted: false,
      status: 'fresh_agentcore',
      source: 'agentcore',
      ...initialHeader,
      cache,
    };
  }
  if (token && options.force !== true) {
    return { attempted: false, status: 'fresh_cache', source: 'registry', token, cache };
  }
  if (typeof options.programmaticRefresh === 'function') {
    return options.programmaticRefresh(options, context);
  }
  if (
    hasFreshEncryptedQoderCache(cache) &&
    options.force !== true &&
    typeof options.readHeader !== 'function'
  ) {
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
    const freshHeader = getFreshAgentCoreHeader(
      options.readHeader,
      options.userId,
      context,
      options.force === true ? options.previousToken : ''
    );
    if (freshHeader) {
      return {
        attempted: true,
        status: 'refreshed_agentcore',
        source: 'agentcore',
        ...freshHeader,
        cache,
      };
    }
    if (typeof options.readHeader === 'function' && attempt % 4 !== 3 && attempt !== attempts - 1) {
      continue;
    }
    cache = read();
    token = getFreshQoderToken(cache);
    if (token && (options.force !== true || token !== initialToken)) {
      return { attempted: true, status: 'refreshed', source: 'native', token, cache };
    }
    if (
      hasFreshEncryptedQoderCache(cache) &&
      typeof options.readHeader !== 'function' &&
      (options.force !== true ||
        (initialQoderExpiry != null &&
          cache.credentialExpiry.qoder_token.expiresAtMs > initialQoderExpiry))
    ) {
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
