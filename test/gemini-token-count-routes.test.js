'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');
const { prepareProxyFixtureSecret } = require('./helpers/proxy-fixture-secret');
const { createProxyFixtureHealthProbe } = require('./helpers/proxy-fixture-health');
const { waitForFixtureEventFlush } = require('./helpers/proxy-fixture-events');

function request(port, model) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ model, input: 'one two three' }));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/responses/input_tokens',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Fixture request deadline')));
    req.end(body);
  });
}

async function main() {
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamRequests.push({
        path: req.url,
        key: req.headers['x-goog-api-key'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      if (req.url.includes('exact-error')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'private fixture error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ totalTokens: 91, cachedContentTokenCount: 17 }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-gemini-count-routes-'));
  const env = createIsolatedTestEnv(process.env, directory);
  const managementToken = randomUUID();
  const [port, managementPort] = await findAvailablePorts(2);
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  const preload = path.join(directory, 'native-gemini-fixture.cjs');
  const credentialReadMarker = path.join(directory, 'unexpected-credential-read');
  fs.writeFileSync(
    preload,
    [
      'const capabilities = require(' +
        JSON.stringify(path.resolve('lib/proxy/gemini-context-management.js')) +
        ');',
      "capabilities.isNativeGeminiDeveloperTarget = (profile) => profile?.id === 'gemini-native';",
      'require(' +
        JSON.stringify(path.resolve('lib/proxy/builtin-model-routes.js')) +
        ').mergeBuiltinModelRoutes = (config) => config;',
      'require(' +
        JSON.stringify(path.resolve('lib/proxy/google-official.js')) +
        ').readAntigravityOfficialCredentialState = () => { require("node:fs").writeFileSync(' +
        JSON.stringify(credentialReadMarker) +
        ', "unexpected"); throw new Error("Fixture must not read real credentials"); };',
      'require(' +
        JSON.stringify(path.resolve('test/helpers/proxy-fixture-events.js')) +
        ').installFixtureEventFlush(require(' +
        JSON.stringify(path.resolve('lib/proxy/diagnostics.js')) +
        '));',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'gemini-compatible',
      profiles: [
        {
          id: 'gemini-native',
          protocol: 'gemini',
          targetUrl: `http://127.0.0.1:${upstream.address().port}/v1beta`,
          apiKey: prepareProxyFixtureSecret(env, 'fixture-gemini-key'),
          authMode: 'api-key',
        },
        {
          id: 'gemini-compatible',
          protocol: 'gemini',
          targetUrl: `http://127.0.0.1:${upstream.address().port}/v1beta`,
          apiKey: prepareProxyFixtureSecret(env, 'fixture-compatible-key'),
          authMode: 'api-key',
        },
        {
          id: 'gemini-code-assist',
          protocol: 'gemini',
          targetUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
          authMode: 'official-login',
          authProvider: 'google',
        },
      ],
      modelRoutes: [
        { from: 'exact-*', to: '*', profileId: 'gemini-native', enabled: true },
        { from: 'compatible-*', to: '*', profileId: 'gemini-compatible', enabled: true },
        { from: 'code-assist-*', to: '*', profileId: 'gemini-code-assist', enabled: true },
      ],
      localServer: {
        host: '127.0.0.1',
        listenPort: port,
        managementPort,
        basePath: '/v1',
        protocol: 'openai-responses',
      },
      entryServers: [
        {
          host: '127.0.0.1',
          listenPort: port,
          protocol: 'openai-responses',
          enabled: true,
          tls: false,
        },
      ],
      appSettings: {
        conversationAuditEnabled: false,
        antigravityCredentialWatchdogEnabled: false,
      },
      diagnostics: { enabled: false },
    })
  );
  const child = spawn(process.execPath, ['--require', preload, 'openai-proxy.js'], {
    env: {
      ...env,
      MGMT_PORT: String(managementPort),
      MGMT_TOKEN: managementToken,
      PROXY_LOG_LEVEL: 'error',
      PROXY_DISABLE_CONVERSATION_AUDIT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stderr.resume();
  try {
    await waitForProxyFixtureReady(child, {
      probeReady: createProxyFixtureHealthProbe({
        port: managementPort,
        pid: child.pid,
        entryPort: port,
        token: managementToken,
      }),
    });
    const exact = await request(port, 'exact-model');
    assert.equal(exact.status, 200);
    assert.equal(exact.headers['x-hpm-token-count'], 'exact');
    assert.equal(exact.body.input_tokens, 91);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].key, 'fixture-gemini-key');
    assert.equal(upstreamRequests[0].path, '/v1beta/models/exact-model:countTokens');

    const degraded = await request(port, 'exact-error');
    assert.equal(degraded.status, 200);
    assert.equal(degraded.headers['x-hpm-token-count'], 'estimated');
    assert.equal(degraded.headers['x-hpm-token-count-reason'], 'upstream-server-error');
    assert.ok(degraded.body.input_tokens > 0);
    assert.equal(upstreamRequests.length, 2);

    const compatible = await request(port, 'compatible-model');
    assert.equal(compatible.status, 200);
    assert.equal(compatible.body.input_tokens > 0, true);
    assert.equal(compatible.headers['x-hpm-token-count'], undefined);
    assert.equal(upstreamRequests.length, 2, 'compatible endpoints must use local estimation');

    const codeAssist = await request(port, 'code-assist-model');
    assert.equal(codeAssist.status, 200);
    assert.equal(codeAssist.body.input_tokens > 0, true);
    assert.equal(upstreamRequests.length, 2, 'Code Assist must not call Developer API countTokens');

    await waitForFixtureEventFlush(child);
    const events = fs
      .readFileSync(path.join(env.PROXY_RUNTIME_DIR, 'proxy-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const exactEvent = events.find((event) => event.type === 'gemini_input_tokens_exact');
    const estimatedEvent = events.find((event) => event.type === 'gemini_input_tokens_estimated');
    assert.equal(exactEvent.exact, true);
    assert.equal(exactEvent.cachedInputTokens, 17);
    assert.equal(estimatedEvent.exact, false);
    assert.equal(estimatedEvent.reason, 'upstream-server-error');
    assert.equal(JSON.stringify(events).includes('private fixture error'), false);
    assert.equal(
      fs.existsSync(credentialReadMarker),
      false,
      'fixture must isolate real credentials'
    );
  } finally {
    const exited = child.exitCode === null ? once(child, 'exit') : null;
    if (exited) child.kill();
    if (exited) await exited;
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('[gemini-token-count-routes.test] ok'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
