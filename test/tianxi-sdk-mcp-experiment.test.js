'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AbortController } = globalThis;
const { createTianxiSdkMcpChannel } = require('../scripts/lib/tianxi-sdk-mcp-channel');
const { runTianxiSdkMcpExperiment } = require('../scripts/lib/tianxi-sdk-mcp-experiment');
const { probeTianxiSdkNativeTools } = require('../scripts/lib/tianxi-sdk-mcp-probe');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');

const tools = [
  {
    name: 'exec',
    description: 'Client tool input, preserved verbatim.',
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string', maxLength: 65536 } },
      required: ['input'],
      additionalProperties: false,
    },
  },
];
const result = (text) => ({ content: [{ type: 'text', text }] });
const request = (method = 'tools/list', params, id = 'request1') => ({
  server_name: 'codex_native',
  message: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
});

test('SDK MCP keeps tool definitions and multiline input/output exact, deduplicates calls', async () => {
  let calls = 0;
  const raw = '*** Begin Patch\n*** Add File: fixture.txt\n+你好\n*** End Patch';
  const channel = createTianxiSdkMcpChannel({
    tools,
    onCall: async (name, args) => {
      calls++;
      assert.equal(name, 'exec');
      assert.equal(args.input, raw);
      return result('exact\noutput');
    },
  });
  const init = await channel.handle(request('initialize'));
  assert.equal(init.result.serverInfo.name, 'codex_native');
  const listed = await channel.handle(request('tools/list', undefined, 'list'));
  assert.deepEqual(listed.result.tools, tools);
  listed.result.tools[0].name = 'tampered';
  assert.equal(
    (await channel.handle(request('tools/list', undefined, 'list2'))).result.tools[0].name,
    'exec'
  );
  const call = request('tools/call', { name: 'exec', arguments: { input: raw } }, 'call');
  const replies = await Promise.all([channel.handle(call), channel.handle(call)]);
  assert.equal(calls, 1);
  assert.equal(channel.calls, 1);
  assert.deepEqual(replies[0].result, result('exact\noutput'));
  assert.deepEqual(replies[0], replies[1]);
  await assert.rejects(
    channel.handle(
      request('tools/call', { name: 'exec', arguments: { input: 'changed' } }, 'call')
    ),
    /mcp_invalid/
  );
});

test('SDK MCP rejects empty, illegal, extreme, executable schemas and hostile input before callbacks', async () => {
  for (const invalidTools of [
    [],
    null,
    Array(129).fill(tools[0]),
    [tools[0], tools[0]],
    [{ ...tools[0], name: '__proto__' }],
    [{ ...tools[0], inputSchema: { type: 'object', $ref: 'https://untrusted.invalid/schema' } }],
    [
      {
        ...tools[0],
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string', pattern: '(a+)+$' } },
        },
      },
    ],
    [{ ...tools[0], inputSchema: { type: 'object', patternProperties: { '.*': {} } } }],
    [{ ...tools[0], description: 'x'.repeat(32769) }],
  ])
    assert.throws(
      () => createTianxiSdkMcpChannel({ tools: invalidTools, onCall() {} }),
      /mcp_invalid/
    );
  let touched = 0;
  const accessor = Object.defineProperty({}, 'server_name', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        throw Error('PRIVATE');
      },
    }
  );
  const channel = createTianxiSdkMcpChannel({
    tools,
    onCall() {
      touched++;
    },
  });
  for (const value of [
    null,
    [],
    {},
    accessor,
    proxy,
    { ...request(), server_name: 'other' },
    request('unknown'),
    request('tools/list', undefined, {}),
    request('tools/list', undefined, 'x'.repeat(81)),
    request('tools/call', { name: 'other', arguments: {} }),
    request('tools/call', { name: 'exec', arguments: {} }),
    request('tools/call', { name: 'exec', arguments: { input: 'x', extra: true } }),
    request('tools/call', { name: 'exec', arguments: { input: 'x'.repeat(65537) } }),
  ])
    await assert.rejects(channel.handle(value), /mcp_invalid/);
  assert.equal(touched, 0);
  const unexpectedNotification = request();
  delete unexpectedNotification.message.id;
  await assert.rejects(channel.handle(unexpectedNotification), /mcp_invalid/);
});

test('SDK MCP errors are fixed, outputs bounded, timeouts and cancellation terminate waiting', async () => {
  const input = request('tools/call', { name: 'exec', arguments: { input: 'x' } });
  for (const onCall of [
    () => {
      throw Error('token=PRIVATE');
    },
    () => result('x'.repeat(65537)),
    () => ({ content: [{ type: 'image', data: 'PRIVATE' }] }),
    () => {
      throw Object.defineProperty({}, 'message', {
        get() {
          throw new Error('getter executed');
        },
      });
    },
  ]) {
    const channel = createTianxiSdkMcpChannel({ tools, onCall });
    const output = await channel.handle(input);
    assert.equal(output.result.isError, true);
    assert.equal(output.result.content[0].text, 'tool_execution_failed');
    assert.ok(!JSON.stringify(output).includes('PRIVATE'));
  }
  const timeout = createTianxiSdkMcpChannel({
    tools,
    timeoutMs: 5,
    onCall: () => new Promise(() => {}),
  });
  await assert.rejects(timeout.handle(input), /mcp_timeout/);
  const abort = new AbortController();
  const cancelled = createTianxiSdkMcpChannel({
    tools,
    signal: abort.signal,
    onCall: () => new Promise(() => {}),
  });
  const pending = cancelled.handle(input);
  abort.abort();
  await assert.rejects(pending, /mcp_aborted/);
  await assert.rejects(cancelled.handle(request()), /mcp_aborted/);
  const budget = createTianxiSdkMcpChannel({ tools, onCall: () => result('ok') });
  for (let i = 0; i < 32; i++)
    await budget.handle(request('tools/call', input.message.params, `call${i}`));
  await assert.rejects(
    budget.handle(request('tools/call', input.message.params, 'last')),
    /mcp_call_limit/
  );
});

function fixtureProcess(mode = 'success') {
  const header = { user_id: 'fixture-user', device_id: 'fixture-device' };
  const token = 'sat-YQ.Yg.Yw';
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  let cleaned = 0,
    stopped = 0;
  const writes = [];
  const send = (value) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', (chunk) => {
    const frame = JSON.parse(chunk.toString());
    writes.push(frame);
    setImmediate(() => {
      if (mode === 'hang') return;
      if (frame.type === 'control_request') {
        if (frame.request.type === 'initialize') {
          assert.deepEqual(frame.request.sdkMcpServers, ['codex_native']);
          assert.equal(typeof frame.request.systemPrompt, 'string');
        }
        send({
          type: 'control_response',
          session_id: 'session',
          response: {
            request_id: frame.request_id,
            subtype: 'success',
            response: { session_id: 'session' },
          },
        });
      } else if (frame.type === 'user') {
        send({ type: 'system', session_id: 'session', model: 'DeepSeek-Flash' });
        if (mode === 'malformed') {
          child.stdout.write('not-json\n');
          return;
        }
        if (mode === 'close') {
          child.emit('close', 1);
          return;
        }
        send({
          type: 'assistant',
          session_id: 'session',
          message: {
            model: 'dfmodel',
            content: [
              ...(mode === 'commentary' ? [{ type: 'text', text: 'Reading the fixture.' }] : []),
              {
                type: 'tool_use',
                name: mode === 'unknown-tool' ? 'Bash' : 'mcp__codex_native__exec',
                input: { input: 'exact' },
              },
            ],
          },
        });
        send({
          type: 'control_request',
          session_id: 'session',
          request_id: 'callback',
          request: {
            type: 'mcp_message',
            ...request('tools/call', { name: 'exec', arguments: { input: 'exact' } }),
          },
        });
      } else if (frame.type === 'control_response' && frame.response.request_id === 'callback') {
        assert.equal(frame.response.response.mcp_response.result.content[0].text, 'client-result');
        send({
          type: 'assistant',
          session_id: 'session',
          message: { model: 'dfmodel', content: [{ type: 'text', text: 'FINAL' }] },
        });
        send({
          type: 'result',
          session_id: 'session',
          subtype: 'success',
          modelUsage: { dfmodel: {} },
        });
      }
    });
  });
  const dependencies = {
    readHeader: () => header,
    refresh: async () => ({ token }),
    prepare: () => ({
      root: 'fixture',
      cli: 'pinned.exe',
      workerArgs: ['--tools', ''],
      args: ['--sdk'],
      env: {},
      cleanup() {
        cleaned++;
        if (mode === 'cleanup-fail') throw Error('PRIVATE');
      },
    }),
    spawnChild(_exe, _args, options) {
      assert.equal(options.windowsHide, true);
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    terminate() {
      stopped++;
      setImmediate(() => child.emit('close', 0));
    },
  };
  return { dependencies, writes, stats: () => ({ cleaned, stopped }) };
}
const experimentOptions = {
  modelId: 'dfmodel',
  prompt: 'Use the supplied tools.',
  tools,
  onCall: async () => result('client-result'),
};

test('SDK experiment keeps the selected model, handles MCP continuation and confirms child cleanup', async () => {
  const fixture = fixtureProcess();
  const output = await runTianxiSdkMcpExperiment(experimentOptions, fixture.dependencies);
  assert.equal(output.output, 'FINAL');
  assert.equal(output.calls, 1);
  assert.equal(output.modelId, 'dfmodel');
  assert.equal(output.observedModel, 'DeepSeek-Flash');
  assert.deepEqual(fixture.stats(), { cleaned: 1, stopped: 1 });
  const open = fixture.writes.find((frame) => frame.request?.type === 'daemon.open_session');
  assert.deepEqual(open.request.worker_args, [
    '--tools',
    '',
    '--allowed-tools',
    'mcp__codex_native__exec',
  ]);
});

test('SDK experiment distinguishes intermediate commentary from the final assistant answer', async () => {
  const fixture = fixtureProcess('commentary');
  const output = await runTianxiSdkMcpExperiment(experimentOptions, fixture.dependencies);
  assert.equal(output.finalText, 'FINAL');
  assert.equal(output.output, 'Reading the fixture.FINAL');
});

test('SDK experiment preserves host system instructions instead of substituting a fixture prompt', async () => {
  const fixture = fixtureProcess();
  const systemPrompt = 'Host instructions\n原始工具契约';
  await runTianxiSdkMcpExperiment(
    { ...experimentOptions, systemPrompt, toolTimeoutMs: 120000 },
    fixture.dependencies
  );
  assert.equal(
    fixture.writes.find((frame) => frame.request?.type === 'initialize').request.systemPrompt,
    systemPrompt
  );
  const defaults = fixtureProcess();
  await runTianxiSdkMcpExperiment(experimentOptions, defaults.dependencies);
  assert.ok(
    defaults.writes
      .find((frame) => frame.request?.type === 'initialize')
      .request.systemPrompt.includes('Only use tools supplied by the host')
  );
});

test('SDK experiment fails closed for malformed data, unknown tools, early close, abort and cleanup failure', async () => {
  for (const mode of ['malformed', 'unknown-tool', 'close', 'cleanup-fail', 'hang']) {
    const fixture = fixtureProcess(mode);
    await assert.rejects(
      runTianxiSdkMcpExperiment(
        { ...experimentOptions, timeoutMs: mode === 'hang' ? 10 : 1000 },
        fixture.dependencies
      ),
      /tianxi_sdk_/
    );
    assert.equal(fixture.stats().cleaned, 1);
  }
  const fixture = fixtureProcess();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    runTianxiSdkMcpExperiment(
      { ...experimentOptions, signal: aborted.signal },
      fixture.dependencies
    ),
    /mcp_aborted/
  );
  assert.equal(fixture.stats().cleaned, 0);
});

test('native-tools probe verifies raw patch, expected failure recovery and a client-only random result', async () => {
  const report = await probeTianxiSdkNativeTools('dfmodel', {
    run: async ({ onCall }) => {
      const patch =
        '*** Begin Patch\n*** Update File: fixture.txt\n@@\n-BEFORE\n+AFTER\n*** End Patch';
      assert.equal((await onCall('read_fixture', {})).content[0].text, 'BEFORE');
      assert.equal((await onCall('apply_patch', { input: patch })).isError, true);
      assert.equal(
        (await onCall('apply_patch', { input: patch })).content[0].text,
        'patch_applied'
      );
      const verified = await onCall('verify_fixture', {});
      return {
        output: verified.content[0].text,
        calls: 4,
        observedModel: 'DeepSeek-Flash',
        methods: ['tools/call'],
      };
    },
  });
  assert.equal(report.passed, true);
  assert.equal(report.rawPatchPreserved, true);
  assert.equal(report.productionRouteChanged, false);
  assert.equal(report.codexDesktopValidated, false);
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..'))).includes(
      'test/tianxi-sdk-mcp-experiment.test.js'
    )
  );
});

test('SDK experiment rejects invalid input and authentication before launch and cleans failed launches', async () => {
  for (const override of [
    { modelId: 'wrong' },
    { prompt: '' },
    { prompt: 'x'.repeat(32769) },
    { prompt: '\0' },
    { timeoutMs: 0 },
    { timeoutMs: 180001 },
    { timeoutMs: '10' },
    { systemPrompt: null },
    { systemPrompt: 'x'.repeat(128001) },
    { systemPrompt: '\0' },
    { toolTimeoutMs: 0 },
    { toolTimeoutMs: 120001 },
  ]) {
    const fixture = fixtureProcess();
    await assert.rejects(
      runTianxiSdkMcpExperiment({ ...experimentOptions, ...override }, fixture.dependencies),
      /mcp_invalid/
    );
    assert.equal(fixture.stats().cleaned, 0);
  }
  for (const scenario of ['missing-header', 'no-token', 'bad-token', 'spawn-throw']) {
    const fixture = fixtureProcess();
    const dependencies = { ...fixture.dependencies };
    if (scenario === 'missing-header') dependencies.readHeader = () => null;
    if (scenario === 'no-token') dependencies.refresh = async () => ({});
    if (scenario === 'bad-token') dependencies.refresh = async () => ({ token: 'PRIVATE' });
    if (scenario === 'spawn-throw')
      dependencies.spawnChild = () => {
        throw Error('PRIVATE');
      };
    await assert.rejects(runTianxiSdkMcpExperiment(experimentOptions, dependencies), /tianxi_sdk_/);
    assert.equal(fixture.stats().cleaned, ['bad-token', 'spawn-throw'].includes(scenario) ? 1 : 0);
  }
});

test('native-tools probe reports a failed acceptance instead of treating an invented answer as success', async () => {
  const report = await probeTianxiSdkNativeTools('dfmodel', {
    run: async () => ({
      output: 'invented',
      calls: 0,
      observedModel: 'DeepSeek-Flash',
      methods: [],
    }),
  });
  assert.equal(report.passed, false);
  assert.equal(report.returnedMarker, false);
  assert.equal(report.rawPatchPreserved, false);
  await assert.rejects(
    probeTianxiSdkNativeTools('dfmodel', {
      run: async ({ onCall }) => {
        await onCall('apply_patch', { input: 'untrusted' });
      },
    }),
    /fixture_sequence_invalid/
  );
});

test('SDK experiment rejects account drift before dispatching a client operation', async () => {
  const fixture = fixtureProcess();
  let reads = 0,
    calls = 0;
  const stableHeader = fixture.dependencies.readHeader();
  const dependencies = {
    ...fixture.dependencies,
    readHeader: () => (++reads <= 3 ? stableHeader : { ...stableHeader, user_id: 'other-user' }),
  };
  await assert.rejects(
    runTianxiSdkMcpExperiment(
      {
        ...experimentOptions,
        onCall: async () => {
          calls++;
          return result('client-result');
        },
      },
      dependencies
    ),
    /tianxi_sdk_/
  );
  assert.equal(calls, 0);
});
