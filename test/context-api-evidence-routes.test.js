'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { prepareProxyFixtureSecret } = require('./helpers/proxy-fixture-secret');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');
const {
  STARTUP_IMPORTS,
  STARTUP_CALLS,
  STARTUP_NESTED_IMPORTS,
} = require('./helpers/proxy-startup-imports.cjs');
const { decodeApiEvidenceResponse } = require('../lib/proxy/context-api-evidence-protocol');
const LIST = 'hpm_list_retained_evidence';
const READ = 'hpm_read_retained_evidence';
const sse = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
const rpc = (name, args = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

async function fixture(t, direct = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-api-evidence-'));
  const env = createIsolatedTestEnv(process.env, directory);
  for (const key of ['API_KEY', 'TARGET', 'TARGET_PORT', 'PROXY_ENTRY_KEYS', 'PORT', 'MGMT_PORT'])
    delete env[key];
  env.PROXY_DISABLE_CONVERSATION_AUDIT = '1';
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  const received = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const input = JSON.parse(body);
      received.push({
        path: req.url,
        body: input,
        evidenceHeader: req.headers['x-hpm-evidence-token'],
      });
      const id =
        req.headers['x-fixture-call'] ||
        (typeof input.messages?.[0]?.content === 'string' &&
          input.messages[0].content.match(/^fresh:(call_\d+)$/)?.[1]) ||
        'fixture_call';
      const kind = req.url.includes('/responses')
        ? 'responses'
        : req.url.includes('/messages')
          ? 'claude'
          : 'chat';
      const output =
        kind === 'responses'
          ? {
              object: 'response',
              id: 'resp_fixture',
              status: 'completed',
              output: [
                {
                  type: 'function_call',
                  id: 'fc_' + id,
                  call_id: id,
                  name: 'lookup',
                  arguments: '{}',
                },
              ],
              usage: { input_tokens: 10, output_tokens: 1 },
            }
          : kind === 'claude'
            ? {
                type: 'message',
                id: 'msg_fixture',
                role: 'assistant',
                model: 'fixture-claude',
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id, name: 'lookup', input: { q: 'fresh' } }],
                usage: { input_tokens: 10, output_tokens: 1 },
              }
            : {
                object: 'chat.completion',
                id: 'chat_fixture',
                choices: [
                  {
                    index: 0,
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        { type: 'function', id, function: { name: 'lookup', arguments: '{}' } },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 1 },
              };
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (kind === 'responses') res.end(sse({ type: 'response.completed', response: output }));
        else if (kind === 'chat')
          res.end(
            sse({
              choices: [
                { index: 0, delta: output.choices[0].message, finish_reason: 'tool_calls' },
              ],
            }) + 'data: [DONE]\n\n'
          );
        else
          res.end(
            [
              {
                type: 'message_start',
                message: {
                  role: 'assistant',
                  content: [],
                  id: output.id,
                  model: output.model,
                  usage: { input_tokens: 10, output_tokens: 0 },
                },
              },
              { type: 'content_block_start', index: 0, content_block: output.content[0] },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '{"q":"fresh"}' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: 'message_stop' },
            ]
              .map((event) => 'event: ' + event.type + '\n' + sse(event))
              .join('')
          );
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(output));
      }
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const [chat, responses, claude, managementPort] = await findAvailablePorts(4);
  const targetUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const fixtureKey = prepareProxyFixtureSecret(env, 'synthetic-upstream-key');
  const preload = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(
    preload,
    'process.stderr.write("fixture_preload_started\\n");\nrequire(' +
      JSON.stringify(path.resolve('test/helpers/proxy-startup-timing.cjs')) +
      ');\nrequire(' +
      JSON.stringify(path.resolve('lib/proxy/builtin-model-routes.js')) +
      ').mergeBuiltinModelRoutes = (config) => config;\nprocess.stderr.write("fixture_catalog_loaded\\n");\n' +
      'const secrets = require(' +
      JSON.stringify(path.resolve('lib/proxy/secret-crypto.js')) +
      '); process.stderr.write("fixture_crypto_loaded\\n"); const encrypt = secrets.encryptKey; secrets.encryptKey = (...args) => {' +
      'process.stderr.write("fixture_secret_migration_started\\n");' +
      'try { return encrypt(...args); } finally {' +
      'process.stderr.write("fixture_secret_migration_finished\\n"); }};\n' +
      'const lifecycle = require(' +
      JSON.stringify(path.resolve('lib/proxy/server-lifecycle.js')) +
      '); process.stderr.write("fixture_lifecycle_loaded\\n"); const start = lifecycle.startProxyServers; lifecycle.startProxyServers = (deps) => start({' +
      '...deps, onPhase: (phase) => { process.stderr.write("fixture_phase_" + phase + "\\n"); deps.onPhase?.(phase); }});'
  );
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'openai-fixture',
      profiles: [
        {
          id: 'openai-fixture',
          name: 'Fixture',
          protocol: 'openai',
          targetUrl,
          apiKey: fixtureKey,
        },
        {
          id: 'claude-fixture',
          name: 'Fixture Claude',
          protocol: 'claude',
          targetUrl,
          apiKey: fixtureKey,
        },
      ],
      modelRoutes: direct
        ? []
        : [
            { from: 'fixture-chat', to: '*', profileId: 'openai-fixture', enabled: true },
            { from: 'fixture-responses', to: '*', profileId: 'openai-fixture', enabled: true },
            { from: 'fixture-claude', to: '*', profileId: 'claude-fixture', enabled: true },
          ],
      localServer: {
        host: '127.0.0.1',
        listenPort: chat,
        managementPort,
        basePath: '/v1',
        protocol: 'openai-chat',
      },
      entryServers: [
        { host: '127.0.0.1', listenPort: chat, protocol: 'openai-chat', tls: false },
        { host: '127.0.0.1', listenPort: responses, protocol: 'openai-responses', tls: false },
        { host: '127.0.0.1', listenPort: claude, protocol: 'claude', tls: false },
      ],
      entryAuth: {
        enabled: true,
        keys: [
          {
            id: 'owner-a',
            name: 'A',
            key: prepareProxyFixtureSecret(env, 'fixture-a'),
            enabled: true,
          },
          {
            id: 'owner-b',
            name: 'B',
            key: prepareProxyFixtureSecret(env, 'fixture-b'),
            enabled: true,
          },
        ],
      },
      claudeDesktop: { token: prepareProxyFixtureSecret(env, 'fixture-desktop') },
      appSettings: {
        contextEvidenceEnabled: true,
        conversationAuditEnabled: false,
        streamDirectRequestBodies: direct,
      },
      diagnostics: { enabled: false },
    })
  );
  const child = spawn(process.execPath, ['--require', preload, 'openai-proxy.js'], {
    cwd: path.resolve('.'),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const migrationPhases = new Set();
  const startupPhases = new Set();
  const started = performance.now();
  const timeline = [];
  const imports = new Map();
  const pendingImports = new Set();
  const calls = new Map();
  const pendingCalls = new Set();
  const importLabels = new Set([
    ...Object.values(STARTUP_IMPORTS),
    ...Object.values(STARTUP_NESTED_IMPORTS).flatMap(Object.values),
  ]);
  const callLabels = new Set(Object.values(STARTUP_CALLS).flatMap((value) => Object.values(value)));
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    const text = stderrTail + chunk.toString();
    for (const match of text.matchAll(
      /fixture_import_started_([a-z_]+)\n|fixture_import_([a-z_]+)=(\d+)\n/g
    )) {
      if (match[1] && importLabels.has(match[1])) pendingImports.add(match[1]);
      if (match[2] && importLabels.has(match[2])) {
        imports.set(match[2], Number(match[3]));
        pendingImports.delete(match[2]);
      }
    }
    for (const match of text.matchAll(
      /fixture_call_started_([a-z_]+)\n|fixture_call_([a-z_]+)=(\d+)\n/g
    )) {
      if (match[1] && callLabels.has(match[1])) pendingCalls.add(match[1]);
      if (match[2] && callLabels.has(match[2])) {
        calls.set(match[2], Number(match[3]));
        pendingCalls.delete(match[2]);
      }
    }
    for (const phase of ['fixture_secret_migration_started', 'fixture_secret_migration_finished'])
      if (text.includes(phase)) migrationPhases.add(phase);
    for (const phase of [
      'preload_started',
      'catalog_loaded',
      'crypto_loaded',
      'lifecycle_loaded',
      'module_graph_ready',
      'config_load_started',
      'config_loaded',
      'composition_ready',
      'server_start_requested',
      'certificate_ready',
      'servers_created',
      'management_token_ready',
      'management_listening',
      'ports_listening',
    ]) {
      if (
        (text.includes('fixture_phase_' + phase) || text.includes('fixture_' + phase + '\n')) &&
        !startupPhases.has(phase)
      ) {
        startupPhases.add(phase);
        timeline.push({ phase, elapsedMs: Math.floor(performance.now() - started) });
      }
    }
    stderrTail = text.slice(-96);
  });
  child.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('already in use')) startupPhases.add('port_conflict');
    if (chunk.toString().includes('Invalid proxy configuration'))
      startupPhases.add('invalid_config');
  });
  t.after(async () => {
    loop.disable();
    t.diagnostic(
      JSON.stringify({
        startup: timeline,
        imports: Object.fromEntries(imports),
        pendingImports: [...pendingImports],
        calls: Object.fromEntries(calls),
        pendingCalls: [...pendingCalls],
        eventLoopMaxMs: Math.floor(loop.max / 1e6),
      })
    );
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  try {
    await waitForProxyFixtureReady(child);
  } catch (error) {
    throw new Error(error.message + '; ' + [...migrationPhases, ...startupPhases].join(','), {
      cause: error,
    });
  }
  assert.equal(
    migrationPhases.size,
    0,
    'Protocol fixture must not invoke plaintext credential migration'
  );
  async function request(port, route, body, token, extra = {}) {
    const result = await fetch('http://127.0.0.1:' + port + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer fixture-a',
        ...(token ? { 'x-hpm-evidence-token': token } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
    const wire = await result.text();
    return {
      status: result.status,
      wire,
      body: result.headers.get('content-type')?.includes('event-stream') ? null : JSON.parse(wire),
    };
  }
  const firstRequestStarted = performance.now();
  const created = await request(chat, '/v1/context-evidence/session', {});
  t.diagnostic(
    JSON.stringify({ firstRequestMs: Math.floor(performance.now() - firstRequestStarted) })
  );
  assert.equal(created.status, 201);
  for (const phase of [
    'module_graph_ready',
    'config_load_started',
    'config_loaded',
    'composition_ready',
  ])
    assert.ok(startupPhases.has(phase), phase);
  assert.ok(Number.isSafeInteger(imports.get('lazy_core')));
  assert.ok(Number.isSafeInteger(imports.get('core_lazy_implementation')));
  async function read(name, args = {}, token = created.body.token, extra) {
    const result = await request(chat, '/v1/context-evidence/mcp', rpc(name, args), token, extra);
    assert.equal(result.status, 200);
    return JSON.parse(result.body.result.content[0].text);
  }
  return { chat, responses, claude, request, read, received, token: created.body.token };
}

test('actual isolated proxy captures Chat/Responses/Claude JSON and SSE, then serves exact evidence through generic MCP', async (t) => {
  const fixtureRuntime = await fixture(t);
  const { request, read, received, token } = fixtureRuntime;
  let counter = 0;
  for (const kind of ['chat', 'responses', 'claude']) {
    for (const stream of [false, true]) {
      const id = 'call_' + ++counter;
      const route =
        '/v1/' +
        (kind === 'chat' ? 'chat/completions' : kind === 'claude' ? 'messages' : 'responses');
      const port = fixtureRuntime[kind];
      const body =
        kind === 'responses'
          ? {
              model: 'fixture-responses',
              stream,
              input: [
                { role: 'user', content: 'fresh' },
                { type: 'compaction', encrypted_content: 'opaque-preserved' },
              ],
            }
          : {
              model: 'fixture-' + kind,
              stream,
              ...(kind === 'claude' ? { max_tokens: 32 } : {}),
              ...(kind === 'claude'
                ? { tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }] }
                : {}),
              messages: [{ role: 'user', content: 'fresh:' + id }],
            };
      const first = await request(port, route, body, token, { 'x-fixture-call': id });
      assert.equal(first.status, 200);
      assert.equal(
        decodeApiEvidenceResponse(kind, Buffer.from(first.wire), stream).length,
        1,
        'Fixture must send a completed client-visible call: ' + kind + '/' + stream
      );
      if (kind === 'claude' && !stream) {
        assert.equal(
          first.body.stop_reason,
          'tool_use',
          'Native completed tool-call reason must reach the client'
        );
        assert.equal(
          first.body.content[0]?.type,
          'tool_use',
          'Native tool call must reach the client'
        );
        assert.equal(first.body.content[0]?.id, id);
      }
      const original = 'fresh-detail-' + kind + '-' + stream + '-中文✅';
      const result =
        kind === 'responses'
          ? { type: 'function_call_output', call_id: id, output: original }
          : kind === 'chat'
            ? { role: 'tool', tool_call_id: id, content: original }
            : {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: id, content: original }],
              };
      const next =
        kind === 'responses'
          ? { ...body, input: [...body.input, result] }
          : {
              ...body,
              messages: [
                ...body.messages,
                ...(kind === 'claude'
                  ? [
                      {
                        role: 'assistant',
                        content: [{ type: 'tool_use', id, name: 'lookup', input: {} }],
                      },
                    ]
                  : []),
                result,
              ],
            };
      const second = await request(port, route, next, token, { 'x-fixture-call': id });
      assert.equal(second.status, 200);
      const listed = await read(LIST);
      assert.equal(listed.sources.length, counter);
      const receipt = listed.sources.at(-1);
      const page = await read(READ, { sourceId: receipt.sourceId, digest: receipt.digest });
      assert.equal(page.page.text, original);
      assert.equal(page.observation, 'client_reported');
      assert.equal(page.verification, 'not_verified');
      assert.deepEqual(
        received.at(-1).body,
        next,
        'Evidence layer must not rewrite native request/checkpoint bytes'
      );
      assert.equal(received.at(-1).evidenceHeader, undefined);
    }
  }
  assert.equal(
    received.length,
    12,
    'Reader requests must never execute/replay an upstream operation'
  );
  const unavailable = await read(READ, {
    sourceId: 'hce_' + '0'.repeat(32),
    digest: '0'.repeat(64),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(received.length, 12);
  const foreign = await request(fixtureRuntime.chat, '/v1/context-evidence/mcp', rpc(LIST), token, {
    authorization: 'Bearer fixture-b',
  });
  assert.equal(foreign.status, 403);
  const missing = await request(
    fixtureRuntime.chat,
    '/v1/chat/completions',
    { model: 'fixture-chat', messages: [] },
    'hes_' + '0'.repeat(64)
  );
  assert.equal(missing.status, 403);
  assert.equal(received.length, 12);
  const desktopDenied = await request(
    fixtureRuntime.chat,
    '/claude-desktop/v1/context-evidence/session',
    {}
  );
  assert.equal(
    desktopDenied.status,
    401,
    'Evidence endpoints must not bypass Desktop authentication'
  );
  const desktopAllowed = await request(
    fixtureRuntime.chat,
    '/claude-desktop/v1/context-evidence/session',
    {},
    undefined,
    { 'x-api-key': 'fixture-desktop' }
  );
  assert.equal(desktopAllowed.status, 201);
  assert.equal(received.length, 12);
});

test('direct-upload path also captures prospectively without changing upstream results or forwarding the capability', async (t) => {
  const { chat, request, read, received, token } = await fixture(t, true);
  const body = {
    model: 'fixture-chat',
    stream: false,
    messages: [{ role: 'user', content: 'fresh' }],
  };
  assert.equal((await request(chat, '/v1/chat/completions', body, token)).status, 200);
  assert.equal(
    (
      await request(
        chat,
        '/v1/chat/completions',
        {
          ...body,
          messages: [
            ...body.messages,
            { role: 'tool', tool_call_id: 'fixture_call', content: 'direct-original' },
          ],
        },
        token
      )
    ).status,
    200
  );
  const listed = await read(LIST);
  assert.equal(listed.sources.length, 1);
  assert.equal(
    (await read(READ, { sourceId: listed.sources[0].sourceId, digest: listed.sources[0].digest }))
      .page.text,
    'direct-original'
  );
  assert.equal(received.length, 2);
  assert.ok(received.every((entry) => entry.evidenceHeader === undefined));
});
