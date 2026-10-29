const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const {
  ensurePrivateFileSync,
  renamePrivateFileSync,
  renamePrivateFileAsync,
} = require('./secure-files');

const safeLog = createLogger('management-utils');
const DEFAULT_JSON_BODY_LIMIT = 1024 * 1024;
const MAX_JSON_BODY_LIMIT = 4 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;

const LOCAL_POLL_ENDPOINTS = new Set([
  '/v1/local/health',
  '/local/health',
  '/v1/local/config',
  '/local/config',
  '/v1/local/cert',
  '/local/cert',
  '/v1/local/events',
  '/local/events',
  '/v1/local/log',
  '/local/log',
  '/v1/local/audit/conversations',
  '/local/audit/conversations',
  '/v1/local/usage/report',
  '/local/usage/report',
  '/v1/local/diagnostics',
  '/local/diagnostics',
  '/v1/local/cli/sessions',
  '/local/cli/sessions',
  '/v1/local/env/install-jobs',
  '/local/env/install-jobs',
]);

function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    return 'missing';
  }
}

function parseBoundedInteger(value, defaultValue, min, max) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
  const fallback = Number.isFinite(defaultValue) ? Math.trunc(defaultValue) : min;
  const integer = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function parsePortOrDefault(value, defaultPort) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
  if (Number.isFinite(parsed)) {
    const integer = Math.trunc(parsed);
    if (integer >= 1 && integer <= 65535) return integer;
  }
  const fallback =
    typeof defaultPort === 'number'
      ? defaultPort
      : Number.parseInt(String(defaultPort == null ? '' : defaultPort), 10);
  if (Number.isFinite(fallback)) {
    const integer = Math.trunc(fallback);
    if (integer >= 1 && integer <= 65535) return integer;
  }
  return 80;
}

function readJsonBodyFromRequest(clientReq, callback, options = {}) {
  const maxBytes = parseBoundedInteger(
    options.maxBytes,
    DEFAULT_JSON_BODY_LIMIT,
    1,
    MAX_JSON_BODY_LIMIT
  );
  const chunks = [];
  let bytes = 0;
  let finished = false;
  const finish = (err, payload) => {
    if (finished) return;
    finished = true;
    callback(err, payload);
  };

  clientReq.on('data', (chunk) => {
    if (finished) return;
    bytes += chunk.length;
    if (bytes > maxBytes) {
      chunks.length = 0;
      finish(new Error(`Request body too large; max ${maxBytes} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  clientReq.on('end', () => {
    if (finished) return;
    try {
      const text = Buffer.concat(chunks, bytes).toString('utf8');
      finish(null, text ? JSON.parse(text) : {});
    } catch (err) {
      finish(err);
    }
  });
  clientReq.on('error', (err) => finish(err));
}

function readTextBodyFromResponse(res, callback, options = {}) {
  const maxBytes = parseBoundedInteger(
    options.maxBytes,
    DEFAULT_JSON_BODY_LIMIT,
    1,
    MAX_JSON_BODY_LIMIT
  );
  const chunks = [];
  let bytes = 0;
  let finished = false;
  const finish = (err, text) => {
    if (finished) return;
    finished = true;
    callback(err, text || '');
  };

  res.on('data', (chunk) => {
    if (finished) return;
    bytes += chunk.length;
    if (bytes > maxBytes) {
      chunks.length = 0;
      finish(new Error(`Response body too large; max ${maxBytes} bytes`));
      if (typeof res.destroy === 'function') res.destroy();
      return;
    }
    chunks.push(chunk);
  });
  res.on('end', () => {
    if (finished) return;
    finish(null, Buffer.concat(chunks, bytes).toString('utf8'));
  });
  res.on('error', (err) => finish(err));
}

function readLastLinesOfJsonl(filePath, maxLines = 50, maxBytes = 128 * 1024) {
  if (!fs.existsSync(filePath)) return [];
  const safeMaxLines = parseBoundedInteger(maxLines, 50, 1, 5000);
  const safeMaxBytes = parseBoundedInteger(maxBytes, 128 * 1024, 8 * 1024, 4 * 1024 * 1024);
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    fd = fs.openSync(filePath, 'r');
    const bufferSize = Math.min(stat.size, safeMaxBytes);
    const buffer = Buffer.alloc(bufferSize);
    fs.readSync(fd, buffer, 0, bufferSize, stat.size - bufferSize);

    const text = buffer.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    const result = [];
    const startIdx = Math.max(0, lines.length - safeMaxLines);
    for (let i = startIdx; i < lines.length; i++) {
      try {
        result.push(JSON.parse(lines[i]));
      } catch (e) {
        // The first line can be truncated when reading from the tail.
      }
    }
    return result;
  } catch (err) {
    safeLog.warn(
      `[diagnostics] Failed to read last lines of ${path.basename(filePath)}: ${err.message}`
    );
    return [];
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (err) {}
    }
  }
}

function stageAtomicTextFile(filePath, content, encoding) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', PRIVATE_FILE_MODE);
    ensurePrivateFileSync(tmpPath);
    fs.writeFileSync(fd, content, { encoding });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return tmpPath;
  } catch (err) {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (errClose) {}
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (errCleanup) {}
    throw err;
  }
}

function cleanupAtomicTemp(tmpPath) {
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch (_) {
    // Preserve the original publication error.
  }
}

function writeTextFileAtomically(filePath, content, encoding = 'utf8') {
  const tmpPath = stageAtomicTextFile(filePath, content, encoding);
  try {
    renamePrivateFileSync(tmpPath, filePath);
  } catch (error) {
    cleanupAtomicTemp(tmpPath);
    throw error;
  }
}

async function writeJsonFileAtomicallyAsync(filePath, value, spacing = 2) {
  const tmpPath = stageAtomicTextFile(filePath, JSON.stringify(value, null, spacing), 'utf8');
  try {
    await renamePrivateFileAsync(tmpPath, filePath);
  } catch (error) {
    cleanupAtomicTemp(tmpPath);
    throw error;
  }
}

function writeJsonFileAtomically(filePath, value, spacing = 2) {
  writeTextFileAtomically(filePath, JSON.stringify(value, null, spacing), 'utf8');
}

function isQuietLocalPollRequest(method, pathname) {
  const normalizedMethod = String(method || '').toUpperCase();
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return false;
  return LOCAL_POLL_ENDPOINTS.has(String(pathname || '').split('?')[0]);
}

function isLocalManagementPath(pathname) {
  const normalized = String(pathname || '').split('?')[0];
  return normalized.startsWith('/v1/local/') || normalized.startsWith('/local/');
}

function isAllowedManagementOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return process.env.PROXY_ALLOW_NULL_MANAGEMENT_ORIGIN === '1';
  if (
    origin === 'tauri://localhost' ||
    origin === 'http://tauri.localhost' ||
    origin === 'https://tauri.localhost'
  )
    return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1'
    );
  } catch (err) {
    return false;
  }
}

function corsHeadersForOrigin(origin) {
  const allowOrigin = origin && isAllowedManagementOrigin(origin) ? origin : 'http://127.0.0.1';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization,x-api-key,x-mgmt-token,x-goog-api-key,api-key,content-type',
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Max-Age': '86400',
  };
}

function installManagementCorsGuard(req, res) {
  const origin = req.headers && req.headers.origin ? String(req.headers.origin) : '';
  if (!isAllowedManagementOrigin(origin)) {
    res.writeHead(403, {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeadersForOrigin(''),
    });
    res.end(JSON.stringify({ error: 'Management origin is not allowed' }));
    return false;
  }

  if (res.__managementCorsGuardInstalled) return true;
  res.__managementCorsGuardInstalled = true;

  const corsHeaders = corsHeadersForOrigin(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }

  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = function patchedWriteHead(statusCode, reasonPhrase, headers) {
    let reason = reasonPhrase;
    let nextHeaders = headers;
    if (reason && typeof reason === 'object') {
      nextHeaders = reason;
      reason = undefined;
    }
    nextHeaders = { ...(nextHeaders || {}) };
    for (const key of Object.keys(nextHeaders)) {
      if (key.toLowerCase().startsWith('access-control-')) {
        delete nextHeaders[key];
      }
    }
    Object.assign(nextHeaders, corsHeaders);
    if (reason === undefined) return originalWriteHead(statusCode, nextHeaders);
    return originalWriteHead(statusCode, reason, nextHeaders);
  };
  return true;
}

module.exports = {
  PRIVATE_FILE_MODE,
  fileSignature,
  parseBoundedInteger,
  parsePortOrDefault,
  readJsonBodyFromRequest,
  readTextBodyFromResponse,
  readLastLinesOfJsonl,
  writeTextFileAtomically,
  writeJsonFileAtomically,
  writeJsonFileAtomicallyAsync,
  isQuietLocalPollRequest,
  isLocalManagementPath,
  isAllowedManagementOrigin,
  installManagementCorsGuard,
};
