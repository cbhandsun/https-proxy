'use strict';

// Regression coverage for the Vite dev-management bridge.
//
// The desktop UI talks to relative /v1/local/* URLs. Serving the UI from Vite
// without forwarding those calls to the management port made every management
// request return the HTML fallback (HTTP 200 text/html), which silently broke
// configuration, health checks, and every other management screen in dev mode.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  createDevManagementProxy,
  isSameOriginManagementRequest,
  managementPathFromUrl,
  managementTokenCandidateGroups,
  parseOptionalPort,
  staticServerOrigins,
} = require('../lib/dev/management-proxy');

const repoRoot = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestThrough(middleware, options) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not forwarded' }));
      }).catch(reject);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: options.path,
          method: options.method || 'GET',
          headers: { host: `127.0.0.1:${port}`, ...(options.headers || {}) },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            void close(server).then(() =>
              resolve({ statusCode: res.statusCode, headers: res.headers, body })
            );
          });
        }
      );
      req.on('error', (error) => {
        void close(server).then(() => reject(error));
      });
      req.end();
    });
  });
}

{
  assert.equal(managementPathFromUrl('/v1/local/health'), '/v1/local/health');
  assert.equal(managementPathFromUrl('/local/health?x=1'), '/local/health?x=1');
  assert.equal(managementPathFromUrl('/src/main.js'), '');
  assert.equal(managementPathFromUrl('/v1/models'), '');
  assert.equal(managementPathFromUrl(undefined), '');

  assert.equal(parseOptionalPort('3543'), 3543);
  assert.equal(parseOptionalPort('0'), 0);
  assert.equal(parseOptionalPort('70000'), 0);
  assert.equal(parseOptionalPort('bad'), 0);

  const origins = staticServerOrigins('127.0.0.1:1430', 1430);
  assert.equal(origins.has('http://127.0.0.1:1430'), true);
  assert.equal(origins.has('http://localhost:1430'), true);
  assert.equal(origins.has('http://localhost:5173'), false);

  assert.equal(isSameOriginManagementRequest({ headers: { host: '127.0.0.1:1430' } }, 1430), true);
  assert.equal(
    isSameOriginManagementRequest(
      { headers: { host: '127.0.0.1:1430', origin: 'http://127.0.0.1:1430' } },
      1430
    ),
    true
  );
  assert.equal(
    isSameOriginManagementRequest(
      { headers: { host: '127.0.0.1:1430', origin: 'http://localhost:9999' } },
      1430
    ),
    false
  );
  assert.equal(
    isSameOriginManagementRequest(
      { headers: { host: '127.0.0.1:1430', referer: 'http://localhost:9999/page' } },
      1430
    ),
    false
  );
  assert.equal(
    isSameOriginManagementRequest(
      { headers: { host: '127.0.0.1:1430', 'sec-fetch-site': 'cross-site' } },
      1430
    ),
    false
  );
  assert.equal(
    isSameOriginManagementRequest(
      { headers: { host: '127.0.0.1:1430', 'sec-fetch-site': 'same-origin' } },
      1430
    ),
    true
  );
}

(async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-dev-management-'));
  const runtimeDir = path.join(fixtureRoot, '.hpm-runtime');
  const configFile = path.join(fixtureRoot, 'proxy.config.json');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const acceptedTokens = new Set(['fresh-token']);
  const seenRequests = [];
  const managementServer = http.createServer((req, res) => {
    seenRequests.push({ url: req.url, token: req.headers['x-mgmt-token'] });
    if (!acceptedTokens.has(String(req.headers['x-mgmt-token'] || ''))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized management access' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, appId: 'https-proxy-manager', path: req.url }));
  });
  const managementPort = await listen(managementServer);

  try {
    fs.writeFileSync(
      configFile,
      JSON.stringify({ localServer: { listenPort: managementPort - 100 } })
    );
    fs.writeFileSync(path.join(runtimeDir, '.mgmt-token'), 'fresh-token');

    const middleware = createDevManagementProxy({
      repoRoot,
      runtimeDir,
      configFile,
      devPort: 1430,
    });

    const health = await requestThrough(middleware, { path: '/v1/local/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.body).appId, 'https-proxy-manager');
    assert.equal(seenRequests.at(-1).token, 'fresh-token');
    const forwardedHealthRequests = () =>
      seenRequests.filter((entry) => entry.url === '/v1/local/health');
    assert.equal(forwardedHealthRequests().length, 1);

    const unrelated = await requestThrough(middleware, { path: '/src/main.js' });
    assert.equal(unrelated.statusCode, 404, 'non-management paths must not be intercepted');
    assert.equal(forwardedHealthRequests().length, 1);

    const crossOrigin = await requestThrough(middleware, {
      path: '/v1/local/health',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(
      forwardedHealthRequests().length,
      1,
      'cross-origin requests must not reach the proxy'
    );

    // A stale token must be refreshed and the request retried once.
    fs.writeFileSync(path.join(runtimeDir, '.mgmt-token'), 'stale-token');
    acceptedTokens.clear();
    acceptedTokens.add('rotated-token');
    fs.writeFileSync(path.join(runtimeDir, '.mgmt-token'), 'rotated-token');

    const refreshed = await createDevManagementProxy({
      repoRoot,
      runtimeDir,
      configFile,
      devPort: 1430,
      probeToken: async (_port, token) => token === 'rotated-token',
    });
    const afterRotation = await requestThrough(refreshed, { path: '/v1/local/config' });
    assert.equal(afterRotation.statusCode, 200);
    assert.equal(seenRequests.at(-1).token, 'rotated-token');

    // A wrong-only token set must fail closed instead of hanging.
    const rejected = await createDevManagementProxy({
      repoRoot,
      runtimeDir,
      configFile,
      devPort: 1430,
      probeToken: async () => false,
    });
    fs.writeFileSync(path.join(runtimeDir, '.mgmt-token'), 'never-accepted');
    const unauthorized = await requestThrough(rejected, { path: '/v1/local/config' });
    assert.equal(unauthorized.statusCode, 401);

    const groups = managementTokenCandidateGroups({
      repoRoot,
      runtimeDir,
      managementPort: 3543,
    });
    assert.equal(
      groups[0].some((filePath) => filePath.endsWith('.mgmt-token-3543')),
      true
    );
    assert.equal(
      groups[0].some((filePath) => path.dirname(filePath) === runtimeDir),
      true
    );
    assert.equal(
      managementTokenCandidateGroups({ repoRoot, runtimeDir, managementPort: 'bad' }).length,
      1
    );
  } finally {
    await close(managementServer);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  console.log('[dev-management-proxy.test] ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
