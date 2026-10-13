'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady: ready } = require('./helpers/proxy-fixture-ready');
const { prepareProxyFixtureSecret } = require('./helpers/proxy-fixture-secret');

const event = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';
const message = {
  id: 'message',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: '你好' }],
};
const tool = {
  id: 'tool',
  type: 'function_call',
  call_id: 'call',
  name: 'probe',
  arguments: '{"ok":true}',
};
const received = [];
const receivedPaths = [];
const compacted = {
  id: 'compact-response',
  object: 'response.compaction',
  created_at: 1791676800,
  output: [
    {
      id: 'retained-user',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '保留完整约束🙂' }],
      future_message_field: { intact: true },
    },
    { type: 'future_provider_state', opaque: { untouched: ['中文🙂', 42] } },
    {
      id: 'native-checkpoint',
      type: 'compaction',
      encrypted_content: 'native-opaque-state-fixture',
      future_compaction_field: { intact: true },
    },
  ],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  future_response_field: { intact: true },
};
let cancelled;
let compactStarted;
const upstream = http.createServer((req, res) => {
  assert.equal(
    req.headers.authorization === 'Bearer fixture-upstream-key',
    true,
    'Synthetic persisted credential must decrypt before upstream dispatch'
  );
  let input = '';
  req.on('data', (chunk) => {
    input += chunk;
  });
  req.on('end', () => {
    const body = JSON.parse(input);
    received.push(body);
    receivedPaths.push(req.url);
    if (body.model === 'native-v2-transport-error') {
      req.socket.destroy();
      return;
    }
    if (body.model === 'native-v2-http-error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { type: 'upstream_error', message: 'synthetic native failure' } })
      );
      return;
    }
    if (body.model === 'native-v2-fixture' || body.model === 'native-v2-incomplete') {
      const checkpoint = compacted.output[2];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        event({
          type: 'response.created',
          response: { id: 'native-v2', status: 'in_progress', output: [] },
        })
      );
      res.write(event({ type: 'response.output_item.done', output_index: 0, item: checkpoint }));
      const complete = body.model === 'native-v2-fixture';
      res.end(
        event({
          type: complete ? 'response.completed' : 'response.incomplete',
          response: {
            id: 'native-v2',
            object: 'response',
            status: complete ? 'completed' : 'incomplete',
            output: [checkpoint],
            usage: compacted.usage,
            ...(complete ? {} : { incomplete_details: { reason: 'max_output_tokens' } }),
          },
        })
      );
      return;
    }
    if (req.url.split('?')[0] === '/backend-api/codex/responses/compact') {
      if (body.model === 'compact-http-error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { type: 'upstream_error', message: 'fixture compact error' } })
        );
        return;
      }
      if (body.model === 'compact-cancel') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"id":');
        res.once('close', () => cancelled?.());
        compactStarted?.();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      const invalid = {
        'compact-empty': { ...compacted, output: [] },
        'compact-incomplete': { ...compacted, status: 'incomplete' },
        'compact-duplicate': { ...compacted, output: [compacted.output[2], compacted.output[2]] },
        'compact-local': {
          ...compacted,
          output: [{ type: 'compaction', encrypted_content: 'hpm-local-compaction-v1:synthetic' }],
        },
      };
      const wire = JSON.stringify(invalid[body.model] || compacted, null, 2);
      res.end(body.model === 'compact-truncated' ? wire.slice(0, -1) : wire);
      return;
    }
    if (body.model === 'http-error') {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'fixture upstream error' },
        })
      );
      return;
    }
    res.writeHead(200);
    res.write(
      event({
        type: 'response.created',
        response: { id: 'response', object: 'response', status: 'in_progress', output: [] },
      })
    );
    if (body.model === 'cancel') {
      res.once('close', () => cancelled?.());
      return;
    }
    if (body.model === 'abort') {
      setImmediate(() => res.destroy());
      return;
    }
    res.write(event({ type: 'response.output_item.done', output_index: 0, item: message }));
    res.write(event({ type: 'response.output_item.done', output_index: 1, item: tool }));
    const status = body.model === 'incomplete' ? 'incomplete' : 'completed';
    res.end(
      event({
        type: 'response.' + status,
        response: {
          id: 'response',
          object: 'response',
          status,
          output: [],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      })
    );
  });
});

function request(
  port,
  body,
  { cancel = false, requestPath = '/v1/responses', headers = {}, onRequest, method = 'POST' } = {}
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer fixture-entry-key',
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          if (cancel) {
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers });
          } else text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        res.on('error', reject);
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('Fixture response deadline')));
    req.on('error', reject);
    onRequest?.(req);
    req.end(method === 'POST' ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined);
  });
}

async function main() {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const [entryPort, managementPort, chatPort, claudePort] = await findAvailablePorts(4);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-codex-contract-'));
  const env = createIsolatedTestEnv(process.env, dataDir);
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'fixture',
      localServer: {
        host: '127.0.0.1',
        listenPort: entryPort,
        managementPort,
        basePath: '/v1',
        protocol: 'openai-responses',
      },
      entryServers: [
        {
          host: '127.0.0.1',
          listenPort: chatPort,
          basePath: '/v1',
          protocol: 'openai-chat',
          tls: false,
          enabled: true,
        },
        {
          host: '127.0.0.1',
          listenPort: claudePort,
          basePath: '/v1',
          protocol: 'claude',
          tls: false,
          enabled: true,
        },
        {
          host: '127.0.0.1',
          listenPort: entryPort,
          basePath: '/v1',
          protocol: 'openai-responses',
          tls: false,
          enabled: true,
        },
      ],
      profiles: [
        {
          id: 'fixture',
          protocol: 'openai',
          api: 'openai-codex-responses',
          authMode: 'api-key',
          apiKey: prepareProxyFixtureSecret(env, 'fixture-upstream-key'),
          backupProfileId: 'backup',
          targetUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
        },
        {
          id: 'backup',
          protocol: 'openai',
          api: 'openai-codex-responses',
          targetUrl: `http://127.0.0.1:${upstream.address().port}/fallback`,
        },
        {
          id: 'unsupported',
          protocol: 'openai',
          api: 'openai-chat',
          targetUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        },
      ],
      modelRoutes: [
        { from: 'compact-rewrite', to: 'fixture-output', profileId: 'fixture' },
        { from: 'compact-forbidden', to: '*', profileId: 'backup' },
        { from: 'compact-unsupported', to: '*', profileId: 'unsupported' },
      ],
      entryAuth: {
        enabled: true,
        keys: [
          {
            id: 'fixture',
            key: prepareProxyFixtureSecret(env, 'fixture-entry-key'),
            enabled: true,
            allowedEntryProtocols: [],
            allowedProfileIds: ['fixture', 'unsupported'],
          },
        ],
      },
      appSettings: { forceResponseStreaming: false, conversationAuditEnabled: false },
    })
  );
  const storedConfig = fs.readFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    'utf8'
  );
  for (const secret of ['fixture-upstream-key', 'fixture-entry-key'])
    assert.equal(storedConfig.includes(secret), false, 'Fixture secrets must remain encrypted');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../openai-proxy.js')], {
    env: { ...env, MGMT_PORT: String(managementPort), PROXY_DISABLE_CONVERSATION_AUDIT: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  try {
    await ready(child);
    const initialHits = received.length;
    const nativeTrigger = { type: 'compaction_trigger' };
    const nativeHistory = [
      { role: 'developer', content: 'Keep policy intact' },
      { role: 'user', content: '完整历史🙂' },
      {
        type: 'compaction',
        encrypted_content: 'native-fixture-checkpoint',
        extra: { intact: true },
      },
      nativeTrigger,
    ];
    const unauthorizedNative = await request(
      entryPort,
      { model: 'fixture-output', input: nativeHistory },
      {
        requestPath: '/backend-api/codex/responses',
        headers: { authorization: '' },
      }
    );
    assert.equal(unauthorizedNative.status, 401);
    assert.equal(received.length, initialHits);
    for (const method of ['GET', 'HEAD', 'DELETE', 'PUT']) {
      const unsupportedAlias = await request(
        entryPort,
        {},
        { requestPath: '/backend-api/codex/responses', method }
      );
      assert.equal(unsupportedAlias.status, 404);
      assert.equal(received.length, initialHits);
    }
    for (const port of [chatPort, claudePort]) {
      const wrongEntry = await request(
        port,
        { model: 'fixture-output', input: nativeHistory },
        {
          requestPath: '/backend-api/codex/responses',
        }
      );
      assert.equal(wrongEntry.status, 404);
      assert.equal(received.length, initialHits);
    }
    const nativeAlias = await request(
      entryPort,
      { model: 'fixture-output', input: nativeHistory },
      {
        requestPath: '/backend-api/codex/responses?native=1',
      }
    );
    assert.equal(nativeAlias.status, 200);
    assert.equal(receivedPaths.at(-1), '/backend-api/codex/responses?native=1');
    assert.deepEqual(received.at(-1).input, nativeHistory);
    const v2Compact = await request(
      entryPort,
      { model: 'native-v2-fixture', input: nativeHistory, stream: true },
      {
        requestPath: '/backend-api/codex/responses',
      }
    );
    assert.equal(v2Compact.status, 200);
    const v2Frames = v2Compact.text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data:'))
      .map((frame) => JSON.parse(frame.slice(5).trim()));
    assert.deepEqual(
      v2Frames.find((frame) => frame.type === 'response.output_item.done').item,
      compacted.output[2]
    );
    assert.deepEqual(
      v2Frames.find((frame) => frame.type === 'response.completed').response.output,
      [compacted.output[2]]
    );
    assert.equal(receivedPaths.at(-1), '/backend-api/codex/responses');
    const v2Continue = await request(
      entryPort,
      {
        model: 'fixture-output',
        input: [compacted.output[2], { role: 'user', content: '继续工具轮🙂' }],
      },
      { requestPath: '/backend-api/codex/responses' }
    );
    assert.equal(v2Continue.status, 200);
    assert.deepEqual(received.at(-1).input[0], compacted.output[2]);
    const v2Incomplete = await request(
      entryPort,
      { model: 'native-v2-incomplete', input: nativeHistory, stream: true },
      {
        requestPath: '/backend-api/codex/responses',
      }
    );
    assert.match(v2Incomplete.text, /response\.incomplete/);
    assert.doesNotMatch(v2Incomplete.text, /response\.completed/);
    for (const state of [nativeTrigger, compacted.output[2]]) {
      const beforeFailure = received.length;
      const failure = await request(
        entryPort,
        { model: 'native-v2-http-error', input: [state], stream: true },
        {
          requestPath: '/backend-api/codex/responses',
        }
      );
      assert.equal(failure.status, 500);
      assert.equal(
        received.length,
        beforeFailure + 1,
        'native trigger/checkpoint cannot fail over to a different backend'
      );
      assert.equal(receivedPaths.at(-1), '/backend-api/codex/responses');
      const beforeTransportFailure = received.length;
      const transportFailure = await request(
        entryPort,
        {
          model: 'native-v2-transport-error',
          input: [state],
          stream: true,
        },
        { requestPath: '/backend-api/codex/responses' }
      );
      assert.equal(transportFailure.status, 502);
      assert.equal(
        received.length,
        beforeTransportFailure + 1,
        'a transmitted native checkpoint cannot be retried or switched after a connection reset'
      );
      assert.equal(receivedPaths.at(-1), '/backend-api/codex/responses');
    }
    const hitsAfterNativeFailures = received.length;
    for (const authorization of ['', 'Bearer wrong-fixture-key']) {
      const unauthorized = await request(
        entryPort,
        { model: 'fixture-output', input: 'history' },
        { requestPath: '/v1/responses/compact', headers: { authorization } }
      );
      assert.equal(unauthorized.status, 401);
    }
    const forbidden = await request(
      entryPort,
      { model: 'compact-forbidden', input: 'history' },
      { requestPath: '/v1/responses/compact' }
    );
    assert.equal(forbidden.status, 403);
    const unsupported = await request(
      entryPort,
      { model: 'compact-unsupported', input: 'history' },
      { requestPath: '/v1/responses/compact' }
    );
    assert.equal(unsupported.status, 501);
    assert.equal(
      received.length,
      hitsAfterNativeFailures,
      'authorization and capability failures must not contact upstream'
    );
    const compactResult = await request(
      entryPort,
      {
        model: 'fixture-output',
        instructions: '禁止执行外部命令',
        input: [{ role: 'user', content: '完整历史🙂', future_field: 42 }],
      },
      { requestPath: '/v1/responses/compact' }
    );
    assert.equal(compactResult.status, 200, 'standalone compact must reach its own endpoint');
    assert.match(compactResult.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(compactResult.text), compacted);
    assert.equal(receivedPaths.at(-1), '/backend-api/codex/responses/compact');
    assert.equal(Object.hasOwn(received.at(-1), 'stream'), false);
    assert.equal(Object.hasOwn(received.at(-1), 'store'), false);
    assert.equal(Object.hasOwn(received.at(-1), 'context_management'), false);
    assert.equal(received.at(-1).instructions, '禁止执行外部命令');
    assert.deepEqual(received.at(-1).input, [
      { role: 'user', content: '完整历史🙂', future_field: 42 },
    ]);
    const nextInput = [...JSON.parse(compactResult.text).output, { role: 'user', content: '继续' }];
    const continuation = await request(entryPort, { model: 'fixture-output', input: nextInput });
    assert.equal(continuation.status, 200);
    assert.deepEqual(
      received.at(-1).input,
      nextInput,
      'entire canonical output survives continuation'
    );
    const emptyCompact = await request(
      entryPort,
      { model: 'compact-empty', input: 'history' },
      { requestPath: '/v1/responses/compact' }
    );
    assert.equal(emptyCompact.status, 502);
    assert.equal(JSON.parse(emptyCompact.text).error.code, 'upstream_invalid_compaction');
    for (const model of [
      'compact-incomplete',
      'compact-duplicate',
      'compact-local',
      'compact-truncated',
    ]) {
      const invalid = await request(
        entryPort,
        { model, input: 'history' },
        { requestPath: '/v1/responses/compact' }
      );
      assert.equal(invalid.status, 502);
      assert.equal(JSON.parse(invalid.text).error.code, 'upstream_invalid_compaction');
      assert.equal(invalid.text.includes('native-opaque-state-fixture'), false);
    }
    const hitsBeforeFailure = received.length;
    const compactError = await request(
      entryPort,
      { model: 'compact-http-error', input: 'history' },
      { requestPath: '/v1/responses/compact' }
    );
    assert.equal(compactError.status, 500);
    assert.equal(
      received.length,
      hitsBeforeFailure + 1,
      'native checkpoints must not fail over to a different endpoint'
    );
    assert.equal(receivedPaths.at(-1), '/backend-api/codex/responses/compact');
    const hitsBeforeInvalid = received.length;
    const invalidUtf8 = Buffer.from(
      JSON.stringify({ model: 'compact-rewrite', input: 'history🙂' })
    );
    invalidUtf8[invalidUtf8.indexOf(Buffer.from('🙂'))] = 255;
    const rejectedUtf8 = await request(entryPort, invalidUtf8, {
      requestPath: '/v1/responses/compact',
    });
    assert.equal(rejectedUtf8.status, 400);
    assert.equal(JSON.parse(rejectedUtf8.text).error.code, 'invalid_request_error');
    assert.equal(received.length, hitsBeforeInvalid);
    for (const options of [
      { stream: true },
      { store: true },
      { input: [] },
      { previous_response_id: 'resp_secret' },
      { context_management: [] },
    ]) {
      const invalid = await request(
        entryPort,
        { model: 'fixture-output', input: 'history', ...options },
        { requestPath: '/v1/responses/compact' }
      );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.text.includes('resp_secret'), false);
    }
    assert.equal(received.length, hitsBeforeInvalid);
    const compactAlias = await request(
      entryPort,
      { model: 'fixture-output', input: 'history', stream: false, store: false },
      { requestPath: '/responses/compact?fixture=1' }
    );
    assert.equal(compactAlias.status, 200);
    assert.deepEqual(JSON.parse(compactAlias.text), compacted);
    assert.equal(receivedPaths.at(-1), '/backend-api/codex/responses/compact?fixture=1');
    assert.equal(
      fs.existsSync(path.join(env.PROXY_RUNTIME_DIR, '.responses_history.cache.json')),
      false
    );
    let compactRequest;
    let compactDeadline;
    const compactClosed = new Promise((resolve, reject) => {
      cancelled = resolve;
      compactDeadline = setTimeout(
        () => reject(new Error('Fixture compact cancellation deadline')),
        5000
      );
    });
    compactStarted = () => compactRequest.destroy(new Error('Fixture compact cancellation'));
    try {
      await Promise.all([
        assert.rejects(
          request(
            entryPort,
            { model: 'compact-cancel', input: 'history' },
            {
              requestPath: '/v1/responses/compact',
              onRequest: (req) => {
                compactRequest = req;
              },
            }
          ),
          /Fixture compact cancellation/
        ),
        compactClosed,
      ]);
    } finally {
      clearTimeout(compactDeadline);
      compactStarted = undefined;
      cancelled = undefined;
    }
    for (const stream of [undefined, false]) {
      const result = await request(entryPort, {
        model: 'fixture-output',
        input: 'hello',
        stream,
        max_output_tokens: 1024,
      });
      assert.equal(result.status, 200);
      assert.match(result.headers['content-type'], /^application\/json/);
      const response = JSON.parse(result.text);
      assert.deepEqual(response.output, [message, tool]);
      assert.equal(response.usage.total_tokens, 3);
      const wire = received.at(-1);
      assert.equal(wire.stream, true);
      assert.equal(wire.instructions, '');
      assert.equal(wire.store, false);
      assert.equal(wire.max_output_tokens, 1024);
      assert.deepEqual(wire.input, [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ]);
    }
    const streaming = await request(entryPort, {
      model: 'fixture-output',
      input: 'hello',
      stream: true,
    });
    assert.equal(streaming.status, 200);
    assert.match(streaming.headers['content-type'], /^text\/event-stream/);
    assert.ok(streaming.text.includes('response.completed'));
    const incomplete = await request(entryPort, { model: 'incomplete', input: 'hello' });
    assert.deepEqual(JSON.parse(incomplete.text).output, [message]);
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    };
    for (const [port, requestPath, body] of [
      [
        chatPort,
        '/v1/chat/completions',
        {
          model: 'fixture-output',
          messages: [{ role: 'user', content: 'hello' }],
          max_completion_tokens: 1024,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'probe', schema, strict: true },
          },
        },
      ],
      [
        claudePort,
        '/v1/messages',
        {
          model: 'fixture-output',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 1024,
          output_config: { format: { type: 'json_schema', schema } },
        },
      ],
    ]) {
      const result = await request(port, body, { requestPath });
      assert.equal(result.status, 200);
      const value = JSON.parse(result.text);
      if (port === chatPort) {
        assert.equal(value.choices[0].message.content, '你好');
        assert.equal(value.choices[0].message.tool_calls[0].function.name, 'probe');
        assert.equal(value.usage.total_tokens, 3);
      } else {
        assert.equal(value.content.find((item) => item.type === 'text').text, '你好');
        assert.equal(value.content.find((item) => item.type === 'tool_use').name, 'probe');
        assert.equal(value.usage.output_tokens, 2);
      }
      assert.equal(received.at(-1).max_output_tokens, 1024);
      assert.deepEqual(received.at(-1).text.format.schema, schema);
      const before = received.length;
      for (const option of [{ temperature: 0.5 }, { top_p: 0.9 }]) {
        const invalid = await request(port, { ...body, ...option }, { requestPath });
        assert.equal(invalid.status, 400);
      }
      assert.equal(received.length, before);
    }
    const failure = await request(entryPort, { model: 'http-error', input: 'hello' });
    assert.equal(failure.status, 400);
    assert.ok(!String(failure.headers['content-type']).includes('event-stream'));
    assert.equal(JSON.parse(failure.text).error.message, 'fixture upstream error');
    const aborted = await request(entryPort, { model: 'abort', input: 'hello' });
    assert.equal(aborted.status, 502);
    assert.ok(!JSON.parse(aborted.text).output);
    const before = received.length;
    for (const body of [
      { input: 1 },
      { stream: 'true' },
      { instructions: {} },
      { store: true },
      { input: [], previous_response_id: 'resp_sensitive' },
      { input: [], previous_response_id: {} },
      { max_output_tokens: 0 },
    ]) {
      const invalid = await request(entryPort, { model: 'fixture-output', ...body });
      assert.equal(invalid.status, 400);
      assert.equal(JSON.parse(invalid.text).error.type, 'invalid_request_error');
      assert.equal(invalid.text.includes('sensitive'), false);
    }
    assert.equal(received.length, before);
    let deadline;
    const closed = new Promise((resolve, reject) => {
      cancelled = resolve;
      deadline = setTimeout(
        () => reject(new Error('Fixture upstream cancellation deadline')),
        5000
      );
    });
    await request(entryPort, { model: 'cancel', input: 'hello', stream: true }, { cancel: true });
    try {
      await closed;
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    if (child.exitCode == null && child.signalCode == null) {
      child.kill();
      await stopped;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(dataDir), os.tmpdir());
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  process.stderr.write(String(error.stack) + '\n');
  process.exitCode = 1;
});
