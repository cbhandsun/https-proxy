'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AbortController } = globalThis;
const { createTianxiNativeSession } = require('../scripts/lib/tianxi-native-responses-session');
const { createTianxiNativeCatalog } = require('../scripts/lib/tianxi-native-responses-catalog');
const { createTianxiNativeProbeServer } = require('../scripts/lib/tianxi-native-responses-server');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const path = require('node:path');
const fs = require('node:fs');
const { evaluateNativeProbe } = require('../scripts/lib/tianxi-codex-native-probe');
const { createTianxiNativeProbeScope } = require('../scripts/lib/tianxi-native-probe-scope');
const { nativeProbePermissionArgs } = require('../scripts/lib/tianxi-native-probe-config');
const net = require('node:net');
const os = require('node:os');
const tools = [
  {
    type: 'custom',
    name: 'exec',
    namespace: 'functions',
    description: 'native code',
    format: { type: 'text' },
  },
];
const body = {
  model: 'tianxi/deepseek-flash',
  input: [{ role: 'user', content: 'fixture' }],
  tools,
};
function fakeRun(options) {
  return (async () => {
    const result = await options.onCall(
      options.tools[0].name,
      { input: 'native_source' },
      { signal: options.signal }
    );
    return { finalText: result.content[0].text };
  })();
}
function session() {
  return createTianxiNativeSession({ body, owner: 'owner', run: fakeRun });
}
test('native session accepts Codex text-part tool outputs and resumes the same task', async () => {
  const task = session();
  const call = (await task.next()).output[0];
  const final = await task.resume(
    [
      {
        type: 'custom_tool_call_output',
        call_id: call.call_id,
        output: [{ type: 'input_text', text: 'real result' }],
      },
    ],
    'owner',
    body.model
  );
  assert.equal(final.status, 'completed');
  assert.equal(final.output_text, 'real result');
  await task.done;
});

test('catalog preserves namespaces, raw source and role instructions from loaded native tools', () => {
  const catalog = createTianxiNativeCatalog({
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'host instructions' }] },
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{ type: 'namespace', name: 'functions', tools }],
      },
      { role: 'user', content: 'task' },
    ],
    instructions: 'system',
  });
  assert.equal(catalog.systemPrompt, 'system\n\nhost instructions');
  assert.equal(catalog.prompt, 'task');
  const raw = 'text(await tools.apply_patch("*** Begin Patch\\n*** End Patch"));';
  const call = catalog.call(catalog.definitions[0].name, { input: raw });
  assert.equal(call.input, raw);
  assert.equal(call.namespace, 'functions');
  assert.equal(call.name, 'exec');
  assert.equal(call.type, 'custom_tool_call');
  const fn = createTianxiNativeCatalog({
    ...body,
    tools: [
      {
        type: 'function',
        name: 'read',
        namespace: 'files',
        description: 'read',
        parameters: { type: 'object' },
      },
    ],
  });
  const args = { path: '你好\nfile' };
  const functionCall = fn.call(fn.definitions[0].name, args);
  assert.equal(functionCall.namespace, 'files');
  assert.deepEqual(JSON.parse(functionCall.arguments), args);
});

test('catalog honors deferred loading and direct caller restrictions, rejects conflicting definitions', () => {
  const deferred = { ...tools[0], name: 'later', defer_loading: true };
  const indirect = { ...tools[0], name: 'indirect', allowed_callers: ['programmatic'] };
  const catalog = createTianxiNativeCatalog({
    ...body,
    tools: [...tools, deferred, indirect],
    input: [
      ...body.input,
      { type: 'tool_search_output', status: 'completed', execution: 'client', tools: [deferred] },
    ],
  });
  assert.equal(catalog.definitions.length, 2);
  assert.equal(
    createTianxiNativeCatalog({ ...body, tools: [...tools, tools[0]] }).definitions.length,
    1
  );
  assert.throws(
    () =>
      createTianxiNativeCatalog({
        ...body,
        tools: [...tools, { ...tools[0], description: 'changed' }],
      }),
    /catalog_invalid/
  );
});

test('catalog accepts only the pinned exec grammar and rejects malformed, empty, extreme and hostile boundaries', () => {
  const definition =
    '\nstart: pragma_source | plain_source\npragma_source: PRAGMA_LINE NEWLINE SOURCE\nplain_source: SOURCE\n\nPRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/\nNEWLINE: /\\r?\\n/\nSOURCE: /[\\s\\S]+/\n';
  const grammarTool = { ...tools[0], format: { type: 'grammar', syntax: 'lark', definition } };
  assert.equal(createTianxiNativeCatalog({ ...body, tools: [grammarTool] }).definitions.length, 1);
  let touched = 0;
  const hostile = Object.defineProperty({}, 'input', {
    enumerable: true,
    get() {
      touched++;
      return [];
    },
  });
  for (const invalid of [
    null,
    hostile,
    { ...body, input: [] },
    { ...body, tools: [] },
    { ...body, input: [{ role: 'assistant', content: 'history' }] },
    { ...body, input: [{ role: 'user', content: 'x'.repeat(32769) }] },
    { ...body, instructions: 'x'.repeat(128001) },
    { ...body, tool_choice: 'none' },
    { ...body, tools: Array(129).fill(tools[0]) },
    ...[
      null,
      { type: 'grammar', syntax: 'regex', definition: '.*' },
      { type: 'grammar', syntax: 'lark', definition: definition + ' ' },
    ].map((format) => ({ ...body, tools: [{ ...tools[0], format }] })),
    { ...body, tools: [{ ...tools[0], name: '__proto__' }] },
  ])
    assert.throws(() => createTianxiNativeCatalog(invalid), /tianxi_native_/);
  assert.equal(touched, 0);
  const catalog = createTianxiNativeCatalog(body);
  for (const input of ['', 'x'.repeat(65537), null])
    assert.throws(() => catalog.call(catalog.definitions[0].name, { input }), /catalog_invalid/);
  assert.throws(() => catalog.call('unknown', {}), /catalog_invalid/);
});

test('session rejects forged, duplicate, media, extreme and cross-owner outputs without consuming pending call', async () => {
  const task = session();
  const call = (await task.next()).output[0];
  const output = { type: 'custom_tool_call_output', call_id: call.call_id, output: 'ok' };
  for (const items of [
    [],
    [output, output],
    [{ ...output, call_id: 'forged' }],
    [output, { ...output, call_id: 'forged' }],
    [{ ...output, type: 'function_call_output' }],
    [{ ...output, output: 1 }],
    [{ ...output, output: '你'.repeat(20001) }],
    [{ ...output, output: [{ type: 'input_image', image_url: 'PRIVATE' }] }],
    [{ ...output, output: [{ type: 'input_text', text: 'x', extra: 'PRIVATE' }] }],
    [output, { role: 'user', content: 'new task' }],
    [{ role: 'developer', content: 'changed host instruction' }, output],
    [{ role: 'user', content: 'new task' }, output],
  ])
    await assert.rejects(task.resume(items, 'owner', body.model), /tianxi_native_/);
  await assert.rejects(task.resume([output], 'other-owner', body.model), /owner_mismatch/);
  await assert.rejects(task.resume([output], 'owner', 'tianxi/qwen3.8-flash'), /owner_mismatch/);
  assert.equal((await task.resume([output], 'owner', body.model)).output_text, 'ok');
  await task.done;
});

test('session deduplicates concurrent outputs and validates all consumed history before continuation', async () => {
  let starts = 0,
    calls = 0;
  const task = createTianxiNativeSession({
    body,
    owner: 'owner',
    run: async (options) => {
      starts++;
      for (let i = 0; i < 2; i++) {
        calls++;
        await options.onCall(
          options.tools[0].name,
          { input: 'source' },
          { signal: options.signal }
        );
      }
      return { finalText: 'done' };
    },
  });
  const first = (await task.next()).output[0];
  const a = { type: 'custom_tool_call_output', call_id: first.call_id, output: '' };
  const [next, replay] = await Promise.all([
    task.resume([a], 'owner', body.model),
    task.resume([a], 'owner', body.model),
  ]);
  assert.deepEqual(next, replay);
  const b = {
    ...a,
    call_id: next.output[0].call_id,
    output: [{ type: 'input_text', text: 'result' }],
  };
  await assert.rejects(
    task.resume([{ ...a, output: 'changed' }, b], 'owner', body.model),
    /output_invalid/
  );
  const final = await task.resume([a, b], 'owner', body.model);
  assert.equal(final.output_text, 'done');
  assert.deepEqual(await task.resume([a, b], 'owner', body.model), final);
  await assert.rejects(
    task.resume([{ ...b, type: 'function_call_output' }], 'owner', body.model),
    /output_invalid/
  );
  assert.equal(starts, 1);
  assert.equal(calls, 2);
  await task.done;
});

test('session accepts unchanged native catalogs with reordered JSON members and message metadata', async () => {
  const loaded = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'namespace', name: 'functions', tools }],
  };
  const request = { ...body, tools: [], input: [loaded, ...body.input] };
  const task = createTianxiNativeSession({ body: request, owner: 'owner', run: fakeRun });
  const call = (await task.next()).output[0];
  const reordered = {
    id: 'cli_metadata',
    tools: [
      {
        tools: [
          {
            format: tools[0].format,
            description: tools[0].description,
            namespace: 'functions',
            name: 'exec',
            type: 'custom',
          },
        ],
        name: 'functions',
        type: 'namespace',
      },
    ],
    role: 'developer',
    type: 'additional_tools',
  };
  const result = await task.resume(
    [
      reordered,
      { ...body.input[0], type: 'message', id: 'cli_message' },
      {
        type: 'custom_tool_call',
        name: 'functions.exec',
        call_id: call.call_id,
        input: call.input,
      },
      { type: 'custom_tool_call_output', call_id: call.call_id, output: 'ok' },
    ],
    'owner',
    body.model
  );
  assert.equal(result.output_text, 'ok');
  await task.done;
});

test('native description revisions retain original contracts and only the inspected revisions resume', async () => {
  const initial = fs.readFileSync(
    path.join(__dirname, 'fixtures/tianxi-codex-exec-initial.txt'),
    'utf8'
  );
  const deferred = fs.readFileSync(
    path.join(__dirname, 'fixtures/tianxi-codex-exec-deferred.txt'),
    'utf8'
  );
  const blocks = (value) =>
    new Map(
      value
        .split(/(?=^### )/m)
        .slice(1)
        .map((block) => [block.split('\n')[0], block])
    );
  const before = blocks(initial),
    after = blocks(deferred);
  assert.equal(before.size, 7);
  assert.equal(after.size, 10);
  for (const [name, contract] of before) assert.equal(after.get(name), contract);
  const loaded = (description) => ({
    type: 'additional_tools',
    role: 'developer',
    tools: [{ ...tools[0], description }],
  });
  const request = { ...body, tools: [], input: [loaded(initial), ...body.input] };
  let actualDescription;
  const task = createTianxiNativeSession({
    body: request,
    owner: 'owner',
    run(options) {
      actualDescription = options.tools[0].description;
      return fakeRun(options);
    },
  });
  const call = (await task.next()).output[0];
  const result = { type: 'custom_tool_call_output', call_id: call.call_id, output: 'ok' };
  await assert.rejects(
    task.resume([loaded(deferred + '\nchanged authority'), result], 'owner', body.model),
    /tool_history_unsupported/
  );
  assert.equal(
    (await task.resume([loaded(deferred), result], 'owner', body.model)).output_text,
    'ok'
  );
  assert.ok(actualDescription.endsWith(initial));
  await task.done;
});

test('session cancellation, empty finals and provider failures end with fixed safe errors', async () => {
  const task = session();
  await task.next();
  task.cancel();
  await task.done;
  assert.equal((await task.next()).status, 'failed');
  for (const run of [
    async () => ({ finalText: '' }),
    async () => {
      throw new Error('token=PRIVATE');
    },
  ]) {
    const failed = createTianxiNativeSession({ body, owner: 'owner', run });
    const result = await failed.next();
    await failed.done;
    assert.equal(result.status, 'failed');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('loopback server authenticates, bounds input and roundtrips real Responses SSE call/result shapes', async (t) => {
  const token = 'a'.repeat(64);
  const gateway = createTianxiNativeProbeServer({ token, model: body.model, run: fakeRun });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  t.after(() => gateway.close());
  const url = `http://127.0.0.1:${gateway.server.address().port}/v1/responses`;
  const send = (value, headers = {}, target = url) =>
    fetch(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body: typeof value === 'string' ? value : JSON.stringify(value),
    });
  assert.equal((await send(body, { Authorization: 'bad' })).status, 401);
  assert.equal((await send(body, { Origin: 'https://untrusted.invalid' })).status, 401);
  assert.equal((await send(body, {}, url + '/other')).status, 404);
  for (const value of [
    'not-json',
    { ...body, model: 'unknown', stream: false },
    body,
    'x'.repeat(2 * 1024 * 1024 + 1),
  ])
    assert.equal((await send(value)).status, 400);
  const first = await send({
    ...body,
    stream: true,
    input: [
      {
        role: 'developer',
        content: [{ type: 'input_text', text: 'permissions sandbox workspace-write PRIVATE' }],
      },
      ...body.input,
    ],
  });
  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  const sse = await first.text();
  const events = sse
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  const call = events.find((event) => event.type === 'response.output_item.done').item;
  assert.equal(call.namespace, 'functions');
  assert.equal(call.input, 'native_source');
  assert.ok(events.some((event) => event.type === 'response.custom_tool_call_input.delta'));
  assert.ok(gateway.contextShapes.length > 0);
  assert.ok(!JSON.stringify(gateway.contextShapes).includes('PRIVATE'));
  const invalid = await send({
    model: body.model,
    stream: true,
    input: [{ type: 'custom_tool_call_output', call_id: 'forged', output: 'PRIVATE' }],
  });
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes('PRIVATE'));
  const final = await send({
    model: body.model,
    stream: false,
    input: [
      {
        type: 'custom_tool_call_output',
        call_id: call.call_id,
        output: [{ type: 'input_text', text: 'result' }],
      },
    ],
  });
  assert.equal((await final.json()).output_text, 'result');
  await gateway.close();
  await gateway.close();
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..'))).includes(
      'test/tianxi-native-responses-adapter.test.js'
    )
  );
});

test('server streams function calls, final text and safe provider failures', async (t) => {
  for (const failing of [false, true]) {
    const token = 'b'.repeat(64);
    const gateway = createTianxiNativeProbeServer({
      token,
      model: body.model,
      run: async (options) => {
        if (failing) throw new Error('PRIVATE');
        await options.onCall(
          options.tools[0].name,
          { path: 'fixture.txt' },
          { signal: options.signal }
        );
        return { finalText: 'FINAL' };
      },
    });
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    t.after(() => gateway.close());
    const url = `http://127.0.0.1:${gateway.server.address().port}/v1/responses`;
    const send = (value) =>
      fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: body.model, stream: true, ...value }),
      });
    const first = await (
      await send({
        input: body.input,
        tools: [
          { type: 'function', name: 'read', description: 'read', parameters: { type: 'object' } },
        ],
      })
    ).text();
    assert.ok(!first.includes('PRIVATE'));
    if (failing) {
      assert.ok(first.includes('response.failed'));
      assert.deepEqual(gateway.failureCodes, ['tianxi_native_session_failed']);
    } else {
      const events = first
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
      const call = events.find((event) => event.type === 'response.output_item.done').item;
      assert.equal(call.type, 'function_call');
      assert.equal(call.arguments, '{"path":"fixture.txt"}');
      assert.ok(first.includes('response.function_call_arguments.delta'));
      const final = await (
        await send({
          input: [{ type: 'function_call_output', call_id: call.call_id, output: 'ok' }],
        })
      ).text();
      assert.ok(final.includes('response.output_text.delta'));
      assert.ok(final.includes('FINAL'));
      assert.ok(final.includes('response.completed'));
    }
    await gateway.close();
  }
});

test('disconnect cancels a waiting provider and server close is idempotent', async () => {
  let started,
    stopped = false;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const token = 'c'.repeat(64);
  const gateway = createTianxiNativeProbeServer({
    token,
    model: body.model,
    run: async (options) => {
      started();
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          'abort',
          () => {
            stopped = true;
            reject(new Error('cancelled'));
          },
          { once: true }
        )
      );
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const waiting = fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, stream: true }),
    signal: controller.signal,
  });
  await ready;
  controller.abort();
  await assert.rejects(waiting);
  await gateway.close();
  await gateway.close();
  assert.equal(stopped, true);
  for (const token of ['', 'bad', 'a'.repeat(63)])
    assert.throws(
      () => createTianxiNativeProbeServer({ token, model: body.model }),
      /server_invalid/
    );
});

test('live acceptance requires real edits, tool execution, exact marker and an actual provider', () => {
  const evidence = {
    exitCode: 0,
    edited: true,
    finalAnswer: 'random-marker',
    marker: 'random-marker',
    calls: ['exec_command', 'apply_patch', 'exec_command'],
    rejectedCalls: 0,
    realProvider: true,
  };
  assert.deepEqual(evaluateNativeProbe(evidence), { toolExecutionPassed: true, passed: true });
  for (const change of [
    { exitCode: 1 },
    { edited: false },
    { finalAnswer: 'invented' },
    { marker: '' },
    { calls: ['exec_command', 'apply_patch'] },
    { rejectedCalls: 1 },
    { realProvider: false },
  ])
    assert.equal(evaluateNativeProbe({ ...evidence, ...change }).passed, false);
  assert.equal(evaluateNativeProbe({ ...evidence, realProvider: false }).toolExecutionPassed, true);
});

test('native probe waits only on cells observed in its own native output', () => {
  const scope = createTianxiNativeProbeScope();
  const wait = (args) => ({
    type: 'function_call',
    namespace: 'functions',
    name: 'wait',
    arguments: JSON.stringify(args),
  });
  assert.throws(() => scope.accept(wait({ cell_id: '2' })), /out_of_scope/);
  scope.observeOutput('Script running with cell ID 2\nWall time 31 seconds');
  scope.accept(wait({ cell_id: '2', yield_time_ms: 1000, max_tokens: 2000 }));
  scope.accept(wait({ cell_id: '2', terminate: true }));
  for (const args of [
    null,
    [],
    { cell_id: 'other' },
    { cell_id: '2', extra: true },
    { cell_id: '2', yield_time_ms: 60001 },
    { cell_id: '2', max_tokens: 0 },
    { cell_id: '2', terminate: 'true' },
  ])
    assert.throws(() => scope.accept(wait(args)), /out_of_scope/);
  assert.throws(
    () => scope.accept({ ...wait({ cell_id: '2' }), arguments: 'not-json' }),
    /out_of_scope/
  );
  assert.throws(
    () => scope.accept({ ...wait({ cell_id: '2' }), namespace: 'other' }),
    /out_of_scope/
  );
  scope.accept({
    type: 'custom_tool_call',
    namespace: 'functions',
    name: 'exec',
    input: 'text(await tools.exec_command({cmd:"fixture"}));',
  });
  assert.throws(
    () =>
      scope.accept({
        type: 'custom_tool_call',
        namespace: 'functions',
        name: 'exec',
        input: 'text(await tools.create_goal({}));',
      }),
    /out_of_scope/
  );
  assert.throws(() => scope.accept({}), /out_of_scope/);
  assert.deepEqual(scope.calls, ['functions.wait', 'functions.wait', 'exec_command']);
  assert.equal(scope.rejectedCalls, 12);
  for (const input of [null, '', 'x'.repeat(60001)]) scope.observeOutput(input);
});

test('isolated invocation preserves native Windows sandbox implementation and bounds trusted workspace', () => {
  const root = path.join(os.tmpdir(), 'hpm-tianxi-codex-native-fixture');
  const args = nativeProbePermissionArgs(root);
  assert.ok(args.includes('default_permissions=":workspace"'));
  assert.ok(args.includes('windows.sandbox="elevated"'));
  assert.equal(args[args.indexOf('-C') + 1], root);
  assert.equal(args[args.indexOf('--add-dir') + 1], root);
  assert.ok(!args.join(' ').includes('danger-full-access'));
  assert.ok(!args.join(' ').includes('bypass'));
  for (const invalid of [
    null,
    '',
    '.',
    os.tmpdir(),
    root + '\0',
    path.join(root, '..', 'other'),
    'x'.repeat(1025),
  ])
    assert.throws(() => nativeProbePermissionArgs(invalid), /workspace_invalid/);
});

test(
  'probe shutdown closes an active client that never finishes sending its body',
  { timeout: 2000 },
  async () => {
    const gateway = createTianxiNativeProbeServer({
      token: 'd'.repeat(64),
      model: body.model,
      run: fakeRun,
    });
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const socket = net.connect(gateway.server.address().port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      'POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ' +
        'd'.repeat(64) +
        '\r\nContent-Length: 100\r\n\r\n'
    );
    await new Promise((resolve) => setImmediate(resolve));
    const disconnected = new Promise((resolve) => socket.once('close', resolve));
    await gateway.close();
    await disconnected;
    await gateway.close();
  }
);
