const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const {
  prepareEncryptedProxyFixtureConfig,
} = require('./helpers/encrypted-proxy-fixture-config.cjs');
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
  prepareEncryptedProxyFixtureConfig(config, testEnv);

  const proxyProc = spawn(process.execPath, [path.join(__dirname, '..', 'openai-proxy.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...testEnv,
      MGMT_PORT: String(managementPort),
      MGMT_TOKEN: 'synthetic-clear-management-token',
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

    const clearPath = '/v1/local/context-recovery/clear';
    const clearOptions = { method: 'POST', path: clearPath, body: '{"confirm":true}' };
    for (const headers of [{}, { authorization: 'Bearer entry-secret' }]) {
      assert.strictEqual((await requestProxy(entryPort, headers, clearOptions)).statusCode, 401);
    }
    assert.strictEqual(
      (
        await requestProxy(
          entryPort,
          {
            'x-mgmt-token': 'synthetic-clear-management-token',
            origin: 'https://evil.example',
          },
          clearOptions
        )
      ).statusCode,
      403
    );
    const clear = await requestProxy(
      entryPort,
      {
        'x-mgmt-token': 'synthetic-clear-management-token',
      },
      clearOptions
    );
    assert.strictEqual(clear.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(clear.body), { ok: true, scope: 'proxy_context_recovery' });
    const operationPath = '/v1/local/context-recovery/clear-operations';
    const managementHeaders = { 'x-mgmt-token': 'synthetic-clear-management-token' };
    for (const options of [
      { method: 'GET', path: '/v1/local/context-policy/preview' },
      { method: 'POST', path: '/v1/local/context-policy/apply', body: '{}' },
      { method: 'POST', path: operationPath, body: '{}' },
      { method: 'POST', path: operationPath + '/start', body: '{}' },
      { method: 'POST', path: operationPath + '/cancel', body: '{}' },
      { method: 'GET', path: operationPath + '?operationId=11111111-1111-4111-8111-111111111111' },
    ]) {
      for (const headers of [{}, { authorization: 'Bearer entry-secret' }]) {
        assert.strictEqual((await requestProxy(entryPort, headers, options)).statusCode, 401);
      }
      assert.strictEqual(
        (
          await requestProxy(
            entryPort,
            { ...managementHeaders, origin: 'https://evil.example' },
            options
          )
        ).statusCode,
        403
      );
    }
    const prepared = await requestProxy(entryPort, managementHeaders, {
      method: 'POST',
      path: operationPath,
      body: '{}',
    });
    assert.strictEqual(prepared.statusCode, 202);
    const operation = JSON.parse(prepared.body);
    assert.strictEqual(operation.state, 'prepared');
    assert.match(operation.operationId, /^[0-9a-f-]{36}$/);
    const startOptions = {
      method: 'POST',
      path: operationPath + '/start',
      body: JSON.stringify({ confirm: true, operationId: operation.operationId }),
    };
    assert.strictEqual(
      (await requestProxy(entryPort, managementHeaders, startOptions)).statusCode,
      202
    );
    const queryOptions = {
      method: 'GET',
      path: operationPath + '?operationId=' + operation.operationId,
    };
    let terminal;
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await requestProxy(entryPort, managementHeaders, queryOptions);
      assert.strictEqual(response.statusCode, 200);
      terminal = JSON.parse(response.body);
      if (terminal.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.strictEqual(terminal.state, 'succeeded');
    assert.deepStrictEqual(
      JSON.parse((await requestProxy(entryPort, managementHeaders, startOptions)).body),
      terminal
    );
    assert.strictEqual(upstreamHits, 0, 'clear must never contact the model or replay a tool');

    const unused = await requestProxy(entryPort, managementHeaders, {
      method: 'POST',
      path: operationPath,
      body: '{}',
    });
    assert.strictEqual(unused.statusCode, 202);
    const unusedOperation = JSON.parse(unused.body);
    const cancelBody = JSON.stringify({ confirm: true, operationId: unusedOperation.operationId });
    const cancelled = await requestProxy(entryPort, managementHeaders, {
      method: 'POST',
      path: operationPath + '/cancel',
      body: cancelBody,
    });
    assert.strictEqual(cancelled.statusCode, 202);
    assert.strictEqual(JSON.parse(cancelled.body).state, 'cancelled');
    const delayed = await requestProxy(entryPort, managementHeaders, {
      method: 'POST',
      path: operationPath + '/start',
      body: cancelBody,
    });
    assert.strictEqual(delayed.statusCode, 202);
    assert.deepStrictEqual(JSON.parse(delayed.body), JSON.parse(cancelled.body));
    assert.strictEqual(upstreamHits, 0);

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
    assert.strictEqual(
      JSON.parse(publicHealth.body).contextRecovery.policy.runtimeApplication,
      'matched'
    );
    assert.strictEqual(
      JSON.parse(publicHealth.body).contextRecovery.policy.appliedPolicy,
      'legacy'
    );

    const okHealth = await requestProxy(
      entryPort,
      { authorization: 'Bearer entry-secret' },
      { method: 'GET' }
    );
    assert.strictEqual(okHealth.statusCode, 200);
    assert.strictEqual(upstreamHits, 0);

    const policyPreview = await requestProxy(entryPort, managementHeaders, {
      method: 'GET',
      path: '/v1/local/context-policy/preview',
    });
    assert.strictEqual(policyPreview.statusCode, 200);
    const policy = JSON.parse(policyPreview.body);
    assert.strictEqual(policy.migrationRequired, true);
    assert.doesNotMatch(policyPreview.body, /real-upstream-key|entry-secret/);
    const policyApply = await requestProxy(entryPort, managementHeaders, {
      method: 'POST',
      path: '/v1/local/context-policy/apply',
      body: JSON.stringify({ confirm: true, revision: policy.revision, targetVersion: 2 }),
    });
    assert.strictEqual(policyApply.statusCode, 200);
    assert.strictEqual(JSON.parse(policyApply.body).runtimeApplication, 'pending');
    const savedPolicy = await requestProxy(entryPort, managementHeaders, {
      method: 'GET',
      path: '/v1/local/config',
    });
    assert.strictEqual(JSON.parse(savedPolicy.body).appSettings.contextPolicyVersion, 2);
    let appliedPolicy;
    const policyDeadline = Date.now() + 5000;
    do {
      const health = await requestProxy(entryPort, {}, { method: 'GET', path: '/v1/local/health' });
      appliedPolicy = JSON.parse(health.body).contextRecovery.policy;
      if (appliedPolicy.version === 2 && appliedPolicy.runtimeApplication === 'matched') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < policyDeadline);
    assert.strictEqual(appliedPolicy.appliedVersion, 2);
    assert.strictEqual(appliedPolicy.appliedPolicy, 'native-first');
    assert.strictEqual(appliedPolicy.runtimeApplication, 'matched');
    assert.strictEqual(appliedPolicy.plannerApplication, 'unverified');

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
