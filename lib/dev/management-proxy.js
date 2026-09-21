'use strict';

// Dev-only bridge between the Vite dev server origin and the plain-HTTP
// management port of the running proxy.
//
// The desktop UI always talks to relative "/v1/local/*" URLs. In a packaged
// Tauri build the renderer never sees the management token; Tauri's native
// bridge performs the authenticated call. During frontend development the
// page is served by Vite on http://localhost:1430, so those relative URLs must
// be forwarded to the management port (default: entry port + 100) with the
// management token injected server-side. Without this middleware the request
// reaches Vite, which answers with the HTML fallback and breaks every
// management API in dev mode.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { parsePortOrDefault } = require('../proxy/management-utils');

const DEFAULT_DEV_PORT = 1430;
const DEFAULT_ENTRY_PORT = 3443;
const DEFAULT_TOKEN_CACHE_TTL_MS = 2000;
const DEFAULT_TOKEN_PROBE_TIMEOUT_MS = 500;
const DEFAULT_PROXY_TIMEOUT_MS = 30000;
const LONG_RUNNING_PROXY_TIMEOUT_MS = 180000;
const LONG_RUNNING_PATHS = new Set([
  '/v1/local/trae/debug/claude-process/self-test',
  '/local/trae/debug/claude-process/self-test',
]);
const MANAGEMENT_PATH_PREFIXES = ['/v1/local/', '/local/'];

const noopLogger = {
  debug() {},
  warn() {},
};

function parseOptionalPort(value) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(parsed)) return 0;
  const integer = Math.trunc(parsed);
  return integer >= 1 && integer <= 65535 ? integer : 0;
}

function managementPathFromUrl(url) {
  const raw = typeof url === 'string' ? url : '';
  if (!raw) return '';
  const pathname = raw.split('?')[0];
  return MANAGEMENT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? raw : '';
}

function staticServerOrigins(hostHeader, devPort) {
  const port = parsePortOrDefault(devPort, DEFAULT_DEV_PORT);
  const host = String(hostHeader || '').trim() || `localhost:${port}`;
  return new Set([
    `http://${host}`,
    `https://${host}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
}

// The dev proxy is reachable from any local process, so it only forwards
// requests that a page served by this dev server could legitimately issue.
// Unknown/missing headers stay allowed so non-browser tooling keeps working;
// any header that is present must be consistent with the dev origin.
function isSameOriginManagementRequest(req, devPort) {
  const headers = (req && req.headers) || {};
  const allowed = staticServerOrigins(headers.host, devPort);

  const origin = headers.origin ? String(headers.origin) : '';
  if (origin && !allowed.has(origin)) return false;

  const fetchSite = headers['sec-fetch-site']
    ? String(headers['sec-fetch-site']).toLowerCase()
    : '';
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const referer = headers.referer ? String(headers.referer) : '';
  if (referer) {
    try {
      if (!allowed.has(new URL(referer).origin)) return false;
    } catch (error) {
      return false;
    }
  }

  return true;
}

function managementTokenCandidateGroups({ repoRoot, runtimeDir, managementPort }) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new TypeError('managementTokenCandidateGroups requires repoRoot');
  }
  const root = path.resolve(repoRoot);
  const runtime = path.resolve(runtimeDir || path.join(root, '.hpm-runtime'));
  const debugDir = path.join(root, 'src-tauri', 'target', 'debug');
  const debugRuntimeDir = path.join(debugDir, '.hpm-runtime');
  const portableRuntimeDir = path.join(
    root,
    'dist',
    'portable',
    'HTTPS Proxy Manager Portable',
    '.hpm-runtime'
  );
  const groups = [];
  const portNumber = parseOptionalPort(managementPort);
  if (portNumber > 0) {
    groups.push([
      path.join(runtime, `.mgmt-token-${portNumber}`),
      path.join(debugRuntimeDir, `.mgmt-token-${portNumber}`),
      path.join(portableRuntimeDir, `.mgmt-token-${portNumber}`),
      path.join(root, `.mgmt-token-${portNumber}`),
      path.join(debugDir, `.mgmt-token-${portNumber}`),
    ]);
  }
  groups.push([
    path.join(runtime, '.mgmt-token'),
    path.join(debugRuntimeDir, '.mgmt-token'),
    path.join(portableRuntimeDir, '.mgmt-token'),
    path.join(root, '.mgmt-token'),
    path.join(debugDir, '.mgmt-token'),
  ]);
  return groups;
}

function toNonEmptyToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  return token || '';
}

function probeManagementToken(managementPort, token, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: managementPort,
        path: '/v1/local/config',
        method: 'GET',
        headers: { 'x-mgmt-token': token, Connection: 'close' },
        agent: false,
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        if (response.statusCode === 200) resolve(true);
        else if (response.statusCode === 401 || response.statusCode === 403) resolve(false);
        else resolve(null);
      }
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
    request.end();
  });
}

function createDevManagementProxy(options = {}) {
  const repoRoot = options.repoRoot;
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new TypeError('createDevManagementProxy requires repoRoot');
  }
  const root = path.resolve(repoRoot);
  const runtimeDir = path.resolve(
    options.runtimeDir ||
      process.env.PROXY_RUNTIME_DIR ||
      process.env.PROXY_DATA_DIR ||
      path.join(root, '.hpm-runtime')
  );
  const configFile = path.resolve(options.configFile || path.join(root, 'proxy.config.json'));
  const devPort = parsePortOrDefault(options.devPort, DEFAULT_DEV_PORT);
  const explicitManagementPort = parseOptionalPort(options.managementPort);
  const logger = options.logger || noopLogger;
  const probe =
    typeof options.probeToken === 'function' ? options.probeToken : probeManagementToken;
  const tokenProbeTimeoutMs =
    parseOptionalPort(options.tokenProbeTimeoutMs) || DEFAULT_TOKEN_PROBE_TIMEOUT_MS;
  const tokenCacheTtlMs =
    Number.isFinite(options.tokenCacheTtlMs) && options.tokenCacheTtlMs > 0
      ? Math.trunc(options.tokenCacheTtlMs)
      : DEFAULT_TOKEN_CACHE_TTL_MS;

  const tokenCache = new Map();
  const localPortCache = { signature: '', port: DEFAULT_ENTRY_PORT };

  function readEntryPort() {
    let signature = 'missing';
    try {
      const stat = fs.statSync(configFile);
      signature = `${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      localPortCache.signature = signature;
      localPortCache.port = DEFAULT_ENTRY_PORT;
      return localPortCache.port;
    }
    if (localPortCache.signature === signature) return localPortCache.port;

    let port = DEFAULT_ENTRY_PORT;
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      port = parsePortOrDefault(
        config && config.localServer && config.localServer.listenPort,
        DEFAULT_ENTRY_PORT
      );
    } catch (error) {
      logger.debug('[dev-management-proxy] falling back to the default entry port', error.message);
    }
    localPortCache.signature = signature;
    localPortCache.port = port;
    return port;
  }

  function resolveManagementPort() {
    if (explicitManagementPort) return explicitManagementPort;
    const managementPort = readEntryPort() + 100;
    return parseOptionalPort(managementPort) || DEFAULT_ENTRY_PORT + 100;
  }

  function invalidateManagementToken(managementPort) {
    tokenCache.delete(managementPort);
  }

  async function readManagementToken(managementPort, options_) {
    const forceRefresh = Boolean(options_ && options_.forceRefresh);
    const cached = tokenCache.get(managementPort);
    if (!forceRefresh && cached && Date.now() - cached.checkedAt < tokenCacheTtlMs) {
      return cached.token;
    }

    let firstReadableToken = '';
    let probeWasIndeterminate = false;
    for (const group of managementTokenCandidateGroups({
      repoRoot: root,
      runtimeDir,
      managementPort,
    })) {
      const candidates = [];
      for (const filePath of group) {
        try {
          const value = toNonEmptyToken(fs.readFileSync(filePath, 'utf8'));
          if (!value) continue;
          candidates.push({ value, mtimeMs: fs.statSync(filePath).mtimeMs });
        } catch (error) {
          // Unreadable candidates are expected; the next candidate may win.
        }
      }
      candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
      for (const candidate of candidates) {
        if (!firstReadableToken) firstReadableToken = candidate.value;
        const accepted = await probe(managementPort, candidate.value, tokenProbeTimeoutMs);
        if (accepted === true) {
          tokenCache.set(managementPort, { token: candidate.value, checkedAt: Date.now() });
          return candidate.value;
        }
        if (accepted === null) probeWasIndeterminate = true;
      }
    }
    if (probeWasIndeterminate) {
      logger.debug('[dev-management-proxy] management token probe was inconclusive');
    }
    return firstReadableToken;
  }

  function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }

  function forward(req, res, managementPort, token, body, retryAllowed) {
    return new Promise((resolve) => {
      const headers = { ...req.headers };
      delete headers.host;
      if (token) headers['x-mgmt-token'] = token;

      const proxyRequest = http.request(
        {
          hostname: '127.0.0.1',
          port: managementPort,
          path: body.path,
          method: req.method,
          headers,
        },
        (proxyResponse) => {
          const statusCode = proxyResponse.statusCode || 502;
          // A stale cached token must be refreshed before the caller sees the
          // response, otherwise the retry would write a second response.
          if (retryAllowed && statusCode === 401 && !res.headersSent) {
            proxyResponse.resume();
            resolve({ statusCode, retryable: true });
            return;
          }
          // The management port already emits its own CORS headers. Adding a
          // second set produces duplicate Access-Control-Allow-Origin values,
          // which the Fetch spec rejects.
          res.writeHead(statusCode, proxyResponse.headers);
          proxyResponse.pipe(res);
          resolve({ statusCode, retryable: false });
        }
      );

      proxyRequest.on('error', (error) => {
        logger.warn('[dev-management-proxy] management request failed', error.message);
        if (!res.headersSent) {
          sendJson(res, 502, { error: 'Dev management proxy could not reach the local proxy' });
        }
        resolve({ statusCode: 502, error: true, retryable: false });
      });

      proxyRequest.setTimeout(
        LONG_RUNNING_PATHS.has(body.pathname)
          ? LONG_RUNNING_PROXY_TIMEOUT_MS
          : DEFAULT_PROXY_TIMEOUT_MS,
        () => {
          proxyRequest.destroy(new Error('dev management proxy timed out'));
        }
      );

      if (req.method === 'GET' || req.method === 'HEAD') proxyRequest.end();
      else req.pipe(proxyRequest);
    });
  }

  return async function devManagementProxyMiddleware(req, res, next) {
    const managementUrl = managementPathFromUrl(req.url);
    if (!managementUrl) {
      next();
      return;
    }
    if (!isSameOriginManagementRequest(req, devPort)) {
      sendJson(res, 403, {
        error: 'Dev management proxy only accepts same-origin UI requests',
      });
      return;
    }

    const [pathname, search] = managementUrl.split(/(?=\?)/);
    const body = { path: managementUrl, pathname: pathname || '', search: search || '' };
    const managementPort = resolveManagementPort();
    const canRetry = req.method === 'GET' || req.method === 'HEAD';

    try {
      const token = await readManagementToken(managementPort);
      const result = await forward(req, res, managementPort, token, body, canRetry);
      if (!result.retryable) return;

      invalidateManagementToken(managementPort);
      const freshToken = await readManagementToken(managementPort, { forceRefresh: true });
      if (!freshToken || freshToken === token) {
        sendJson(res, 401, { error: 'Unauthorized management access' });
        return;
      }
      logger.debug('[dev-management-proxy] retrying management request with a refreshed token');
      await forward(req, res, managementPort, freshToken, body, false);
    } catch (error) {
      logger.warn('[dev-management-proxy] request failed', error.message);
      if (!res.headersSent) {
        sendJson(res, 502, { error: 'Dev management proxy failed to forward the request' });
      } else {
        res.end();
      }
    }
  };
}

module.exports = {
  DEFAULT_DEV_PORT,
  DEFAULT_ENTRY_PORT,
  LONG_RUNNING_PATHS,
  MANAGEMENT_PATH_PREFIXES,
  createDevManagementProxy,
  isSameOriginManagementRequest,
  managementPathFromUrl,
  managementTokenCandidateGroups,
  parseOptionalPort,
  probeManagementToken,
  staticServerOrigins,
};
