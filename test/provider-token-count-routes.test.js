'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');
const { prepareProxyFixtureSecret } = require('./helpers/proxy-fixture-secret');

function request(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': bytes.length },
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
    req.end(bytes);
  });
}

async function main() {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ path: req.url, headers: req.headers, body });
      if (body.model === 'openai-client-error') {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture' } }));
        return;
      }
      if (req.url.endsWith('/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 73 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 61 }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-provider-count-routes-'));
  const env = createIsolatedTestEnv(process.env, directory);
  const [responsesPort, claudePort, managementPort] = await findAvailablePorts(3);
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  const preload = path.join(directory, 'native-provider-fixture.cjs');
  fs.writeFileSync(
    preload,
    [
      'require(' +
        JSON.stringify(path.resolve('lib/proxy/builtin-model-routes.js')) +
        ').mergeBuiltinModelRoutes = (config) => config;',
    ].join('\n')
  );
  const compatibleTargetUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'openai-compatible',
      profiles: [
        {
          id: 'openai-native',
          protocol: 'openai',
          targetUrl: 'http://api.openai.com/v1',
          apiKey: prepareProxyFixtureSecret(env, 'openai-secret'),
          authMode: 'api-key',
        },
        {
          id: 'openai-compatible',
          protocol: 'openai',
          targetUrl: compatibleTargetUrl,
          apiKey: prepareProxyFixtureSecret(env, 'compatible-secret'),
          authMode: 'api-key',
        },
        {
          id: 'claude-native',
          protocol: 'claude',
          targetUrl: 'http://api.anthropic.com/v1',
          apiKey: prepareProxyFixtureSecret(env, 'claude-secret'),
          authMode: 'api-key',
        },
        {
          id: 'claude-compatible',
          protocol: 'claude',
          targetUrl: compatibleTargetUrl,
          apiKey: prepareProxyFixtureSecret(env, 'claude-compatible-secret'),
          authMode: 'api-key',
        },
      ],
      modelRoutes: [
        { from: 'openai-*', to: '*', profileId: 'openai-native', enabled: true },
        { from: 'compatible-*', to: '*', profileId: 'openai-compatible', enabled: true },
        { from: 'claude-native-*', to: '*', profileId: 'claude-native', enabled: true },
        { from: 'claude-compatible-*', to: '*', profileId: 'claude-compatible', enabled: true },
      ],
      localServer: {
        host: '127.0.0.1',
        listenPort: responsesPort,
        managementPort,
        basePath: '/v1',
        protocol: 'openai-responses',
      },
      entryServers: [
        {
          host: '127.0.0.1',
          listenPort: responsesPort,
          protocol: 'openai-responses',
          enabled: true,
          tls: false,
        },
        {
          host: '127.0.0.1',
          listenPort: claudePort,
          protocol: 'claude',
          enabled: true,
          tls: false,
        },
      ],
      appSettings: { conversationAuditEnabled: false },
      diagnostics: { enabled: false },
    })
  );
  const child = spawn(process.execPath, ['--require', preload, 'openai-proxy.js'], {
    env: {
      ...env,
      MGMT_PORT: String(managementPort),
      PROXY_DISABLE_CONVERSATION_AUDIT: '1',
      TARGET: '127.0.0.1',
      TARGET_PORT: String(upstream.address().port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  try {
    await waitForProxyFixtureReady(child);

    const openai = await request(responsesPort, '/v1/responses/input_tokens', {
      model: 'openai-exact',
      input: 'hello',
    });
    assert.equal(openai.status, 200);
    assert.equal(openai.body.input_tokens, 61);
    assert.equal(received.length, 1);
    assert.equal(received[0].path, '/v1/responses/input_tokens');
    assert.equal(received[0].headers.authorization, 'Bearer openai-secret');

    const openaiFailure = await request(responsesPort, '/v1/responses/input_tokens', {
      model: 'openai-client-error',
      input: 'hello',
    });
    assert.equal(openaiFailure.status, 422);
    assert.equal(openaiFailure.body.error.type, 'invalid_request_error');
    assert.equal(
      received.length,
      2,
      'native 4xx must pass through instead of becoming an estimate'
    );

    const compatible = await request(responsesPort, '/v1/responses/input_tokens', {
      model: 'compatible-model',
      input: 'hello',
    });
    assert.equal(compatible.status, 200);
    assert.ok(compatible.body.input_tokens > 0);
    assert.equal(received.length, 2, 'OpenAI-compatible endpoints must use local estimation');

    const claude = await request(claudePort, '/v1/messages/count_tokens', {
      model: 'claude-native-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(claude.status, 200);
    assert.equal(claude.body.input_tokens, 73);
    assert.equal(received.length, 3);
    assert.equal(received[2].path, '/v1/messages/count_tokens');
    assert.equal(received[2].headers['x-api-key'], 'claude-secret');
    assert.match(received[2].headers['anthropic-beta'], /compact-2026-01-12/);
    assert.equal(received[2].body.context_management.edits[0].type, 'compact_20260112');

    const claudeCompatible = await request(claudePort, '/v1/messages/count_tokens', {
      model: 'claude-compatible-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(claudeCompatible.status, 200);
    assert.ok(claudeCompatible.body.input_tokens > 0);
    assert.equal(received.length, 3, 'Anthropic-compatible endpoints must use local estimation');

    const rejected = await request(claudePort, '/v1/messages/count_tokens_extra', {
      model: 'claude-native-model',
      messages: [],
    });
    assert.equal(rejected.status, 404);
    assert.equal(received.length, 3);
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
  .then(() => console.log('[provider-token-count-routes.test] ok'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
