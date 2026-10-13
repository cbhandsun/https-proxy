'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createContextApiEvidenceRuntime } = require('../lib/proxy/context-api-evidence-runtime');
const { createContextApiEvidenceHttp } = require('../lib/proxy/context-api-evidence-http');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const owner = { ok: true, enabled: true, key: { id: 'owner-a' } };
async function fixture(t, dependencies) {
  const runtime = createContextApiEvidenceRuntime();
  const handler = createContextApiEvidenceHttp(runtime, dependencies);
  let enabled = true;
  const server = http.createServer((req, res) => {
    runtime.configure(enabled);
    const auth =
      req.headers.authorization === 'Bearer fixture-a'
        ? owner
        : req.headers.authorization === 'Bearer fixture-b'
          ? { ...owner, key: { id: 'owner-b' } }
          : { ok: false, enabled: true };
    if (!auth.ok) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    if (!handler.handle(req, res, req.url, auth, enabled)) {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    runtime.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function post(path, body = {}, token, overrides = {}) {
    const response = await fetch(base + '/v1/context-evidence/' + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer fixture-a',
        ...(token ? { 'x-hpm-evidence-token': token } : {}),
        ...overrides.headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'headers')),
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
  }
  return {
    runtime,
    base,
    post,
    disable: () => {
      enabled = false;
    },
  };
}

test('standard HTTP MCP client reads prospective API evidence; another owner/connection cannot read it or dispatch a tool', async (t) => {
  const { runtime, base, post } = await fixture(t);
  const created = await post('session');
  assert.equal(created.status, 201);
  const token = created.body.token;
  const cap = runtime.bind(owner, token);
  cap.observeCalls('chat', [
    { callId: 'fresh_call', toolName: 'lookup', arguments: {}, output: '', completed: true },
  ]);
  cap.observeInput('chat', {
    messages: [{ role: 'tool', tool_call_id: 'fresh_call', content: '新结果-é-✅' }],
  });
  const client = new Client({ name: 'generic-http-host', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/v1/context-evidence/mcp'), {
      requestInit: {
        headers: { authorization: 'Bearer fixture-a', 'x-hpm-evidence-token': token },
      },
    })
  );
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [LIST, READ]
  );
  assert.ok(
    tools.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint)
  );
  const listed = JSON.parse((await client.callTool({ name: LIST, arguments: {} })).content[0].text);
  const receipt = listed.sources[0];
  const read = JSON.parse(
    (
      await client.callTool({
        name: READ,
        arguments: { sourceId: receipt.sourceId, digest: receipt.digest },
      })
    ).content[0].text
  );
  assert.equal(read.page.text, '新结果-é-✅');
  assert.equal(read.verification, 'not_verified');
  const second = await post('session');
  const empty = await post(
    'mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: READ,
        arguments: { sourceId: receipt.sourceId, digest: receipt.digest },
      },
    },
    second.body.token
  );
  assert.equal(JSON.parse(empty.body.result.content[0].text).ok, false);
  const foreign = await post('mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, token, {
    headers: { authorization: 'Bearer fixture-b' },
  });
  assert.equal(foreign.status, 403);
  await assert.rejects(client.callTool({ name: 'hpm_capture_completed_hook', arguments: {} }));
  await assert.rejects(client.callTool({ name: 'execute_original', arguments: {} }));
  const task = await post(
    'mcp',
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: LIST,
        arguments: {},
        task: { ttl: 1000 },
      },
    },
    token
  );
  assert.ok(task.body.error);
  assert.equal(runtime.inspect().captured, 1);
  assert.equal(runtime.inspect().activeObservations, 0);
  assert.equal((await post('session', {}, token, { method: 'DELETE' })).status, 200);
  assert.equal(
    (await post('mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, token)).status,
    403
  );
});

test('MCP initialization, transport and cleanup failures release leases and never expose raw errors', async (t) => {
  for (const phase of [
    'server',
    'transport',
    'handler',
    'connect',
    'request',
    'server-close',
    'transport-close',
  ]) {
    let serverClosed = 0;
    let transportClosed = 0;
    const fail = () => {
      throw new Error('synthetic-private-content');
    };
    const { post, runtime } = await fixture(t, {
      createServer() {
        if (phase === 'server') fail();
        return {
          setRequestHandler() {
            if (phase === 'handler') fail();
          },
          async connect() {
            if (phase === 'connect') fail();
          },
          async close() {
            serverClosed++;
            if (phase === 'server-close') fail();
          },
        };
      },
      createTransport() {
        if (phase === 'transport') fail();
        return {
          async handleRequest(req, res) {
            if (phase === 'request') fail();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
          },
          async close() {
            transportClosed++;
            if (phase === 'transport-close') fail();
          },
        };
      },
    });
    const created = await post('session');
    const result = await post(
      'mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      created.body.token
    );
    await tick();
    assert.equal(result.status, phase.endsWith('-close') ? 200 : 500);
    assert.equal(JSON.stringify(result.body).includes('synthetic-private-content'), false);
    assert.equal(runtime.inspect().activeObservations, 0);
    assert.equal(serverClosed, phase === 'server' ? 0 : 1);
    assert.equal(transportClosed, ['server', 'transport'].includes(phase) ? 0 : 1);
    assert.ok(runtime.inspect().observationFailures > 0);
  }
});

test('busy HTTP connection does not construct a transport or dispatch any operation', async (t) => {
  let constructions = 0;
  const { runtime, post } = await fixture(t, {
    createServer() {
      constructions++;
      throw new Error('must-not-construct');
    },
  });
  const created = await post('session');
  const cap = runtime.bind(owner, created.body.token);
  const releases = Array.from({ length: 4 }, () => cap.acquireObservation());
  assert.equal(
    (await post('mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, created.body.token)).status,
    429
  );
  assert.equal(constructions, 0);
  releases.forEach((release) => release());
  assert.equal(runtime.inspect().activeObservations, 0);
});

test('upload deadlines, aborts and streamed overflow never create sessions; dependency inputs fail closed', () => {
  const runtime = createContextApiEvidenceRuntime();
  runtime.configure(true);
  for (const value of [null, 1, 'invalid'])
    assert.throws(() => createContextApiEvidenceHttp(runtime, { createServer: value }));
  for (const scenario of ['timeout', 'error', 'closed', 'overflow', 'invalid-utf8']) {
    let deadline;
    let cleared = 0;
    const handler = createContextApiEvidenceHttp(runtime, {
      setTimer(callback, milliseconds) {
        assert.equal(milliseconds, 10000);
        deadline = callback;
        return { unref() {} };
      },
      clearTimer() {
        cleared++;
      },
    });
    const req = new PassThrough();
    req.method = 'POST';
    req.headers = {};
    const res = new EventEmitter();
    res.statusCode = 0;
    res.writeHead = (status) => {
      res.statusCode = status;
      res.headersSent = true;
    };
    res.end = () => {};
    handler.handle(req, res, '/v1/context-evidence/session', owner, true);
    if (scenario === 'timeout') deadline();
    else if (scenario === 'error') req.emit('error', new Error('private'));
    else if (scenario === 'closed') {
      res.destroyed = true;
      res.emit('close');
    } else if (scenario === 'overflow') req.write(Buffer.alloc(16385));
    else {
      req.end(Buffer.from([255]));
    }
    if (scenario !== 'invalid-utf8') assert.ok(cleared > 0 || req.destroyed);
    assert.equal(runtime.inspect().sessions, 0);
    req.destroy();
  }
  runtime.close();
});

test('HTTP policy rejects disabled, invalid, oversized, foreign and session-selected requests without returning source content', async (t) => {
  const { post, disable } = await fixture(t);
  for (const body of ['', '{', '[]', 'null', '{"session":"arbitrary"}'])
    assert.equal((await post('session', body)).status, 400);
  assert.equal((await post('session', 'x'.repeat(16385))).status, 413);
  assert.equal(
    (await post('session', {}, undefined, { headers: { 'content-encoding': 'gzip' } })).status,
    400
  );
  assert.equal((await post('mcp', {})).status, 403);
  assert.equal((await post('unknown')).status, 404);
  assert.equal((await post('session?token=never')).status, 404);
  assert.equal((await post('mcp', {}, undefined, { method: 'DELETE' })).status, 404);
  assert.equal(
    (await post('session', {}, undefined, { headers: { authorization: 'Bearer missing' } })).status,
    401
  );
  const created = await post('session');
  assert.equal((await post('session', {}, created.body.token)).status, 400);
  assert.equal((await post('mcp', '[]', created.body.token)).status, 400);
  disable();
  assert.equal((await post('session')).status, 404);
  assert.equal((await post('mcp', {}, created.body.token)).status, 404);
});
