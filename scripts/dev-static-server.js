const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const port = Number(process.env.PORT || 1430);
const root = path.resolve(__dirname, '..', 'tauri-ui');
const configFile = path.resolve(__dirname, '..', 'proxy.config.json');
const staticLogFile = path.resolve(__dirname, '..', 'dev-static.log');
const localManagementAgent = new http.Agent({ keepAlive: true });
const serverHealthMarker = 'dev-static-management-proxy-v5';

let cachedConfigMtimeMs = -1;
let cachedLocalPort = 3443;
let staticLogQueue = Promise.resolve();
function managementTokenCandidateGroups(managementPort) {
  const rootDir = path.resolve(__dirname, '..');
  const debugDir = path.join(rootDir, 'src-tauri', 'target', 'debug');
  const portNumber = Number(managementPort);
  const groups = [];
  if (Number.isFinite(portNumber) && portNumber > 0) {
    groups.push([
      path.join(rootDir, `.mgmt-token-${portNumber}`),
      path.join(debugDir, `.mgmt-token-${portNumber}`),
    ]);
  }
  groups.push([path.join(rootDir, '.mgmt-token'), path.join(debugDir, '.mgmt-token')]);
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
    .then(() => fs.promises.appendFile(staticLogFile, line, 'utf8'))
    .catch(() => {});
}

async function getLocalProxyPort() {
  try {
    const stat = await fs.promises.stat(configFile);
    if (stat.mtimeMs === cachedConfigMtimeMs) return cachedLocalPort;

    const config = JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
    cachedConfigMtimeMs = stat.mtimeMs;
    cachedLocalPort = Number((config.localServer && config.localServer.listenPort) || 3443);
    return cachedLocalPort;
  } catch (err) {
    cachedConfigMtimeMs = -1;
    cachedLocalPort = 3443;
    return cachedLocalPort;
  }
}

async function readManagementToken(managementPort) {
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
    if (candidates[0]) return candidates[0].value;
  }
  return '';
}

const server = http.createServer(async (req, res) => {
  if (process.env.STATIC_SERVER_VERBOSE === '1') {
    console.log(`[static-server] ${req.method} ${req.url}`);
  }
  writeStaticLog(`[${new Date().toISOString()}] ${req.method} ${req.url}\n`);
  // CORS support for development APIs
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
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
      const localPort = await getLocalProxyPort();
      const managementPort = localPort + 100;
      const targetUrl = `http://127.0.0.1:${managementPort}${url.pathname}${url.search}`;
      const targetUrlObj = new URL(targetUrl);
      const headers = { ...req.headers };
      delete headers.host;
      const token = await readManagementToken(managementPort);
      if (token) headers['x-mgmt-token'] = token;

      const proxyReq = http.request(
        {
          hostname: targetUrlObj.hostname,
          port: targetUrlObj.port,
          path: targetUrlObj.pathname + targetUrlObj.search,
          method: req.method,
          headers,
          agent: localManagementAgent,
        },
        (proxyRes) => {
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
      proxyReq.setTimeout(7000, () => {
        proxyReq.destroy(new Error(`HTTP 管理端口 ${managementPort} 请求超时，请确认代理已启动`));
      });

      req.pipe(proxyReq);
      return;
    }

    const pathname = decodeURIComponent(url.pathname === '/' ? '/electron-ui.html' : url.pathname);
    const requested = path.normalize(path.join(root, pathname));

    if (!requested.startsWith(root)) {
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
    const req = http.get(`http://127.0.0.1:${port}/__dev-static-health`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          req.destroy();
          resolve(false);
        }
      });
      res.on('end', () => {
        resolve(res.statusCode >= 200 && res.statusCode < 300 && body.includes(serverHealthMarker));
      });
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
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
    return fs.openSync(file, 'a');
  } catch (err) {
    return 'ignore';
  }
}

function startDetachedServer() {
  const outFd = openLogFd(path.resolve(__dirname, '..', '.static-server.out.log'));
  const errFd = openLogFd(path.resolve(__dirname, '..', '.static-server.err.log'));
  const child = spawn(process.execPath, [__filename], {
    cwd: path.resolve(__dirname, '..'),
    detached: true,
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
