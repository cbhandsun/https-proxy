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
const { waitForProxyFixtureReady: ready } = require('./helpers/proxy-fixture-ready');
const { prepareProxyFixtureSecret } = require('./helpers/proxy-fixture-secret');
const { waitForFixtureEventFlush } = require('./helpers/proxy-fixture-events');
const sse = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';
const chunk = (content, finish_reason = null) => ({
  choices: [{ index: 0, delta: content == null ? {} : { content }, finish_reason }],
});
function request(port, body, headers = {}, onPartial) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': bytes.length, ...headers },
      },
      (res) => {
        let wire = '';
        res.on('data', (data) => {
          wire += data;
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            wire,
            body: String(res.headers['content-type']).includes('text/event-stream')
              ? null
              : JSON.parse(wire),
          })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Direct fixture request deadline')));
    if (onPartial) {
      req.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      onPartial().then(() => req.end(bytes.subarray(Math.floor(bytes.length / 2))), reject);
    } else req.end(bytes);
  });
}
async function main() {
  let partialObserved;
  const upstream = http.createServer((req, res) => {
    assert.equal(
      req.headers.authorization === 'Bearer fixture',
      true,
      'Synthetic persisted credential must decrypt before upstream dispatch'
    );
    let body = '';
    const early = req.headers['x-fixture-early'] === '1';
    let sentEarly = false;
    req.on('error', () => {});
    req.on('data', (data) => {
      body += data;
      partialObserved?.();
      partialObserved = undefined;
      if (early && !sentEarly) {
        sentEarly = true;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse(chunk('{}')));
      }
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end('{}');
        return;
      }
      const content = parsed.messages?.[0]?.content === 'valid' ? '{}' : '   ';
      if (early) {
        res.end(sse(chunk(null, 'stop')) + 'data: [DONE]\n\n');
        return;
      }
      if (parsed.stream || req.headers['x-fixture-force-sse'] === '1') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(chunk(content)) + sse(chunk(null, 'stop')) + 'data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'chat.completion',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          })
        );
      }
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-direct-contract-'));
  const env = createIsolatedTestEnv(process.env, directory);
  const [port, managementPort] = await findAvailablePorts(2);
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  // Direct-upload eligibility requires no model routing. Isolate that supported
  // runtime shape from automatically inserted built-in provider routes.
  const preload = path.join(directory, 'direct-fixture.cjs');
  fs.writeFileSync(
    preload,
    'require(' +
      JSON.stringify(path.resolve('lib/proxy/builtin-model-routes.js')) +
      ').mergeBuiltinModelRoutes = (config) => config;\n' +
      'require(' +
      JSON.stringify(path.resolve('test/helpers/proxy-fixture-events.js')) +
      ').installFixtureEventFlush(require(' +
      JSON.stringify(path.resolve('lib/proxy/diagnostics.js')) +
      '));'
  );
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'direct_fixture',
      profiles: [
        {
          id: 'direct_fixture',
          protocol: 'openai',
          targetUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          apiKey: prepareProxyFixtureSecret(env, 'fixture'),
          authMode: 'api-key',
        },
      ],
      modelRoutes: [],
      localServer: {
        host: '127.0.0.1',
        listenPort: port,
        managementPort,
        basePath: '/v1',
        protocol: 'openai-chat',
      },
      entryServers: [
        { host: '127.0.0.1', listenPort: port, protocol: 'openai-chat', enabled: true, tls: false },
      ],
      appSettings: { conversationAuditEnabled: false, streamDirectRequestBodies: true },
      diagnostics: { enabled: false },
    })
  );
  const child = spawn(process.execPath, ['--require', preload, 'openai-proxy.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stderr.resume();
  try {
    await ready(child);
    let uploaded = false;
    const partial = new Promise((resolve) => {
      partialObserved = () => {
        uploaded = true;
        resolve();
      };
    });
    const plain = await request(
      port,
      { model: 'fixture', messages: [{ role: 'user', content: 'valid' }], stream: false },
      {},
      () => partial
    );
    assert.equal(uploaded, true, 'Upstream must receive bytes before the client ends its upload');
    assert.equal(plain.status, 200);
    for (const stream of [false, true]) {
      for (const valid of [false, true]) {
        const result = await request(port, {
          model: 'fixture',
          messages: [{ role: 'user', content: valid ? 'valid' : 'invalid' }],
          stream,
          response_format: { type: 'json_object' },
        });
        assert.equal(result.status, valid || stream ? 200 : 502);
        if (!stream && valid) assert.equal(result.body.choices[0].message.content, '{}');
        if (!stream && !valid) assert.equal(result.body.error.code, 'upstream_invalid_json_object');
        if (stream && !valid)
          assert.equal(result.wire.includes('upstream_invalid_json_object'), true);
        if (stream && valid) assert.equal(result.wire.includes('"finish_reason":"stop"'), true);
      }
    }
    const early = await request(
      port,
      {
        model: 'fixture',
        messages: [{ role: 'user', content: 'valid' }],
        stream: true,
        response_format: { type: 'json_object' },
      },
      { 'x-fixture-early': '1' }
    );
    assert.equal(early.status, 200);
    assert.equal(early.wire.includes('"content":"{}"'), true);
    assert.equal(early.wire.includes('upstream_invalid_json_object'), false);
    const collapsed = await request(
      port,
      {
        model: 'fixture',
        messages: [{ role: 'user', content: 'valid' }],
        stream: false,
        response_format: { type: 'json_object' },
      },
      { 'x-fixture-force-sse': '1' }
    );
    assert.equal(collapsed.status, 200);
    assert.equal(collapsed.body.choices[0].message.content, '{}');
    const malformed = await request(port, 'SECRET');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.wire.includes('SECRET'), false);
    await waitForFixtureEventFlush(child);
    const events = fs
      .readFileSync(path.join(env.PROXY_RUNTIME_DIR, 'proxy-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((event) => event.type === 'openai_direct_stream'),
      'Plain request must use direct upload path'
    );
    assert.ok(
      events.some((event) => event.type === 'direct_json_object_validated'),
      'JSON requests must use direct contract path'
    );
    assert.ok(
      events.some((event) => event.type === 'direct_json_object_output_error'),
      'Invalid JSON must be recorded as failure'
    );
  } finally {
    const exited = child.exitCode === null ? once(child, 'exit') : null;
    if (exited) child.kill();
    if (exited) await exited;
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}
main()
  .then(() => console.log('direct-request-contract-routes.test.js passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
