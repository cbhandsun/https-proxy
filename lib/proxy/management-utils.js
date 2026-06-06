const fs = require('fs');
const path = require('path');

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

function readLastLinesOfJsonl(filePath, maxLines = 50, maxBytes = 128 * 1024) {
  if (!fs.existsSync(filePath)) return [];
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    fd = fs.openSync(filePath, 'r');
    const bufferSize = Math.min(stat.size, Math.max(8 * 1024, maxBytes));
    const buffer = Buffer.alloc(bufferSize);
    fs.readSync(fd, buffer, 0, bufferSize, stat.size - bufferSize);

    const text = buffer.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    const result = [];
    const startIdx = Math.max(0, lines.length - maxLines);
    for (let i = startIdx; i < lines.length; i++) {
      try {
        result.push(JSON.parse(lines[i]));
      } catch (e) {
        // The first line can be truncated when reading from the tail.
      }
    }
    return result;
  } catch (err) {
    console.warn(`[diagnostics] Failed to read last lines of ${path.basename(filePath)}: ${err.message}`);
    return [];
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (err) {}
    }
  }
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
  if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost') return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '[::1]'
      || parsed.hostname === '::1';
  } catch (err) {
    return false;
  }
}

function corsHeadersForOrigin(origin) {
  const allowOrigin = origin && isAllowedManagementOrigin(origin)
    ? origin
    : 'http://127.0.0.1';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,x-api-key,x-goog-api-key,api-key,content-type',
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
  fileSignature,
  readLastLinesOfJsonl,
  isQuietLocalPollRequest,
  isLocalManagementPath,
  isAllowedManagementOrigin,
  installManagementCorsGuard,
};
