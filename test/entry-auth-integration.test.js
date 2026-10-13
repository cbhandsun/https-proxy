const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { encryptConfigSecretsForStorage } = require('../lib/proxy/config');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');

let receivedHeaders = {};
let upstreamHits = 0;

const upstream = http.createServer((req, res) => {
  upstreamHits += 1;
  receivedHeaders = req.headers;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode != null || proc.signalCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 1500);
    if (typeof timer.unref === 'function') timer.unref();
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill();
  });
}

function requestProxy(port, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'POST';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path || '/v1/chat/completions',
        method,
        headers: {
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    if (method === 'POST') {
      req.end(
        options.body === undefined
          ? JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] })
          : options.body
      );
      return;
    }
    req.end();
  });
}

function waitForProxy(proc) {
  proc.stderr.on('data', (data) => process.stderr.write(data));
  return waitForProxyFixtureReady(proc);
}

(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-entry-auth-'));
  const [entryPort, managementPort] = await findAvailablePorts(2);
  const testEnv = createIsolatedTestEnv(process.env, dataDir);
  fs.mkdirSync(testEnv.PROXY_CONFIG_DIR, { recursive: true });
  const config = {
    activeProfile: 'openai-upstream',
    localServer: {
      host: '127.0.0.1',
      listenPort: entryPort,
      basePath: '/v1',
      protocol: 'openai-chat',
    },
    entryServers: [
      {
        name: 'OpenAI Chat Test',
        host: '127.0.0.1',
        listenPort: entryPort,
        basePath: '/v1',
        protocol: 'openai-chat',
        tls: false,
      },
    ],
    profiles: [
      {
        id: 'openai-upstream',
        name: 'OpenAI Upstream',
        protocol: 'openai',
        targetUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'real-upstream-key',
      },
    ],
    modelRoutes: [],
    entryAuth: {
      enabled: true,
      keys: [
        {
          id: 'team-a',
          name: 'Team A',
          key: 'entry-secret',
          enabled: true,
          allowedEntryProtocols: ['openai-chat'],
          allowedEntryPorts: [entryPort],
          allowedProfileIds: ['openai-upstream'],
        },
      ],
    },
  };
  // Prepare persisted credentials before timing listener startup. Plaintext
  // migration is covered by config tests and can launch several DPAPI helpers.
  fs.writeFileSync(
    path.join(testEnv.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify(encryptConfigSecretsForStorage(config), null, 2)
  );

  const proxyProc = spawn(process.execPath, [path.join(__dirname, '..', 'openai-proxy.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...testEnv,
      MGMT_PORT: String(managementPort),
      PROXY_DISABLE_CONVERSATION_AUDIT: '1',
    },
  });

  try {
    await waitForProxy(proxyProc);

    upstreamHits = 0;
    const missing = await requestProxy(entryPort);
    assert.strictEqual(missing.statusCode, 401);
    assert.strictEqual(upstreamHits, 0);

    const missingHealth = await requestProxy(entryPort, {}, { method: 'GET' });
    assert.strictEqual(missingHealth.statusCode, 401);
    assert.strictEqual(upstreamHits, 0);

    const wrong = await requestProxy(entryPort, { authorization: 'Bearer wrong-entry-key' });
    assert.strictEqual(wrong.statusCode, 401);
    assert.strictEqual(upstreamHits, 0);

    const browserOrigin = await requestProxy(entryPort, {
      authorization: 'Bearer entry-secret',
      origin: 'https://evil.example',
    });
    assert.strictEqual(browserOrigin.statusCode, 403);
    assert.strictEqual(upstreamHits, 0);

    // Regression: a bare '/metrics' route used to be dispatched by the local
    // management router before entry authentication, so any entry listener
    // answered it with unauthenticated, CORS-open process metrics.
    const bareMetrics = await requestProxy(entryPort, {}, { method: 'GET', path: '/metrics' });
    assert.strictEqual(
      bareMetrics.statusCode,
      401,
      'bare /metrics must require entry authentication'
    );
    assert.doesNotMatch(bareMetrics.body, /process_resident_memory_bytes|proxy_requests_total/);
    // The old bug answered with Prometheus text/plain; the fixed path returns a
    // normal JSON entry-auth error instead of the metrics payload.
    assert.match(String(bareMetrics.headers['content-type'] || ''), /application\/json/);
    assert.match(bareMetrics.body, /authentication_error/);

    const tokenProtectedMetrics = await requestProxy(
      entryPort,
      {},
      { method: 'GET', path: '/v1/local/metrics' }
    );
    assert.strictEqual(
      tokenProtectedMetrics.statusCode,
      401,
      'management metrics must require the management token'
    );

    const publicHealth = await requestProxy(
      entryPort,
      {},
      { method: 'GET', path: '/v1/local/health' }
    );
    assert.strictEqual(
      publicHealth.statusCode,
      200,
      'the local health probe must stay publicly reachable for the UI'
    );

    const okHealth = await requestProxy(
      entryPort,
      { authorization: 'Bearer entry-secret' },
      { method: 'GET' }
    );
    assert.strictEqual(okHealth.statusCode, 200);
    assert.strictEqual(upstreamHits, 0);

    const ok = await requestProxy(entryPort, { authorization: 'Bearer entry-secret' });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(upstreamHits, 1);
    assert.strictEqual(receivedHeaders.authorization, 'Bearer real-upstream-key');
    assert.notStrictEqual(receivedHeaders.authorization, 'Bearer entry-secret');
    assert.strictEqual(receivedHeaders['x-api-key'], undefined);

    console.log('[entry-auth-integration.test] ok');
  } finally {
    await stopProcess(proxyProc);
    upstream.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
