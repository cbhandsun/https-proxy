const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 1430);
const root = path.resolve(__dirname, '..', 'tauri-ui');
const configFile = path.resolve(__dirname, '..', 'proxy.config.json');
const staticLogFile = path.resolve(__dirname, '..', 'dev-static.log');
const localProxyAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let cachedConfigMtimeMs = -1;
let cachedLocalPort = 3443;
let staticLogQueue = Promise.resolve();

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
    'Pragma': 'no-cache',
    'Expires': '0',
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
    if (url.pathname.startsWith('/v1/local/') || url.pathname.startsWith('/local/')) {
      const localPort = await getLocalProxyPort();

      const targetUrl = `https://127.0.0.1:${localPort}${url.pathname}${url.search}`;
      const targetUrlObj = new URL(targetUrl);
      const headers = { ...req.headers };
      delete headers.host;

      const proxyReq = https.request({
        hostname: targetUrlObj.hostname,
        port: targetUrlObj.port,
        path: targetUrlObj.pathname + targetUrlObj.search,
        method: req.method,
        headers,
        agent: localProxyAgent
      }, (proxyRes) => {
        // Ensure CORS on proxied response too
        const responseHeaders = { ...proxyRes.headers, 'Access-Control-Allow-Origin': '*' };
        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: '静态服务中转本地代理失败: ' + err.message }));
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
    send(res, 500, String(err && err.message ? err.message : err), { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

function probeExistingServer() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/electron-ui.html`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    if (await probeExistingServer()) {
      console.log(`Port ${port} is already in use and serving the UI. Assuming static server is already running.`);
      process.exit(0);
      return;
    }
    console.error(`Port ${port} is busy but the UI server did not respond. Stop the stale process or set PORT to another value.`);
    process.exit(1);
  } else {
    console.error(err);
    process.exit(1);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`HTTPS Proxy Manager dev static server listening at http://localhost:${port}`);
  console.log(`Serving: ${root}`);
});
