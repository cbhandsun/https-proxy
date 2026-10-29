'use strict';

const { performance } = require('node:perf_hooks');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
} = require('@modelcontextprotocol/sdk/types.js');
const {
  createContextEvidenceGatewayMcpServer,
} = require('../lib/client/context-evidence-gateway-mcp');
const { parseEvidenceGatewayArguments } = require('../scripts/lib/evidence-gateway-runtime');
const json = (r) => JSON.parse(r.content[0].text);
const definition = { name: 'lookup', inputSchema: { type: 'object', additionalProperties: false } };

async function assertProcessExited(pid) {
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    assert.ok(Date.now() < deadline, 'isolated fixture process did not terminate');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('real MCP transport gateway discovers, captures and reads without host metadata or original replay', async (t) => {
  let calls = 0;
  const source = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  source.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [definition] }));
  source.setRequestHandler(CallToolRequestSchema, () => ({
    content: [{ type: 'text', text: 'fresh-' + ++calls }],
  }));
  const downstream = new Client({ name: 'gateway-downstream', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await source.connect(b);
  await downstream.connect(a);
  const runtime = await createContextEvidenceGatewayMcpServer(downstream);
  const client = new Client({ name: 'generic-host', version: '1' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await runtime.server.close();
    await downstream.close();
    await source.close();
  });
  await runtime.connect(d);
  await client.connect(c);
  assert.equal((await client.listTools()).tools.length, 4);
  assert.equal(
    (await client.callTool({ name: 'lookup', arguments: {} })).content[0].text,
    'fresh-1'
  );
  const receipt = json(await client.callTool({ name: 'hpm_list_retained_evidence' })).sources[0];
  const recovered = json(
    await client.callTool({
      name: 'hpm_read_retained_evidence',
      arguments: { sourceId: receipt.sourceId, digest: receipt.digest },
    })
  );
  assert.equal(JSON.parse(recovered.page.text).content[0].text, 'fresh-1');
  assert.equal(calls, 1);
  assert.equal(
    json(await client.callTool({ name: 'hpm_list_execution_records' })).records[0].verification,
    'not_verified'
  );
  assert.equal((await client.callTool({ name: 'hpm_capture_completed_hook' })).isError, true);
  await client.close();
  assert.equal(runtime.session.inspect().closed, true);
});

test('gateway bounds catalog paging and rejects cycles, malformed pages, excess tools and secret exceptions', async () => {
  let count = 0;
  const runtime = await createContextEvidenceGatewayMcpServer({
    request: async ({ params }) => {
      count++;
      return params.cursor ? { tools: [] } : { tools: [definition], nextCursor: 'second' };
    },
    callTool() {},
  });
  assert.equal(count, 2);
  runtime.session.close();
  await runtime.server.close();
  for (const result of [
    null,
    {},
    { tools: {} },
    { tools: [], nextCursor: '' },
    { tools: [], nextCursor: 1 },
    { tools: [], nextCursor: 'x'.repeat(4097) },
    { tools: Array(513).fill(definition) },
  ])
    await assert.rejects(
      createContextEvidenceGatewayMcpServer({ request: async () => result }),
      /gateway_catalog_unavailable/
    );
  await assert.rejects(
    createContextEvidenceGatewayMcpServer({
      request: async () => ({ tools: [], nextCursor: 'same' }),
    }),
    /gateway_catalog_unavailable/
  );
  count = 0;
  await assert.rejects(
    createContextEvidenceGatewayMcpServer({
      request: async () => ({ tools: [], nextCursor: String(++count) }),
    }),
    /gateway_catalog_unavailable/
  );
  assert.equal(count, 16);
  await assert.rejects(
    createContextEvidenceGatewayMcpServer({
      request: async () => {
        throw new Error('Bearer hiddencredential1234');
      },
    }),
    (e) => e.message === 'gateway_catalog_unavailable'
  );
  for (const options of [null, [], { owner: 'foreign' }])
    await assert.rejects(
      createContextEvidenceGatewayMcpServer({}, options),
      /invalid_gateway_configuration/
    );
});

test('task requests produce a fixed protocol error without dispatch or SDK task-result validation', async (t) => {
  let calls = 0;
  const runtime = await createContextEvidenceGatewayMcpServer({
    request: async ({ method }) => {
      if (method === 'tools/list') return { tools: [definition] };
      calls++;
      return { content: [{ type: 'text', text: 'must not execute' }] };
    },
  });
  const client = new Client({ name: 'task-refusal-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await runtime.server.close();
  });
  await runtime.connect(b);
  await client.connect(a);
  await assert.rejects(
    client.request(
      { method: 'tools/call', params: { name: 'lookup', task: { ttl: 1000 } } },
      CallToolResultSchema
    ),
    (error) =>
      error.code === ErrorCode.InvalidParams &&
      error.message.endsWith('gateway_task_mode_unsupported')
  );
  assert.equal(calls, 0);
  assert.deepEqual(json(await client.callTool({ name: 'hpm_list_execution_records' })).records, []);
});

test('catalog discovery never compiles an unsafe downstream output schema via Client.listTools', async () => {
  let requestCount = 0;
  await assert.rejects(
    createContextEvidenceGatewayMcpServer({
      listTools() {
        assert.fail('unchecked Client.listTools must not be used');
      },
      request: async ({ method }) => {
        assert.equal(method, 'tools/list');
        requestCount++;
        return {
          tools: [
            {
              ...definition,
              outputSchema: { type: 'object', properties: { x: { pattern: '(a+)+' } } },
            },
          ],
        };
      },
    }),
    /Invalid evidence gateway schema/
  );
  assert.equal(requestCount, 1);
});

test('real MCP progress and catalog changes preserve retained evidence and prevent stale dispatch', async (t) => {
  let tools = [definition];
  let calls = 0;
  const source = new Server(
    { name: 'dynamic-source', version: '1' },
    { capabilities: { tools: { listChanged: true } } }
  );
  source.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  source.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    calls++;
    if (extra._meta?.progressToken !== undefined) {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: extra._meta.progressToken,
          progress: 0,
          total: 2,
          message: 'synthetic-private-progress-message',
        },
      });
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: extra._meta.progressToken, progress: 1, total: 2 },
      });
    }
    return { content: [{ type: 'text', text: 'exact result' }] };
  });
  const downstream = new Client({ name: 'dynamic-downstream', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await source.connect(b);
  await downstream.connect(a);
  const runtime = await createContextEvidenceGatewayMcpServer(downstream);
  const client = new Client({ name: 'generic-progress-host', version: '1' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await runtime.server.close();
    await downstream.close();
    await source.close();
  });
  await runtime.connect(d);
  await client.connect(c);
  assert.equal(client.getServerCapabilities().tools.listChanged, true);
  const progress = [];
  await client.callTool({ name: 'lookup' }, undefined, {
    onprogress: (value) => progress.push(value),
  });
  await new Promise(setImmediate);
  assert.deepEqual(
    progress.map((value) => value.progress),
    [0, 1]
  );
  assert.equal(JSON.stringify(progress).includes('synthetic-private-progress-message'), false);
  const receipt = json(await client.callTool({ name: 'hpm_list_retained_evidence' })).sources[0];
  tools = [{ ...definition, name: 'new_lookup' }];
  await source.notification({ method: 'notifications/tools/list_changed' });
  await new Promise(setImmediate);
  assert.equal((await client.listTools()).tools[0].name, 'new_lookup');
  assert.equal((await client.callTool({ name: 'lookup' })).isError, true);
  tools = [{ ...definition, name: 'hpm_read_retained_evidence' }];
  await source.notification({ method: 'notifications/tools/list_changed' });
  await new Promise(setImmediate);
  assert.equal((await client.listTools()).tools.length, 3);
  assert.equal(
    json(await client.callTool({ name: 'new_lookup' })).error,
    'gateway_catalog_unavailable'
  );
  const recovered = json(
    await client.callTool({
      name: 'hpm_read_retained_evidence',
      arguments: { sourceId: receipt.sourceId, digest: receipt.digest },
    })
  );
  assert.equal(JSON.parse(recovered.page.text).content[0].text, 'exact result');
  assert.equal(calls, 1);
  tools = [];
  await source.notification({ method: 'notifications/tools/list_changed' });
  await new Promise(setImmediate);
  assert.equal(runtime.session.inspect().catalogAvailable, true);
  assert.equal(runtime.catalogRefresh.inspect().attempts, 3);
});

test('startup catalog changes are observed before discovery and persistent startup storms fail closed', async () => {
  for (const storm of [false, true]) {
    let handler;
    let calls = 0;
    let removals = 0;
    const downstream = {
      getServerCapabilities: () => ({ tools: { listChanged: true } }),
      setNotificationHandler: (_schema, callback) => {
        handler = callback;
      },
      removeNotificationHandler: (method) => {
        assert.equal(method, 'notifications/tools/list_changed');
        removals++;
      },
      request: async () => {
        calls++;
        if (storm || calls === 1) handler();
        return { tools: [{ ...definition, name: calls === 1 ? 'stale_lookup' : 'fresh_lookup' }] };
      },
    };
    if (storm) {
      await assert.rejects(
        createContextEvidenceGatewayMcpServer(downstream),
        /gateway_catalog_unavailable/
      );
      assert.equal(removals, 1);
    } else {
      const runtime = await createContextEvidenceGatewayMcpServer(downstream);
      assert.equal(runtime.session.definitions[0].name, 'fresh_lookup');
      await runtime.close();
      await runtime.close();
      assert.equal(removals, 1);
    }
    assert.equal(calls, 2);
  }
  let removed = false;
  await assert.rejects(
    createContextEvidenceGatewayMcpServer({
      getServerCapabilities: () => ({ tools: { listChanged: true } }),
      setNotificationHandler() {},
      removeNotificationHandler() {
        removed = true;
      },
      request: async () => ({ tools: [{ ...definition, name: 'hpm_read_retained_evidence' }] }),
    }),
    /Invalid evidence gateway catalog/
  );
  assert.equal(removed, true);
});

test('closing a real gateway cancels pending catalog discovery and never reopens its evidence scope', async (t) => {
  let lists = 0;
  let started;
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const source = new Server(
    { name: 'catalog-close-source', version: '1' },
    { capabilities: { tools: { listChanged: true } } }
  );
  source.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    if (++lists === 1) return { tools: [definition] };
    started();
    return await new Promise((resolve) =>
      extra.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          resolve({ tools: [definition] });
        },
        { once: true }
      )
    );
  });
  const downstream = new Client({ name: 'catalog-close-downstream', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await source.connect(b);
  await downstream.connect(a);
  const runtime = await createContextEvidenceGatewayMcpServer(downstream);
  const client = new Client({ name: 'catalog-close-host', version: '1' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await runtime.close();
    await downstream.close();
    await source.close();
  });
  await runtime.connect(d);
  await client.connect(c);
  const refresh = runtime.catalogRefresh.refresh();
  await requestStarted;
  await runtime.close();
  assert.equal((await refresh).ok, false);
  await new Promise(setImmediate);
  assert.equal(cancelled, true);
  assert.equal(runtime.session.inspect().closed, true);
  assert.equal(lists, 2);
  assert.equal(json(await runtime.session.call('lookup')).error, 'evidence_gateway_closed');
});

test('gateway CLI validates explicit owner command configuration, never model-supplied commands', () => {
  assert.deepEqual(parseEvidenceGatewayArguments(['--', 'node', 'server.cjs']), {
    command: 'node',
    args: ['server.cjs'],
    options: {},
  });
  assert.equal(
    parseEvidenceGatewayArguments(['--offload-bytes', '2048', '--', 'node']).options
      .offloadThresholdBytes,
    2048
  );
  for (const value of [
    null,
    [],
    ['node'],
    ['--'],
    ['--', ''],
    ['--', 'server.cmd'],
    ['--', 'pwsh'],
    ['--', 'node;whoami'],
    ['--', '-node'],
    ['--', 'node', '\u0000'],
    ['--offload-bytes', '0', '--', 'node'],
    ['--offload-bytes', '1048577', '--', 'node'],
    ['--offload-bytes', '1e4', '--', 'node'],
    Array(131).fill('node'),
  ])
    assert.throws(
      () => parseEvidenceGatewayArguments(value),
      /(?:invalid_gateway_configuration|Invalid or unavailable)/
    );
});

test(
  'actual stdio CLI works for two generic host identities with independent evidence scopes',
  { timeout: 30000 },
  async (t) => {
    const started = performance.now();
    const phases = [];
    const phase = (name) =>
      phases.push({ phase: name, elapsedMs: Math.round(performance.now() - started) });
    t.after(() => t.diagnostic(JSON.stringify({ gatewayHosts: phases })));
    const clients = [];
    const processes = [];
    for (const name of ['codex-compatible-fixture', 'claude-compatible-fixture']) {
      const client = new Client({ name, version: '1' });
      clients.push(client);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          path.resolve(__dirname, '../scripts/start-evidence-mcp-gateway.js'),
          '--offload-bytes',
          '1024',
          '--forward-env',
          'HPM_GATEWAY_FIXTURE_ALLOWED',
          '--',
          process.execPath,
          path.resolve(__dirname, 'fixtures/evidence-gateway-source-mcp.cjs'),
        ],
        env: {
          HPM_GATEWAY_FIXTURE_ALLOWED: 'synthetic-fixture-only',
          HPM_GATEWAY_FIXTURE_UNSELECTED: 'must-not-forward',
          // Test instrumentation only, never inherited authentication/config.
          ...(process.env.NODE_V8_COVERAGE
            ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }
            : {}),
        },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', () => {});
      t.after(() => client.close());
      phase(name + ':connect_started');
      await client.connect(transport);
      phase(name + ':connected');
      const catalog = await client.listTools();
      assert.equal(catalog.tools.length, 4);
      const reference = json(await client.callTool({ name: 'fresh_source' }));
      assert.equal(reference.kind, 'retained_tool_result_reference');
      const page = json(
        await client.callTool({
          name: 'hpm_read_retained_evidence',
          arguments: { sourceId: reference.source.sourceId, digest: reference.source.digest },
        })
      );
      const result = JSON.parse(page.page.text);
      const source = JSON.parse(result.content[0].text);
      assert.equal(source.calls, 1);
      assert.equal(source.selectedEnvironmentPresent, true);
      assert.equal(source.unselectedEnvironmentPresent, false);
      assert.ok(Number.isSafeInteger(transport.pid) && Number.isSafeInteger(source.pid));
      processes.push({ transport, gatewayPid: transport.pid, sourcePid: source.pid });
      const execution = json(await client.callTool({ name: 'hpm_list_execution_records' }));
      phase(name + ':calls_finished');
      assert.equal(execution.records[0].state, 'completed');
      assert.equal(execution.records[0].verification, 'not_verified');
    }
    const first = json(await clients[0].callTool({ name: 'hpm_list_retained_evidence' }))
      .sources[0];
    assert.equal(
      (
        await clients[1].callTool({
          name: 'hpm_read_retained_evidence',
          arguments: { sourceId: first.sourceId, digest: first.digest },
        })
      ).isError,
      true
    );
    for (let i = 0; i < clients.length; i++) {
      phase('close_started:' + i);
      await clients[i].close();
      assert.equal(processes[i].transport.pid, null);
      await assertProcessExited(processes[i].gatewayPid);
      await assertProcessExited(processes[i].sourcePid);
      phase('close_finished:' + i);
    }
  }
);
