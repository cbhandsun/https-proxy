const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { parsePortOrDefault } = require('../lib/proxy/management-utils');

function parseDevStaticPort(value) {
  return parsePortOrDefault(value, 1430);
}

function parseLocalProxyPort(value) {
  return parsePortOrDefault(value, 3443);
}

function parseOptionalPort(value) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(parsed)) return 0;
  const integer = Math.trunc(parsed);
  return integer >= 1 && integer <= 65535 ? integer : 0;
}

const port = parseDevStaticPort(process.env.PORT);
const rootDir = path.resolve(__dirname, '..');
const runtimeDir = path.resolve(
  process.env.PROXY_RUNTIME_DIR || process.env.PROXY_DATA_DIR || path.join(rootDir, '.hpm-runtime')
);
const root = path.resolve(__dirname, '..', 'tauri-ui');
const configFile = path.join(rootDir, 'proxy.config.json');
const staticLogFile = path.join(runtimeDir, 'dev-static.log');
const localManagementAgent = new http.Agent({ keepAlive: true });
const serverHealthMarker = 'dev-static-management-proxy-v9';
const verifiedManagementTokenCache = new Map();

let cachedConfigMtimeMs = -1;
let cachedLocalPort = 3443;
let staticLogQueue = Promise.resolve();

function staticServerOrigins(req) {
  const host = req.headers.host || `localhost:${port}`;
  return new Set([
    `http://${host}`,
    `https://${host}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
}

function isSameOriginManagementRequest(req) {
  const allowed = staticServerOrigins(req);
  const origin = req.headers.origin ? String(req.headers.origin) : '';
  if (origin && !allowed.has(origin)) return false;

  const fetchSite = req.headers['sec-fetch-site']
    ? String(req.headers['sec-fetch-site']).toLowerCase()
    : '';
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const referer = req.headers.referer ? String(req.headers.referer) : '';
  if (referer) {
    try {
      const parsed = new URL(referer);
      if (!allowed.has(parsed.origin)) return false;
    } catch (err) {
      return false;
    }
  }

  return true;
}

function sendForbiddenManagementProxy(res) {
  send(
    res,
    403,
    JSON.stringify({ error: 'Dev static management proxy only accepts same-origin UI requests' }),
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
    }
  );
}

function managementTokenCandidateGroups(managementPort) {
  const debugDir = path.join(rootDir, 'src-tauri', 'target', 'debug');
  const debugRuntimeDir = path.join(debugDir, '.hpm-runtime');
  const portableRuntimeDir = path.join(
    rootDir,
    'dist',
    'portable',
    'HTTPS Proxy Manager Portable',
    '.hpm-runtime'
  );
  const portNumber = parseOptionalPort(managementPort);
  const groups = [];
  if (portNumber > 0) {
    groups.push([
      path.join(runtimeDir, `.mgmt-token-${portNumber}`),
      path.join(debugRuntimeDir, `.mgmt-token-${portNumber}`),
      path.join(portableRuntimeDir, `.mgmt-token-${portNumber}`),
      path.join(rootDir, `.mgmt-token-${portNumber}`),
      path.join(debugDir, `.mgmt-token-${portNumber}`),
    ]);
  }
  groups.push([
    path.join(runtimeDir, '.mgmt-token'),
    path.join(debugRuntimeDir, '.mgmt-token'),
    path.join(portableRuntimeDir, '.mgmt-token'),
    path.join(rootDir, '.mgmt-token'),
    path.join(debugDir, '.mgmt-token'),
  ]);
  return groups;
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function isPathInsideRoot(requestedPath, rootPath) {
  const relative = path.relative(rootPath, requestedPath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    ...headers,
  });
  res.end(body);
}

function writeStaticLog(line) {
  staticLogQueue = staticLogQueue
    .then(async () => {
      await fs.promises.mkdir(runtimeDir, { recursive: true });
      await fs.promises.appendFile(staticLogFile, line, 'utf8');
    })
    .catch(() => {});
}

async function getLocalProxyPort() {
  try {
    const stat = await fs.promises.stat(configFile);
    if (stat.mtimeMs === cachedConfigMtimeMs) return cachedLocalPort;

    const config = JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
    cachedConfigMtimeMs = stat.mtimeMs;
    cachedLocalPort = parseLocalProxyPort(config.localServer && config.localServer.listenPort);
    return cachedLocalPort;
  } catch (err) {
    cachedConfigMtimeMs = -1;
    cachedLocalPort = 3443;
    return cachedLocalPort;
  }
}

function invalidateManagementTokenCache(managementPort) {
  verifiedManagementTokenCache.delete(managementPort);
}

async function readManagementToken(managementPort, options = {}) {
  const cache = verifiedManagementTokenCache.get(managementPort);
  if (!options.forceRefresh && cache && Date.now() - cache.checkedAt < 2000) return cache.token;

  let firstReadableToken = '';
  let sawIndeterminateProbe = false;
  for (const group of managementTokenCandidateGroups(managementPort)) {
    const candidates = [];
    for (const filePath of group) {
      try {
        const value = (await fs.promises.readFile(filePath, 'utf8')).trim();
        const stat = await fs.promises.stat(filePath);
        if (value) candidates.push({ value, mtimeMs: stat.mtimeMs });
      } catch (err) {}
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates) {
      if (!firstReadableToken) firstReadableToken = candidate.value;
      const accepted = await managementTokenAccepted(managementPort, candidate.value);
      if (accepted === true) {
        verifiedManagementTokenCache.set(managementPort, {
          token: candidate.value,
          checkedAt: Date.now(),
        });
        return candidate.value;
      }
      if (accepted === null) sawIndeterminateProbe = true;
    }
  }
  if (sawIndeterminateProbe) return firstReadableToken;
  return firstReadableToken;
}

function managementTokenAccepted(managementPort, token) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: managementPort,
        path: '/v1/local/config',
        method: 'GET',
        headers: { 'x-mgmt-token': token, Connection: 'close' },
        agent: false,
        timeout: 500,
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true);
        else if (res.statusCode === 401 || res.statusCode === 403) resolve(false);
        else resolve(null);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (process.env.STATIC_SERVER_VERBOSE === '1') {
    console.log(`[static-server] ${req.method} ${req.url}`);
  }
  writeStaticLog(`[${new Date().toISOString()}] ${req.method} ${req.url}\n`);
  // CORS support for development APIs
  if (req.method === 'OPTIONS') {
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.url && (req.url.startsWith('/v1/local/') || req.url.startsWith('/local/'))) {
      if (!isSameOriginManagementRequest(req)) {
        sendForbiddenManagementProxy(res);
        return;
      }
      const origin = req.headers.origin ? String(req.headers.origin) : '';
      headers['Access-Control-Allow-Origin'] = origin || `http://localhost:${port}`;
    } else {
      headers['Access-Control-Allow-Origin'] = '*';
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    if (url.pathname === '/__dev-static-health') {
      send(
        res,
        200,
        JSON.stringify({
          ok: true,
          marker: serverHealthMarker,
          root,
        }),
        { 'Content-Type': 'application/json; charset=utf-8' }
      );
      return;
    }

    if (url.pathname.startsWith('/v1/local/') || url.pathname.startsWith('/local/')) {
      if (!isSameOriginManagementRequest(req)) {
        sendForbiddenManagementProxy(res);
        return;
      }
      const localPort = await getLocalProxyPort();
      const managementPort = localPort + 100;
      const targetUrl = `http://127.0.0.1:${managementPort}${url.pathname}${url.search}`;
      const targetUrlObj = new URL(targetUrl);
      const headers = { ...req.headers };
      delete headers.host;
      const token = await readManagementToken(managementPort);
      if (token) headers['x-mgmt-token'] = token;

      const forwardManagementRequest = (retrying = false) => {
        const requestHeaders = { ...headers };
        const retryToken = requestHeaders['x-mgmt-token'];
        const proxyReq = http.request(
          {
            hostname: targetUrlObj.hostname,
            port: targetUrlObj.port,
            path: targetUrlObj.pathname + targetUrlObj.search,
            method: req.method,
            headers: requestHeaders,
            agent: localManagementAgent,
          },
          (proxyRes) => {
            if (
              proxyRes.statusCode === 401 &&
              !retrying &&
              (req.method === 'GET' || req.method === 'HEAD')
            ) {
              proxyRes.resume();
              invalidateManagementTokenCache(managementPort);
              readManagementToken(managementPort, { forceRefresh: true })
                .then((freshToken) => {
                  if (!freshToken || freshToken === retryToken) {
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(JSON.stringify({ error: 'Unauthorized management access' }));
                    return;
                  }
                  headers['x-mgmt-token'] = freshToken;
                  forwardManagementRequest(true);
                })
                .catch((err) => {
                  res.writeHead(502, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                  });
                  res.end(JSON.stringify({ error: '静态服务刷新管理 Token 失败: ' + err.message }));
                });
              return;
            }
            // Pipe the management port's response back. The management port
            // already sets its own CORS headers; if we add another set, the
            // browser/Tauri webview ends up with duplicate
            // Access-Control-Allow-Origin headers, which is invalid per the
            // Fetch spec and causes the webview to reject the response.
            // See: https://fetch.spec.whatwg.org/#cors-protocol
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );

        proxyReq.on('error', (err) => {
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: '静态服务中转本地代理失败: ' + err.message }));
        });
        const proxyTimeoutMs =
          url.pathname === '/v1/local/trae/debug/claude-process/self-test' ||
          url.pathname === '/local/trae/debug/claude-process/self-test'
            ? 180000
            : 7000;
        proxyReq.setTimeout(proxyTimeoutMs, () => {
          proxyReq.destroy(
            new Error(
              `HTTP 管理端口 ${managementPort} 请求超时(${Math.round(
                proxyTimeoutMs / 1000
              )}s)，请确认代理已启动`
            )
          );
        });

        if (req.method === 'GET' || req.method === 'HEAD') {
          proxyReq.end();
        } else {
          req.pipe(proxyReq);
        }
      };

      forwardManagementRequest(false);
      return;
    }

    const pathname = decodeURIComponent(url.pathname === '/' ? '/electron-ui.html' : url.pathname);
    const requested = path.resolve(root, `.${pathname}`);

    if (!isPathInsideRoot(requested, root)) {
      send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    fs.readFile(requested, (err, data) => {
      if (err) {
        send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }
      const ext = path.extname(requested).toLowerCase();
      send(res, 200, data, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    });
  } catch (err) {
    send(res, 500, String(err && err.message ? err.message : err), {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }
});

function probeExistingServer() {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    const req = http.get(`http://127.0.0.1:${port}/__dev-static-health`, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        if (finished) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        bytes += buffer.length;
        if (bytes > 1024 * 1024) {
          chunks.length = 0;
          req.destroy();
          finish(false);
          return;
        }
        chunks.push(buffer);
      });
      res.on('end', () => {
        if (finished) return;
        const body = Buffer.concat(chunks, bytes).toString('utf8');
        finish(res.statusCode >= 200 && res.statusCode < 300 && body.includes(serverHealthMarker));
      });
    });
    req.setTimeout(1000, () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => finish(false));
  });
}

function stopStaleDevStaticServers() {
  if (process.platform !== 'win32') return;
  const command = [
    `$listeners = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    'foreach ($conn in $listeners) {',
    "  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $conn.OwningProcess) -ErrorAction SilentlyContinue",
    "  if ($proc -and $proc.CommandLine -match 'scripts[\\\\/]+dev-static-server\\.js') {",
    '    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue',
    '  }',
    '}',
  ].join('; ');
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      stdio: 'ignore',
    });
  } catch (err) {
    // Best effort only. The final probe below will surface a real failure.
  }
}

function openLogFd(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return fs.openSync(file, 'a');
  } catch (err) {
    return 'ignore';
  }
}

function startDetachedServer() {
  const outFd = openLogFd(path.join(runtimeDir, '.static-server.out.log'));
  const errFd = openLogFd(path.join(runtimeDir, '.static-server.err.log'));
  const child = spawn(process.execPath, [__filename], {
    cwd: rootDir,
    detached: true,
    env: { ...process.env, PROXY_RUNTIME_DIR: runtimeDir },
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  });
  child.unref();
}

async function ensureServer() {
  if (await probeExistingServer()) return true;
  stopStaleDevStaticServers();
  startDetachedServer();
  const started = Date.now();
  while (Date.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await probeExistingServer()) return true;
  }
  return false;
}

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    if (await probeExistingServer()) {
      console.log(
        `Port ${port} is already in use and serving the UI. Assuming static server is already running.`
      );
      process.exit(0);
      return;
    }
    console.error(
      `Port ${port} is busy but the UI server did not respond. Stop the stale process or set PORT to another value.`
    );
    process.exit(1);
  } else {
    console.error(err);
    process.exit(1);
  }
});

if (require.main === module) {
  if (process.argv.includes('--ensure')) {
    ensureServer()
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch(() => process.exit(1));
  } else if (process.argv.includes('--probe')) {
    probeExistingServer()
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch(() => process.exit(1));
  } else {
    server.listen(port, '127.0.0.1', () => {
      console.log(`HTTPS Proxy Manager dev static server listening at http://localhost:${port}`);
      console.log(`Serving: ${root}`);
    });
  }
}

module.exports = {
  parseDevStaticPort,
  parseLocalProxyPort,
  parseOptionalPort,
  isSameOriginManagementRequest,
  isPathInsideRoot,
  managementTokenCandidateGroups,
  readManagementToken,
  invalidateManagementTokenCache,
  staticServerOrigins,
  serverHealthMarker,
};
