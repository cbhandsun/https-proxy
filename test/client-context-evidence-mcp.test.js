'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('node:path');
const {
  createContextEvidenceMcpServer,
  startContextEvidencePlugin,
} = require('../lib/client/context-evidence-mcp');

test('plugin startup composes its runtime before releasing the cache cwd and connecting once', async () => {
  const calls = [];
  const runtime = {
    connect: async () => {
      calls.push('connect');
    },
    session: {
      close() {
        calls.push('close');
      },
    },
  };
  const started = await startContextEvidencePlugin({
    createRuntime() {
      calls.push('create');
      return runtime;
    },
    runtimeDirectory() {
      calls.push('directory');
      return 'synthetic-runtime';
    },
    changeDirectory(directory) {
      assert.equal(directory, 'synthetic-runtime');
      calls.push('chdir');
    },
  });
  assert.equal(started, runtime);
  assert.deepEqual(calls, ['create', 'directory', 'chdir', 'connect']);
});

test('plugin startup refuses unsafe dependencies and sanitizes load, cwd, connection and cleanup failures', async () => {
  let invoked = 0;
  const get = () => {
    invoked++;
    throw new Error('synthetic-private-value');
  };
  for (const dependencies of [
    null,
    [],
    1,
    Object.create({}),
    { extra: get },
    { createRuntime: null },
    { changeDirectory: 0 },
    { runtimeDirectory: [] },
    { [Symbol('invalid')]: get },
    Object.defineProperty({}, 'createRuntime', { value: get }),
    Object.defineProperty({}, 'createRuntime', { enumerable: true, get }),
  ])
    await assert.rejects(startContextEvidencePlugin(dependencies), {
      message: 'evidence_mcp_start_failed',
    });
  assert.equal(invoked, 0);
  for (const value of [undefined, null, {}])
    await assert.rejects(
      startContextEvidencePlugin({
        createRuntime: () => value,
        runtimeDirectory: () => 'synthetic-runtime',
        changeDirectory() {},
      }),
      { message: 'evidence_mcp_start_failed' }
    );
  for (const phase of ['create', 'directory', 'chdir', 'connect', 'cleanup']) {
    let closed = 0,
      connected = 0;
    const fail = () => {
      throw new Error('synthetic-private-value');
    };
    await assert.rejects(
      startContextEvidencePlugin({
        createRuntime() {
          if (phase === 'create') fail();
          return {
            connect: async () => {
              connected++;
              fail();
            },
            session: {
              close() {
                closed++;
                if (phase === 'cleanup') fail();
              },
            },
          };
        },
        runtimeDirectory() {
          if (phase === 'directory') fail();
          return 'synthetic-runtime';
        },
        changeDirectory() {
          if (phase === 'chdir') fail();
        },
      }),
      { message: 'evidence_mcp_start_failed' }
    );
    assert.equal(closed, phase === 'create' ? 0 : 1);
    assert.equal(connected, ['connect', 'cleanup'].includes(phase) ? 1 : 0);
  }
});

test('MCP stdio entry connects without credentials and starts with no retained evidence', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '-e',
      "require('./lib/client/context-evidence-mcp').createContextEvidenceMcpServer().connect().catch(() => { process.exitCode = 1; });",
    ],
    cwd: path.resolve(__dirname, '..'),
    env: {},
    stderr: 'pipe',
  });
  const client = new Client({ name: 'synthetic-stdio-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, '0.1.1');
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    'hpm_list_retained_evidence',
    'hpm_read_retained_evidence',
  ]);
  const result = await client.callTool({
    name: 'hpm_list_retained_evidence',
    arguments: {},
    _meta: { threadId: 'synthetic-stdio-thread' },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text).sources, []);
});

test('MCP advertises only read-only tools and separates trusted host capture from readers', async (t) => {
  const runtime = createContextEvidenceMcpServer();
  const client = new Client({ name: 'synthetic-evidence-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await runtime.server.close();
  });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = await client.listTools();
  assert.equal(advertised.tools.length, 2);
  assert.equal(
    advertised.tools.some((tool) => /capture/.test(tool.name)),
    false
  );
  assert.equal(
    advertised.tools.every(
      (tool) => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint
    ),
    true
  );
  const call = (name, args, thread = 'thread-test') =>
    client.callTool({ name, arguments: args, _meta: { threadId: thread } });
  const capture = await call('hpm_capture_completed_hook', {
    hook_event_name: 'PostToolUse',
    session_id: 'thread-test',
    tool_use_id: 'call-1',
    tool_name: 'synthetic_tool',
    tool_input: {},
    tool_response: '',
  });
  assert.deepEqual(capture.content, [{ type: 'text', text: '{}' }]);
  const index = JSON.parse((await call('hpm_list_retained_evidence', {})).content[0].text);
  const source = index.sources[0];
  assert.equal(
    JSON.parse(
      (
        await call('hpm_read_retained_evidence', {
          sourceId: source.sourceId,
          digest: source.digest,
        })
      ).content[0].text
    ).page.text,
    ''
  );
  const badArgs = await call('hpm_list_retained_evidence', { limit: 'secret' });
  assert.equal(badArgs.isError, true);
  assert.equal(badArgs.content[0].text.includes('secret'), false);
  assert.equal((await call('hpm_list_retained_evidence', {}, 'foreign')).isError, true);
  assert.equal((await call('unknown', {})).isError, true);
  await assert.rejects(
    call('hpm_capture_completed_hook', { secret: 'never-log' }),
    (problem) =>
      problem.message.includes('invalid_hook_event') && !problem.message.includes('never-log')
  );
  // Missing arguments default to an empty reader request, never session selection.
  assert.equal(
    (
      await client.callTool({
        name: 'hpm_list_retained_evidence',
        _meta: { threadId: 'thread-test' },
      })
    ).isError,
    false
  );
  await client.close();
  assert.equal(runtime.session.inspect().closed, true);
});
