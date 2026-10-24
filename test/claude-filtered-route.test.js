'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { gzipSync, gunzipSync } = require('node:zlib');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');
const { prepareProxyFixtureSecret } = require('./helpers/proxy-fixture-secret');
const frame = (type, data = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
function request(port, model, tools, gzip = false) {
  return new Promise((resolve, reject) => {
    const json = Buffer.from(
      JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'synthetic' }],
        max_tokens: 128,
        stream: true,
        ...(tools === undefined ? {} : { tools }),
      })
    );
    const body = gzip ? gzipSync(json) : json;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Fixture deadline')));
    req.end(body);
  });
}
async function main() {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const { model } = JSON.parse(
        req.headers['content-encoding'] === 'gzip'
          ? gunzipSync(bytes, { maxOutputLength: 1024 * 1024 }).toString('utf8')
          : bytes.toString('utf8')
      );
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        frame('message_start', {
          message: {
            id: 'synthetic',
            role: 'assistant',
            model,
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        })
      );
      res.write(
        frame('content_block_start', {
          index: 0,
          content_block: { type: 'tool_use', id: 'synthetic-tool', name: 'lookup', input: {} },
        })
      );
      res.write(
        frame('content_block_delta', {
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json:
              model === 'malformed'
                ? '{"private-content":'
                : model.endsWith('-empty')
                  ? '{}'
                  : '{"q":"synthetic"}',
          },
        })
      );
      if (model !== 'unclosed') res.write(frame('content_block_stop', { index: 0 }));
      if (model !== 'missing-terminal')
        res.write(
          frame('message_delta', {
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 1 },
          }) + frame('message_stop')
        );
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-claude-native-filter-'));
  const env = createIsolatedTestEnv(process.env, directory);
  const [port, managementPort] = await findAvailablePorts(2);
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'claude_filter_fixture',
      profiles: [
        {
          id: 'claude_filter_fixture',
          protocol: 'claude',
          targetUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
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
        protocol: 'claude',
      },
      entryServers: [
        { host: '127.0.0.1', listenPort: port, protocol: 'claude', enabled: true, tls: false },
      ],
      appSettings: { conversationAuditEnabled: false },
      diagnostics: { enabled: false },
    })
  );
  const child = spawn(process.execPath, ['openai-proxy.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  try {
    await waitForProxyFixtureReady(child);
    for (const model of ['valid', 'malformed', 'unclosed', 'missing-terminal']) {
      const result = await request(port, model);
      assert.equal(result.status, 200);
      if (model === 'valid') {
        assert.ok(result.text.includes('"type":"tool_use"'));
        assert.ok(result.text.includes('event: message_stop'));
      } else {
        assert.ok(result.text.includes('event: error'));
        assert.ok(!result.text.includes('"type":"tool_use"'));
        assert.ok(!result.text.includes('event: message_stop'));
        assert.ok(!result.text.includes('private-content'));
      }
      assert.equal(child.exitCode, null, 'Malformed native frames must not crash proxy');
    }
    const declared = [
      {
        name: 'lookup',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ];
    const empty = await request(port, 'declared-empty', declared);
    assert.equal(empty.status, 200);
    assert.ok(
      empty.text.includes('"type":"tool_use"'),
      'declared empty arguments must remain a tool call'
    );
    assert.ok(empty.text.includes('event: message_stop'));
    const compressed = await request(port, 'compressed-empty', declared, true);
    assert.equal(compressed.status, 200);
    assert.ok(compressed.text.includes('"type":"tool_use"'));
    assert.ok(compressed.text.includes('event: message_stop'));
    const unrelated = await request(port, 'unrelated-repair', [
      {
        name: 'exec',
        input_schema: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
        },
      },
    ]);
    assert.ok(unrelated.text.includes('"name":"lookup"'));
    assert.ok(
      !unrelated.text.includes('"name":"exec"'),
      'native declarations must not enable cross-tool exec repair'
    );
    for (const [model, tools] of [
      ['undeclared-empty', [{ name: 'other', input_schema: { type: 'object' } }]],
      ['required-empty', [{ name: 'lookup', input_schema: { type: 'object', required: ['q'] } }]],
      ['subsequent-empty', undefined],
    ]) {
      const result = await request(port, model, tools);
      assert.equal(result.status, 200);
      assert.ok(
        !result.text.includes('"type":"tool_use"'),
        'invalid or cross-request tool authority must not pass'
      );
      assert.ok(result.text.includes('event: message_stop'));
    }
    // The bounded JSONL writer is asynchronous; wait for persisted records rather
    // than assuming that socket end also completed filesystem append operations.
    let endings = [];
    const deadline = Date.now() + 2000;
    do {
      const text = fs.readFileSync(path.join(env.PROXY_RUNTIME_DIR, 'proxy-events.jsonl'), 'utf8');
      endings = text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.kind === 'request_end' && entry.path.endsWith('/messages'));
      if (endings.length >= 10) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(endings.length, 10, 'Each request must have one terminal log');
    assert.equal(new Set(endings.map((entry) => entry.reqId)).size, 10);
    assert.deepEqual(
      endings.map((entry) => entry.statusCode).sort(),
      [200, 200, 200, 200, 200, 200, 200, 502, 502, 502]
    );
    assert.ok(!JSON.stringify(endings).includes('private-content'));
  } finally {
    const exited = child.exitCode === null ? once(child, 'exit') : null;
    if (exited) child.kill();
    if (exited) await exited;
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}
main()
  .then(() => console.log('claude-filtered-route regressions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
