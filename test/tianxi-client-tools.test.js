'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path').win32;
const {
  compileTianxiClientRead,
  tianxiClientReadMetadata,
  tianxiClientCommandInput,
  tianxiClientArgumentFailure,
} = require('../lib/proxy/tianxi-client-read-tools');
const {
  createTianxiClientToolSessions,
  parseClientOutputs,
  serveTianxiClientToolLease,
} = require('../lib/proxy/tianxi-client-tool-sessions');
const { createTianxiOfficialHandlers } = require('../lib/proxy/tianxi-official-handlers');
const { resolveTianxiResultBridge } = require('../lib/proxy/tianxi-tool-result-continuation');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const { createTianxiClientToolStream } = require('../lib/proxy/tianxi-client-tool-stream');
const { TIANXI_SDK_MODELS } = require('../lib/proxy/tianxi-sdk-models');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nativeTools = {
  cwd: 'C:\\repo',
  disallowedTools: ['Write', 'Edit', 'Bash', 'Task', 'Agent'],
};
const action = (name, parameters) => ({ mcpServerName: 'codex_readonly', name, parameters });
const tools = [
  {
    type: 'namespace',
    name: 'functions',
    tools: [{ type: 'custom', name: 'exec', description: 'Use ALL_TOOLS and tools.exec_command' }],
  },
];
const fakeFs = {
  realpathSync: {
    native(value) {
      return path.normalize(value);
    },
  },
  existsSync: () => true,
  statSync(value) {
    return { isFile: () => value.endsWith('.txt'), isDirectory: () => !value.endsWith('.txt') };
  },
};
function fakeResponse() {
  const res = new EventEmitter();
  Object.assign(res, {
    body: '',
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(value) {
      this.body += value;
    },
    end(value = '') {
      this.body += value;
      this.writableEnded = true;
      this.emit('close');
    },
  });
  return res;
}
function fixture(manager, count = 1, extra = {}) {
  const state = { queries: 0, replies: 0, outputs: [], payload: null, signal: null };
  const lease = manager.start({
    owner: 'owner',
    model: 'tianxi/super',
    payload: {},
    nativeTools,
    async run(payload, context) {
      state.queries++;
      state.payload = payload;
      state.signal = context.signal;
      for (let i = 0; i < count; i++) {
        await new Promise((resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('SECRET aborted')), {
            once: true,
          });
          context.onExternalToolCall(
            { data: { actions: [action('read_file', { file_path: 'probe.txt' })] } },
            (outputs) => {
              state.replies++;
              state.outputs.push(outputs[0]);
              resolve();
              return true;
            }
          );
        });
      }
      return {
        frames: [
          { type: 'task_output', data: { content_type: 'text', content: 'FINAL' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ],
      };
    },
    ...extra,
  });
  return { lease, state };
}
const output = (call, value = 'result') => ({
  type: 'custom_tool_call_output',
  call_id: call.call_id,
  output: value,
});

test('public operation explanation is validated and never enters shell arguments', () => {
  for (const name of ['read_file', 'find_files', 'search_text']) {
    const args = name === 'read_file' ? { file_path: 'probe.txt' } : { pattern: 'probe' };
    const compiled = compileTianxiClientRead(
      action(name, { ...args, progress: '正在检查审计配置。' }),
      nativeTools.cwd,
      fakeFs
    );
    assert.ok(!JSON.stringify(compiled).includes('正在检查'));
    for (const progress of ['', '   ', null, 12, {}, 'x'.repeat(321), 'a\nb', '\u001bsecret'])
      assert.throws(
        () => compileTianxiClientRead(action(name, { ...args, progress }), nativeTools.cwd, fakeFs),
        /arguments_invalid/
      );
    const hostile = { ...args };
    Object.defineProperty(hostile, 'progress', {
      enumerable: true,
      get() {
        throw new Error('must not run');
      },
    });
    assert.throws(
      () => compileTianxiClientRead(action(name, hostile), nativeTools.cwd, fakeFs),
      /arguments_invalid/
    );
    assert.doesNotThrow(() =>
      compileTianxiClientRead(
        action(name, { ...args, progress: 'x'.repeat(320) }),
        nativeTools.cwd,
        fakeFs
      )
    );
  }
});

test('commentary boundary ignores empty, hostile, malformed and repeated explanations', () => {
  const res = fakeResponse();
  const stream = createTianxiClientToolStream(res, 'tianxi/super');
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('private');
      },
    }
  );
  for (const value of [
    hostile,
    {},
    { progress: null },
    { progress: ' ' },
    { progress: 'a\nb' },
    { progress: 'x'.repeat(321) },
  ])
    assert.doesNotThrow(() => stream.notice(value));
  stream.notice({ progress: '正在检查项目配置。' });
  stream.notice({ progress: '正在检查项目配置。' });
  const final = stream.finish({ status: 'completed', output: [], output_text: '' });
  assert.equal(final.output.length, 1);
  assert.equal(final.output[0].phase, 'commentary');
  assert.equal(final.output_text, '');
  assert.ok(!res.body.includes('private'));
  stream.notice({ progress: 'closed' });
  assert.ok(!res.body.includes('closed'));
});

test('model public explanation precedes the actual client tool card without generic resumed text', async () => {
  const manager = createTianxiClientToolSessions({
    compile: (value) => compileTianxiClientRead(value, nativeTools.cwd, fakeFs),
  });
  const { lease, state } = fixture(manager, 0, {
    async run(payload, context) {
      state.payload = payload;
      await new Promise((resolve) =>
        context.onExternalToolCall(
          {
            data: {
              actions: [
                action('read_file', {
                  file_path: 'probe.txt',
                  progress: '正在读取审计记录，确认本次检查范围。',
                }),
              ],
            },
          },
          () => {
            resolve();
            return true;
          }
        )
      );
      return {
        frames: [
          { type: 'task_output', data: { content_type: 'text', content: 'FINAL' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ],
      };
    },
  });
  const res = fakeResponse();
  const first = await serveTianxiClientToolLease(res, lease, true);
  const call = first.output.find((item) => item.type === 'custom_tool_call');
  assert.equal(first.output.at(-2).content[0].text, '正在读取审计记录，确认本次检查范围。');
  assert.ok(state.payload.instructions.includes('user-facing sentence'));
  assert.ok(state.payload.input.includes('include progress:'));
  assert.ok(state.payload.input.includes('User task:'));
  for (const requirement of [
    'positive find_files globs can override ignore rules',
    'read_file tail',
    'include_metadata true',
    'historical test artifacts',
    'not that no commands ran',
    'final summary and exit status',
    'Do not infer timeout causes',
    'avoid repetitive praise',
    'Honor the user requested final-answer format',
  ]) {
    assert.ok(state.payload.input.includes(requirement));
    assert.ok(state.payload.instructions.includes(requirement));
  }
  const following = manager.resume('owner', [output(call)]);
  const final = await serveTianxiClientToolLease(fakeResponse(), following, true);
  assert.equal(final.output_text, 'FINAL');
  assert.ok(!JSON.stringify(final).includes('正在继续处理'));
  manager.close();
});

test('argument classification uses fixed reasons and never executes exception accessors', () => {
  for (const [name, args, reason] of [
    ['read_file', { file_path: '../SECRET.txt' }, 'outside_workspace'],
    ['read_file', { file_path: 'probe.txt', offset: 0 }, 'read_range'],
    ['read_file', { file_path: 'probe.txt', SECRET: 'content' }, 'unknown_field'],
    ['read_file', null, 'argument_shape'],
    ['search_text', { pattern: '' }, 'search_pattern'],
    ['find_files', { pattern: '*', path: 'probe.txt' }, 'path_type'],
  ]) {
    let caught;
    try {
      compileTianxiClientRead(action(name, args), nativeTools.cwd, fakeFs);
    } catch (error) {
      caught = error;
    }
    const failure = tianxiClientArgumentFailure(new Error('SECRET', { cause: caught }));
    assert.equal(failure?.reason, reason);
    assert.ok(!JSON.stringify(failure).includes('SECRET'));
  }
  let accesses = 0;
  assert.equal(
    tianxiClientArgumentFailure({
      get argumentReason() {
        accesses++;
        throw new Error('SECRET');
      },
    }),
    null
  );
  assert.equal(accesses, 0);
  assert.equal(tianxiClientArgumentFailure({ argumentReason: 'SECRET' }), null);
  assert.equal(
    tianxiClientArgumentFailure(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('SECRET');
          },
        }
      )
    ),
    null
  );
  const schema =
    tianxiClientReadMetadata(nativeTools).options.customMcpServers.codex_readonly.tools[0]
      .inputSchema.properties.file_path;
  assert.equal(schema.minLength, 1);
  assert.equal(schema.maxLength, 1024);
  assert.equal(new RegExp(schema.pattern).test('normal.txt'), true);
  assert.equal(new RegExp(schema.pattern).test('line\nbreak'), false);
  assert.equal(new RegExp(schema.pattern).test('normal.txt\n'), false);
  for (const [cwd, fileSystem, reason] of [
    ['invalid', fakeFs, 'workspace'],
    [
      nativeTools.cwd,
      {
        ...fakeFs,
        statSync() {
          throw new Error('SECRET filesystem');
        },
      },
      'path_unavailable',
    ],
    [
      nativeTools.cwd,
      {
        ...fakeFs,
        realpathSync: {
          native(value) {
            if (value.endsWith('missing')) {
              const error = new Error('SECRET missing');
              error.code = 'ENOENT';
              throw error;
            }
            return value;
          },
        },
      },
      'path_missing',
    ],
  ]) {
    assert.throws(
      () =>
        compileTianxiClientRead(
          action('find_files', { pattern: '*', path: 'missing' }),
          cwd,
          fileSystem
        ),
      (error) => {
        assert.equal(tianxiClientArgumentFailure(error)?.reason, reason);
        assert.ok(!error.message.includes('SECRET'));
        return true;
      }
    );
  }
});

test('correctable argument errors return bounded native failures without executing rejected batches', async () => {
  for (const scenario of ['corrected', 'exhausted', 'unsafe', 'reply_throw', 'reply_false']) {
    const diagnostics = [],
      rejected = [];
    let nativeReplies = 0;
    const manager = createTianxiClientToolSessions({
      compile: (value) => compileTianxiClientRead(value, nativeTools.cwd, fakeFs),
      onDiagnostic: (value) => diagnostics.push(value),
      onCorrection: () => {
        throw new Error('SECRET diagnostic');
      },
    });
    const { lease } = fixture(manager, 0, {
      async run(_, context) {
        for (let index = 0; index < (scenario === 'exhausted' ? 3 : 1); index++) {
          context.onExternalToolCall(
            {
              data: {
                actions: [
                  action('read_file', { file_path: 'probe.txt' }),
                  action('read_file', {
                    file_path: scenario === 'unsafe' ? '../SECRET.txt' : 'probe.txt',
                    offset: scenario === 'unsafe' ? 1 : 0,
                  }),
                ],
              },
            },
            (values) => {
              nativeReplies++;
              rejected.push(...values);
              if (scenario === 'reply_throw') throw new Error('SECRET');
              return scenario !== 'reply_false';
            }
          );
        }
        if (scenario !== 'corrected') return { frames: [] };
        await new Promise((resolve) =>
          context.onExternalToolCall(
            { data: { actions: [action('read_file', { file_path: 'probe.txt' })] } },
            () => {
              nativeReplies++;
              resolve();
              return true;
            }
          )
        );
        return {
          frames: [
            { type: 'task_output', data: { content_type: 'final', content: 'FINAL' } },
            { type: 'task_status', data: { status: 'COMPLETED' } },
          ],
        };
      },
    });
    let result = await lease.promise;
    if (scenario === 'corrected') {
      assert.equal(result.output[0].type, 'custom_tool_call');
      result = await manager.resume('owner', [output(result.output[0])]).promise;
      assert.equal(result.output_text, 'FINAL');
      assert.equal(nativeReplies, 2);
      assert.deepEqual(diagnostics, []);
    } else {
      assert.notEqual(result.status, 'completed');
      assert.equal(nativeReplies, scenario === 'unsafe' ? 0 : scenario === 'exhausted' ? 2 : 1);
      if (scenario === 'exhausted') assert.equal(diagnostics[0].argumentReason, 'read_range');
      if (scenario === 'unsafe') assert.equal(diagnostics[0].argumentReason, 'outside_workspace');
    }
    assert.ok(!JSON.stringify({ result, diagnostics, rejected }).includes('SECRET'));
    for (const value of rejected) {
      assert.equal(JSON.parse(value).isError, true);
      assert.equal(JSON.parse(value).error.reason, 'read_range');
    }
    manager.close();
  }
});

test('late client output receives the native terminal result instead of a retrying 409', async () => {
  for (const { reason, size } of ['unsupported', 'provider', 'cancel'].flatMap((reason) =>
    [1, 2].map((size) => ({ reason, size }))
  )) {
    let rejectProvider,
      replies = 0,
      runs = 0;
    const manager = createTianxiClientToolSessions({ compile: () => ({ cmd: 'safe' }) });
    const { lease } = fixture(manager, 0, {
      run: (_, context) =>
        new Promise((resolve, reject) => {
          runs++;
          rejectProvider = reject;
          context.onExternalToolCall(
            {
              data: {
                actions: Array.from({ length: size }, () =>
                  action('read_file', { file_path: 'probe.txt' })
                ),
              },
            },
            () => {
              replies++;
              resolve({ frames: [] });
              return true;
            }
          );
        }),
    });
    let call = (await lease.promise).output[0];
    if (size === 2)
      call = (await manager.resume('owner', [output(call, 'first result')]).promise).output[0];
    if (reason === 'cancel') lease.cancel();
    else
      rejectProvider(
        new Error(reason === 'unsupported' ? 'tianxi_client_native_tool_unsupported' : 'SECRET')
      );
    await tick();
    const submitted = output(call, 'SECRET result');
    assert.throws(() => manager.resume('other', [submitted]), /call_not_found/);
    const resumed = manager.resume('owner', [submitted]);
    const duplicate = manager.resume('owner', [submitted]);
    assert.equal(resumed.promise, duplicate.promise);
    const final = await resumed.promise;
    assert.notEqual(final.status, 'completed');
    if (reason === 'unsupported') assert.ok(final.error.message.includes('不支持的原生工具'));
    assert.ok(!JSON.stringify(final).includes('SECRET'));
    assert.ok(!final.output.some((item) => item.type === 'custom_tool_call'));
    assert.equal(runs, 1);
    assert.equal(replies, 0);
    assert.throws(() => manager.resume('owner', [output(call, 'different')]), /output_conflict/);
    const res = fakeResponse();
    const delivered = await serveTianxiClientToolLease(res, duplicate, true);
    assert.equal(delivered.status, final.status);
    assert.ok(!res.body.includes('SECRET'));
    manager.close();
    if (reason === 'cancel') rejectProvider(new Error('aborted'));
  }
});

test('SSE starts visibly before provider output and keeps model, ID, phase and indexes', async () => {
  let finish, context;
  const manager = createTianxiClientToolSessions();
  const { lease } = fixture(manager, 0, {
    model: 'tianxi/custom-model',
    run: (_, value) => {
      context = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const res = fakeResponse();
  const pending = serveTianxiClientToolLease(res, lease, true);
  assert.ok(res.body.includes('天禧任务已开始'));
  assert.ok(!res.body.includes('custom_tool_call'));
  await tick();
  for (const status of ['WORKING', 'WORKING', 'RUNNING'])
    context.onFrame({ type: 'task_status', data: { status } });
  finish({
    frames: [
      { type: 'task_output', data: { content_type: 'text', content: 'FINAL' } },
      { type: 'task_status', data: { status: 'COMPLETED' } },
    ],
  });
  const final = await pending;
  const events = res.body
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(events[0].response.model, 'tianxi/custom-model');
  assert.equal(events[0].response.id, final.id);
  assert.equal(events.filter((event) => event.type === 'response.created').length, 1);
  assert.equal(final.output.filter((item) => item.phase === 'commentary').length, 1);
  assert.equal(final.output.at(-1).phase, 'final_answer');
  assert.equal(final.output_text, 'FINAL');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'response.output_item.added')
      .map((event) => event.output_index),
    [0, 1]
  );
  manager.close();
});

test('valid batches serialize 2 and 8 reads, deduplicate results and reply once in order', async () => {
  for (const size of [2, 8]) {
    let replies = 0,
      received;
    const manager = createTianxiClientToolSessions({ compile: () => ({ cmd: 'safe' }) });
    const { lease } = fixture(manager, 0, {
      async run(_, context) {
        await new Promise((resolve) =>
          context.onExternalToolCall(
            { data: { actions: Array.from({ length: size }, (_, id) => ({ id: String(id) })) } },
            (values) => {
              replies++;
              received = [...values];
              resolve();
              return true;
            }
          )
        );
        return {
          frames: [
            { type: 'task_output', data: { content_type: 'text', content: 'FINAL' } },
            { type: 'task_status', data: { status: 'COMPLETED' } },
          ],
        };
      },
    });
    let result = await lease.promise;
    for (let i = 0; i < size; i++) {
      const submitted = output(result.output[0], String(i));
      assert.throws(() => manager.resume('other', [submitted]), /call_not_found/);
      const next = manager.resume('owner', [submitted]);
      const duplicate = manager.resume('owner', [submitted]);
      assert.equal(next.promise, duplicate.promise);
      result = await next.promise;
      assert.equal(replies, i === size - 1 ? 1 : 0);
    }
    assert.equal(result.status, 'completed');
    assert.deepEqual(
      received,
      Array.from({ length: size }, (_, i) => String(i))
    );
    manager.close();
  }
});

test('batch validation is atomic, oversized batches and result totals terminate safely', async () => {
  for (const scenario of ['invalid_later', 'too_many', 'oversized_results', 'reply_throw']) {
    let replies = 0,
      signal;
    const diagnostics = [];
    const manager = createTianxiClientToolSessions({
      compile: (value) => {
        if (value.bad) throw new Error('tianxi_client_tool_arguments_invalid');
        return { cmd: 'safe' };
      },
      onDiagnostic: (value) => diagnostics.push(value),
    });
    const size = scenario === 'too_many' ? 9 : scenario === 'oversized_results' ? 5 : 2;
    const { lease } = fixture(manager, 0, {
      run: (_, context) =>
        new Promise((resolve, reject) => {
          signal = context.signal;
          context.signal.addEventListener('abort', () => reject(new Error('SECRET')), {
            once: true,
          });
          context.onExternalToolCall(
            {
              data: {
                actions: Array.from({ length: size }, (_, i) => ({
                  bad: scenario === 'invalid_later' && i === 1,
                })),
              },
            },
            () => {
              replies++;
              if (scenario === 'reply_throw') throw new Error('SECRET');
              resolve({ frames: [] });
              return true;
            }
          );
        }),
    });
    let result = await lease.promise;
    while (result.output[0]?.type === 'custom_tool_call') {
      result = await manager.resume('owner', [
        output(result.output[0], scenario === 'oversized_results' ? 'x'.repeat(65536) : 'safe'),
      ]).promise;
    }
    assert.equal(result.status, 'failed');
    assert.equal(signal.aborted, true);
    assert.equal(replies, scenario === 'reply_throw' ? 1 : 0);
    assert.equal(diagnostics.length, 1);
    assert.ok(!JSON.stringify({ result, diagnostics }).includes('SECRET'));
    assert.equal(
      diagnostics[0].category,
      scenario === 'invalid_later'
        ? 'tianxi_client_tool_arguments_invalid'
        : scenario === 'too_many'
          ? 'tianxi_client_action_batch_unsupported'
          : scenario === 'oversized_results'
            ? 'tianxi_client_output_batch_too_large'
            : 'tianxi_client_provider_failed'
    );
    manager.close();
  }
});

test('untrusted diagnostic codes and throwing diagnostic sinks cannot prevent termination', async () => {
  for (const throwing of [false, true]) {
    const diagnostics = [];
    const manager = createTianxiClientToolSessions({
      onDiagnostic: (value) => {
        diagnostics.push(value);
        if (throwing) throw new Error('SECRET');
      },
    });
    const { lease } = fixture(manager, 0, {
      run() {
        throw {
          code: {
            toString() {
              throw new Error('SECRET');
            },
          },
        };
      },
    });
    const final = await lease.promise;
    assert.equal(final.status, 'failed');
    assert.deepEqual(diagnostics, [{ category: 'tianxi_client_provider_failed', clientCalls: 0 }]);
    assert.ok(!JSON.stringify(final).includes('SECRET'));
    manager.close();
  }
});

test('native error wrappers preserve allowlisted categories without leaking their messages', async () => {
  for (const scenario of ['native_wrapper', 'callback_wrapper']) {
    const diagnostics = [];
    const manager = createTianxiClientToolSessions({
      onDiagnostic: (value) => diagnostics.push(value),
    });
    const { lease } = fixture(manager, 0, {
      run(_, context) {
        if (scenario === 'native_wrapper')
          throw new Error('SECRET', { cause: new Error('tianxi_client_native_tool_unsupported') });
        try {
          context.onExternalToolCall({ data: { actions: [{}] } }, () => {});
        } catch {
          throw new Error('tianxi_external_tool_callback_failed');
        }
      },
    });
    const final = await lease.promise;
    assert.equal(final.status, 'failed');
    assert.equal(
      diagnostics[0].category,
      scenario === 'native_wrapper'
        ? 'tianxi_client_native_tool_unsupported'
        : 'tianxi_client_tool_arguments_invalid'
    );
    assert.ok(!JSON.stringify({ diagnostics, final }).includes('SECRET'));
    manager.close();
  }
});

test('hostile error accessors and proxies cannot break terminal failure delivery', async () => {
  let getterCalls = 0;
  for (const error of [
    Object.defineProperties(
      {},
      {
        code: {
          get() {
            getterCalls++;
            throw new Error('SECRET getter executed');
          },
        },
        cause: {
          get() {
            getterCalls++;
            throw new Error('SECRET cause getter executed');
          },
        },
      }
    ),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('SECRET');
        },
      }
    ),
  ]) {
    const diagnostics = [];
    const manager = createTianxiClientToolSessions({
      onDiagnostic: (value) => diagnostics.push(value),
    });
    const { lease } = fixture(manager, 0, {
      run() {
        throw error;
      },
    });
    const final = await lease.promise;
    assert.equal(final.status, 'failed');
    assert.deepEqual(diagnostics, [{ category: 'tianxi_client_provider_failed', clientCalls: 0 }]);
    assert.ok(!JSON.stringify(final).includes('SECRET'));
    assert.equal(getterCalls, 0);
    manager.close();
  }
});

test('transport and terminal failures retain safe categories through native wrappers', async () => {
  for (const category of [
    'tianxi_external_tool_invalid',
    'tianxi_external_tool_callback_failed',
    'tianxi_tac_server_aborted',
    'tianxi_tac_server_send_failed',
    'tianxi_tac_server_ws_error',
    'tianxi_tac_server_incomplete',
    'tianxi_tac_server_output_limit',
    'tianxi_client_terminal_invalid',
  ]) {
    const diagnostics = [];
    const manager = createTianxiClientToolSessions({
      onDiagnostic: (value) => diagnostics.push(value),
    });
    const { lease } = fixture(manager, 0, {
      run() {
        const cause = new Error('SECRET user content');
        cause.code = category;
        const wrapper = new Error('SECRET wrapper', { cause });
        wrapper.code = 'tianxi_native_runtime_failed';
        throw wrapper;
      },
    });
    const final = await lease.promise;
    assert.equal(final.status, 'failed');
    assert.deepEqual(diagnostics, [{ category, clientCalls: 0 }]);
    assert.ok(!JSON.stringify({ final, diagnostics }).includes('SECRET'));
    manager.close();
  }
});

test('read compiler quotes literal paths and bounds line selection', () => {
  const compiled = compileTianxiClientRead(
    action('read_file', {
      file_path: "quoted'; Write-Output INJECTED; '.txt",
      offset: 2,
      limit: 3,
    }),
    nativeTools.cwd,
    fakeFs
  );
  assert.ok(compiled.cmd.includes("quoted''; Write-Output INJECTED; ''.txt'"));
  assert.ok(compiled.cmd.endsWith('-TotalCount 4 | Select-Object -Skip 1 -First 3'));
  assert.equal(compiled.login, false);
  assert.equal(compiled.workdir, nativeTools.cwd);
});
test('command wrapper preserves standard string, object and MCP text returns; malformed results fail', async () => {
  const vm = require('node:vm');
  for (const result of [
    'text',
    { output: 'text' },
    { content: [{ type: 'text', text: 'text' }] },
    { output: '' },
    { content: [] },
  ]) {
    const parts = [];
    await vm.runInNewContext(
      '(async () => {' + tianxiClientCommandInput({ cmd: 'fixed' }) + '})()',
      {
        tools: { exec_command: async () => result },
        text: (part) => parts.push(part),
      }
    );
    assert.equal(
      parts.join(''),
      typeof result === 'string'
        ? 'text'
        : (result.output ?? result.content.map((part) => part.text).join(''))
    );
  }
  for (const result of [
    null,
    {},
    { isError: true, content: [] },
    { content: [{ type: 'image', data: 'secret' }] },
  ])
    await assert.rejects(
      vm.runInNewContext('(async () => {' + tianxiClientCommandInput({ cmd: 'fixed' }) + '})()', {
        tools: { exec_command: async () => result },
        text() {
          throw new Error('unexpected emission');
        },
      }),
      /Client command (returned unsupported output|failed)/
    );
});
test('command wrapper waits for shell completion and emits ordered output only once', async () => {
  const vm = require('node:vm');
  const source = tianxiClientCommandInput({ cmd: 'fixed' });
  assert.ok(source.startsWith('// @exec: {"yield_time_ms": 120000}\n'));
  const parts = [],
    polls = [];
  let executions = 0;
  const results = [
    { output: 'second\n', session_id: 42, exit_code: null },
    { output: 'last\n', exit_code: 0 },
  ];
  await vm.runInNewContext('(async () => {\n' + source + '\n})()', {
    tools: {
      exec_command: async () => {
        executions++;
        return { output: 'first\n', session_id: 42 };
      },
      write_stdin: async (args) => {
        assert.deepEqual(parts, []);
        polls.push(JSON.parse(JSON.stringify(args)));
        return results.shift();
      },
    },
    text: (part) => parts.push(part),
  });
  assert.equal(executions, 1);
  assert.deepEqual(parts, ['first\nsecond\nlast\n']);
  assert.deepEqual(polls, [
    { session_id: 42, chars: '', yield_time_ms: 1000, max_output_tokens: 2000 },
    { session_id: 42, chars: '', yield_time_ms: 1000, max_output_tokens: 2000 },
  ]);
});

test('command wrapper contains failed, malformed and indefinitely running shell results', async () => {
  const vm = require('node:vm');
  const cases = [
    { output: 'SECRET', exit_code: 1 },
    { output: 'SECRET', exit_code: -1 },
    { output: 'SECRET', exit_code: '0' },
    { output: 'SECRET', exit_code: null },
    { output: 'SECRET', session_id: '42' },
    { output: 'SECRET', session_id: -1 },
    { output: 'SECRET', session_id: 42.5 },
    { output: 'SECRET', session_id: 42 },
  ];
  for (const result of cases) {
    const parts = [];
    let polls = 0;
    await assert.rejects(
      vm.runInNewContext(
        '(async () => {\n' + tianxiClientCommandInput({ cmd: 'fixed' }) + '\n})()',
        {
          tools: {
            exec_command: async () => result,
            write_stdin: async () => {
              polls++;
              return result;
            },
          },
          text: (part) => parts.push(part),
        }
      ),
      (error) =>
        /Client command (failed|did not complete)/.test(error.message) &&
        !error.message.includes('SECRET')
    );
    assert.deepEqual(parts, []);
    assert.equal(polls, result.session_id === 42 ? 90 : 0);
  }
  for (const result of [{ output: 'SECRET', exit_code: 1 }, null, { content: [], isError: true }]) {
    const parts = [];
    await assert.rejects(
      vm.runInNewContext(
        '(async () => {\n' + tianxiClientCommandInput({ cmd: 'fixed' }) + '\n})()',
        {
          tools: {
            exec_command: async () => ({ output: 'partial SECRET', session_id: 42 }),
            write_stdin: async () => result,
          },
          text: (part) => parts.push(part),
        }
      ),
      /Client command (failed|returned unsupported output)/
    );
    assert.deepEqual(parts, []);
  }
  const parts = [];
  let polls = 0;
  await assert.rejects(
    vm.runInNewContext('(async () => {\n' + tianxiClientCommandInput({ cmd: 'fixed' }) + '\n})()', {
      tools: {
        exec_command: async () => ({ output: 'partial', session_id: 42 }),
        write_stdin: async () => {
          polls++;
          throw new Error('transport failed');
        },
      },
      text: (part) => parts.push(part),
    }),
    /transport failed/
  );
  assert.equal(polls, 1);
  assert.deepEqual(parts, []);
});

test('slow reads can complete after eight polls without reexecuting the command', async () => {
  const vm = require('node:vm');
  let elapsed = 0,
    polls = 0,
    executions = 0;
  const parts = [];
  await vm.runInNewContext(
    '(async () => {\n' + tianxiClientCommandInput({ cmd: 'fixed' }) + '\n})()',
    {
      Date: { now: () => elapsed },
      tools: {
        exec_command: async () => {
          executions++;
          elapsed += 10000;
          return { output: 'first', session_id: 42 };
        },
        write_stdin: async () => {
          polls++;
          elapsed += 5000;
          return polls === 12 ? { output: 'last', exit_code: 0 } : { output: '', session_id: 42 };
        },
      },
      text: (value) => parts.push(value),
    }
  );
  assert.equal(executions, 1);
  assert.equal(polls, 12);
  assert.deepEqual(parts, ['firstlast']);
});

test('command wait deadline includes initial execution and bounds cumulative output', async () => {
  const vm = require('node:vm');
  for (const scenario of ['initial_deadline', 'poll_deadline', 'output_limit']) {
    let elapsed = 0,
      polls = 0;
    const emitted = [];
    await assert.rejects(
      vm.runInNewContext(
        '(async () => {\n' + tianxiClientCommandInput({ cmd: 'fixed' }) + '\n})()',
        {
          Date: { now: () => elapsed },
          tools: {
            exec_command: async () => {
              elapsed = scenario === 'initial_deadline' ? 90000 : 0;
              return { output: 'SECRET', session_id: 42 };
            },
            write_stdin: async () => {
              polls++;
              elapsed += 30000;
              return {
                output: scenario === 'output_limit' ? '界'.repeat(20000) : '',
                session_id: 42,
              };
            },
          },
          text: (value) => emitted.push(value),
        }
      ),
      /Client command (did not complete|output exceeds limit)/
    );
    assert.equal(polls, scenario === 'initial_deadline' ? 0 : scenario === 'poll_deadline' ? 3 : 1);
    assert.deepEqual(emitted, []);
  }
});

test('read compiler rejects unsafe paths, unknown fields and extreme input', () => {
  for (const args of [
    {},
    { file_path: '../outside.txt' },
    { file_path: 'D:\\other.txt' },
    { file_path: '\\\\host\\share\\file.txt' },
    { file_path: 'probe.txt:secret' },
    { file_path: 'probe\n.txt' },
    { file_path: 'probe.txt', command: 'write' },
    { file_path: 'probe.txt', offset: '1' },
    { file_path: 'probe.txt', limit: 2001 },
    { file_path: 'probe.txt', offset: -1 },
    { file_path: 'x'.repeat(1025) },
  ]) {
    assert.throws(() =>
      compileTianxiClientRead(action('read_file', args), nativeTools.cwd, fakeFs)
    );
  }
  const symlinkFs = {
    ...fakeFs,
    realpathSync: {
      native(value) {
        return value.endsWith('probe.txt') ? 'D:\\secret.txt' : value;
      },
    },
  };
  assert.throws(() =>
    compileTianxiClientRead(
      action('read_file', { file_path: 'probe.txt' }),
      nativeTools.cwd,
      symlinkFs
    )
  );
  assert.throws(() => compileTianxiClientRead(action('write_file', {}), nativeTools.cwd, fakeFs));
});
test('missing read file remains a client command failure while parent escape is rejected', () => {
  const missingFs = {
    ...fakeFs,
    existsSync: () => false,
    realpathSync: {
      native(value) {
        if (value.endsWith('.txt')) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return value;
      },
    },
  };
  assert.ok(
    compileTianxiClientRead(
      action('read_file', { file_path: 'missing.txt' }),
      nativeTools.cwd,
      missingFs
    ).cmd.includes('missing.txt')
  );
  const denied = {
    ...missingFs,
    realpathSync: {
      native() {
        const error = new Error('SECRET denied');
        error.code = 'EACCES';
        throw error;
      },
    },
  };
  assert.throws(() =>
    compileTianxiClientRead(
      action('read_file', { file_path: 'missing.txt' }),
      nativeTools.cwd,
      denied
    )
  );
});
test('glob and literal search compile only fixed command shapes', () => {
  const glob = compileTianxiClientRead(
    action('find_files', { pattern: '*.txt' }),
    nativeTools.cwd,
    fakeFs
  );
  const grep = compileTianxiClientRead(
    action('mcp__codex_readonly__search_text', { pattern: "-'; exit 1; '" }),
    nativeTools.cwd,
    fakeFs
  );
  assert.ok(
    glob.cmd.startsWith(
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; rg --files --glob '*.txt' -- 'C:\\repo'"
    )
  );
  assert.ok(grep.cmd.includes("--fixed-strings --max-count 100 -- '-''; exit 1; '''"));
  assert.ok(grep.cmd.endsWith('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'));
  for (const pattern of ['', null, [], 'a\nb'])
    assert.throws(() =>
      compileTianxiClientRead(action('search_text', { pattern }), nativeTools.cwd, fakeFs)
    );
});
test('metadata disables native tools and does not mutate inputs', () => {
  const next = tianxiClientReadMetadata(nativeTools);
  assert.equal(next.allowedTools.length, 3);
  assert.ok(next.disallowedTools.includes('Read'));
  assert.ok(next.disallowedTools.includes('TodoWrite'));
  for (const tool of next.options.customMcpServers.codex_readonly.tools)
    assert.ok(tool.inputSchema.required.includes('progress'));
  next.options.customMcpServers.codex_readonly.tools[0].name = 'mutated';
  assert.equal(
    tianxiClientReadMetadata(nativeTools).options.customMcpServers.codex_readonly.tools[0].name,
    'read_file'
  );
  assert.equal(
    resolveTianxiResultBridge(tools, [], { preferCodeMode: true, requireCommandExecutor: true })
      .name,
    'exec'
  );
  assert.equal(
    resolveTianxiResultBridge(
      [{ ...tools[0], tools: [{ ...tools[0].tools[0], description: 'ALL_TOOLS tools' }] }],
      [],
      { preferCodeMode: true, requireCommandExecutor: true }
    ),
    null
  );
});

test('native prompt includes the real task and the client contract without mutating caller input', async () => {
  const manager = createTianxiClientToolSessions();
  const payload = {
    input: [
      { role: 'user', content: 'earlier' },
      { role: 'user', content: '审计项目' },
    ],
  };
  const original = JSON.stringify(payload);
  const { lease, state } = fixture(manager, 0, { payload });
  await lease.promise;
  assert.ok(state.payload.input.endsWith('User task:\n审计项目'));
  assert.ok(state.payload.input.includes('instead of Read'));
  assert.equal(JSON.stringify(payload), original);
  assert.throws(
    () => fixture(manager, 0, { payload: { input: 'x'.repeat(128000) } }),
    /prompt_too_large/
  );
  manager.close();
});

test('unsupported native tool diagnostics expose only fixed tool kinds and never arguments', async () => {
  for (const name of ['Read', 'TodoWrite', 'Bash', 'SECRET_UNKNOWN_NAME']) {
    const diagnostics = [];
    const manager = createTianxiClientToolSessions({
      onDiagnostic: (value) => diagnostics.push(value),
    });
    const { lease } = fixture(manager, 0, {
      run: (_, context) =>
        context.onFrame({
          type: 'act_exec',
          data: {
            exec_mode: 'remote',
            actions: [{ name, parameters: { content: 'SECRET_CONTENT' } }],
          },
        }),
    });
    assert.equal((await lease.promise).status, 'failed');
    assert.equal(diagnostics[0].nativeToolKind, name.startsWith('SECRET') ? 'other' : name);
    assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
    manager.close();
  }
});
test('sequential client outputs resume one native task; duplicates never send twice', async () => {
  const manager = createTianxiClientToolSessions({ compile: () => ({ cmd: 'safe' }) });
  const { lease, state } = fixture(manager, 2);
  const first = (await lease.promise).output[0];
  const follow = manager.resume('owner', [output(first)]);
  const duplicate = manager.resume('owner', [output(first)]);
  assert.equal(follow.promise, duplicate.promise);
  const second = (await follow.promise).output[0];
  const last = manager.resume('owner', [output(first), output(second, '')]);
  const final = await last.promise;
  assert.equal(final.output_text, 'FINAL');
  assert.equal(state.queries, 1);
  assert.equal(state.replies, 2);
  assert.deepEqual(state.outputs, ['result', '']);
  assert.throws(() => manager.resume('owner', [output(first)]), /tianxi_client_output_stale/);
  assert.throws(
    () => manager.resume('owner', [output(second, 'changed')]),
    /tianxi_client_output_conflict/
  );
  manager.close();
});

test('valid client activity sustains a fifteen-minute task without restarting native execution', async () => {
  let time = 0;
  const manager = createTianxiClientToolSessions({
    compile: () => ({ cmd: 'safe' }),
    now: () => time,
    ttlMs: 600000,
    setSessionTimer: () => 1,
    clearSessionTimer() {},
  });
  const initial = fixture(manager, 12);
  let lease = initial.lease;
  for (let index = 0; index < 12; index++) {
    const result = await lease.promise;
    assert.equal(result.output[0].type, 'custom_tool_call');
    time += 75000;
    lease = manager.resume('owner', [output(result.output[0])]);
  }
  const final = await lease.promise;
  assert.equal(time, 900000);
  assert.equal(final.status, 'completed');
  assert.equal(initial.state.queries, 1);
  assert.equal(initial.state.replies, 12);
  assert.equal(initial.state.signal.aborted, false);
  manager.close();
});
test('owners and tasks cannot submit each others results; failures have no side effects', async () => {
  const manager = createTianxiClientToolSessions({ compile: () => ({ cmd: 'safe' }) });
  const a = fixture(manager),
    b = fixture(manager);
  const first = (await a.lease.promise).output[0],
    other = (await b.lease.promise).output[0];
  assert.throws(
    () => manager.resume('other-owner', [output(first)]),
    /tianxi_client_call_not_found/
  );
  assert.throws(
    () => manager.resume('owner', [output(first), output(other)]),
    /tianxi_client_continuation_invalid/
  );
  assert.throws(
    () => manager.resume('owner', [output(first), output(first, 'conflict')]),
    /tianxi_client_output_conflict/
  );
  assert.equal(a.state.replies, 0);
  assert.equal(b.state.replies, 0);
  manager.close();
  await tick();
  assert.equal(a.state.signal.aborted, true);
});
test('parser uses the current user turn and rejects malformed or mixed outputs', () => {
  const call = { call_id: 'call_tianxi_client_' + 'a'.repeat(32) };
  assert.equal(parseClientOutputs([output(call), { role: 'user', content: 'new task' }]), null);
  assert.equal(parseClientOutputs('hello'), null);
  for (const value of [null, {}, 'x'.repeat(65537)])
    assert.throws(() => parseClientOutputs([output(call, value)]));
  assert.throws(() =>
    parseClientOutputs([
      output(call),
      { type: 'custom_tool_call_output', call_id: 'unrelated', output: '' },
    ])
  );
  assert.throws(() => parseClientOutputs(Array(4097).fill({})));
});
test('expiration cancels waiting task and removes its call references', async () => {
  let now = 1;
  const manager = createTianxiClientToolSessions({
    compile: () => ({ cmd: 'safe' }),
    ttlMs: 100,
    now: () => now,
  });
  const { lease, state } = fixture(manager);
  const call = (await lease.promise).output[0];
  now = 101;
  assert.throws(() => manager.resume('owner', [output(call)]), /tianxi_client_call_not_found/);
  assert.equal(state.signal.aborted, true);
  manager.close();
});

test('valid operations renew the session and terminal replay gets its own full retention window', async () => {
  let clock = 1;
  const manager = createTianxiClientToolSessions({
    compile: () => ({ cmd: 'safe' }),
    ttlMs: 100,
    now: () => clock,
  });
  const { lease, state } = fixture(manager, 3);
  let result = await lease.promise;
  let submitted;
  for (let index = 0; index < 3; index++) {
    clock += 80;
    submitted = output(result.output[0], 'result-' + index);
    result = await manager.resume('owner', [submitted]).promise;
  }
  assert.equal(result.output_text, 'FINAL');
  assert.equal(state.replies, 3);
  assert.equal(state.signal.aborted, false);
  clock += 99;
  assert.strictEqual(await manager.resume('owner', [submitted]).promise, result);
  clock += 1;
  assert.throws(() => manager.resume('owner', [submitted]), /call_not_found/);
  manager.close();
});

test('stale expiry timers cannot cancel renewed activity; idle expiry has an accurate failure', async () => {
  let clock = 1,
    context;
  const timers = [];
  const manager = createTianxiClientToolSessions({
    ttlMs: 100,
    now: () => clock,
    setSessionTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearSessionTimer() {},
  });
  const { lease, state } = fixture(manager, 0, {
    run: (payload, value) => {
      context = value;
      state.signal = value.signal;
      return new Promise(() => {});
    },
  });
  await tick();
  clock = 80;
  context.onFrame({
    type: 'task_output',
    data: { content: 'public progress', content_type: 'text' },
  });
  timers[0]();
  assert.equal(state.signal.aborted, false);
  context.onFrame({ type: 'task_status', data: { status: 'WORKING' } });
  const expiry = timers.at(-1);
  expiry();
  const final = await lease.promise;
  assert.equal(final.status, 'failed');
  assert.match(final.error.message, /长时间没有有效活动/);
  assert.ok(!final.error.message.includes('disconnected'));
  assert.equal(state.signal.aborted, true);
  manager.close();
  timers.forEach((callback) => callback());
});
test('standard text content arrays normalize safely without accepting media or hidden fields', () => {
  const call = { call_id: 'call_tianxi_client_' + 'a'.repeat(32) };
  assert.equal(
    parseClientOutputs([
      output(call, [
        { type: 'input_text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ])[0].output,
    'a\nb'
  );
  assert.equal(parseClientOutputs([output(call, [])])[0].output, '');
  for (const value of [
    [{ type: 'input_image', image_url: 'secret' }],
    [{ type: 'input_text', text: 'a', hidden: 'secret' }],
    [{ type: 'input_text', text: 'é'.repeat(32769) }],
    Array(129).fill({ type: 'text', text: '' }),
  ])
    assert.throws(() => parseClientOutputs([output(call, value)]));
});
test('tool_choice none permits final response but cancels any next client call', async () => {
  const manager = createTianxiClientToolSessions({ compile: () => ({ cmd: 'safe' }) });
  const a = fixture(manager, 2),
    first = (await a.lease.promise).output[0];
  const lease = manager.resume('owner', [output(first)], { allowTools: false });
  const res = fakeResponse(),
    delivered = await serveTianxiClientToolLease(res, lease, true);
  assert.equal(delivered.status, 'failed');
  assert.equal(a.state.signal.aborted, true);
  assert.ok(!res.body.includes('response.custom_tool_call_input.delta'));
  const b = fixture(manager, 1),
    last = (await b.lease.promise).output[0];
  const final = await manager.resume('owner', [output(last)], { allowTools: false }).promise;
  assert.equal(final.output_text, 'FINAL');
  manager.close();
});
test('callback validation, provider failure and unsupported batches return safe terminal responses', async () => {
  for (const run of [
    () => {
      throw new Error('SECRET token prompt');
    },
    (_, context) => {
      context.onExternalToolCall({ data: { actions: [{}, {}] } }, () => {});
    },
    () => ({ frames: [{ type: 'risk_exec', data: {} }] }),
  ]) {
    const manager = createTianxiClientToolSessions();
    const { lease } = fixture(manager, 1, { run });
    const final = await lease.promise;
    assert.equal(final.status, 'failed');
    assert.ok(!JSON.stringify(final).includes('SECRET'));
    manager.close();
  }
});
test('capacity is bounded and SSE handoff closes without cancelling pending task', async () => {
  const manager = createTianxiClientToolSessions({
    compile: () => ({ cmd: 'safe' }),
    maxSessions: 1,
  });
  const { lease, state } = fixture(manager);
  assert.throws(() => fixture(manager), /tianxi_client_capacity_unavailable/);
  const res = fakeResponse();
  await serveTianxiClientToolLease(res, lease, true);
  assert.ok(res.body.includes('response.custom_tool_call_input.done'));
  assert.equal(state.signal.aborted, false);
  assert.equal(res.listenerCount('close'), 0);
  manager.close();
});
test('last permitted call can return its result and oversized final answers fail safely', async () => {
  const manager = createTianxiClientToolSessions({ compile: () => ({ cmd: 'safe' }) });
  const { lease, state } = fixture(manager, 128);
  let result = await lease.promise;
  for (let i = 0; i < 128; i++)
    result = await manager.resume('owner', [output(result.output[0])]).promise;
  assert.equal(result.status, 'completed');
  assert.equal(state.replies, 128);
  manager.close();
  const other = createTianxiClientToolSessions();
  const oversized = fixture(other, 0, {
    run: () => ({
      frames: [
        { type: 'task_output', data: { content_type: 'text', content: 'x'.repeat(1048577) } },
        { type: 'task_status', data: { status: 'COMPLETED' } },
      ],
    }),
  });
  assert.equal((await oversized.lease.promise).status, 'failed');
  other.close();
});
test('disconnect cancels first HTTP wait and write errors clean up its lease', async () => {
  for (const scenario of ['disconnect', 'write_error']) {
    let cancel = 0,
      resolve;
    const res = fakeResponse(),
      promise = new Promise((value) => {
        resolve = value;
      });
    const lease = {
      promise,
      cancel() {
        cancel++;
        resolve({ status: 'failed', output: [] });
      },
    };
    if (scenario === 'write_error')
      res.writeHead = () => {
        throw new Error('SECRET write');
      };
    const pending = serveTianxiClientToolLease(res, lease, true);
    if (scenario === 'disconnect') {
      res.destroyed = true;
      res.emit('close');
      await pending;
    } else await assert.rejects(pending, /tianxi_client_response_write_failed/);
    assert.equal(cancel, 1);
    assert.equal(res.listenerCount('close'), 0);
  }
});

test('closed responses cancel their lease without starting or finishing a stream', async () => {
  for (const stream of [false, true]) {
    for (const boundary of ['destroyed', 'writableEnded']) {
      for (const timing of ['before_wait', 'during_wait']) {
        const res = fakeResponse();
        let canceled = 0,
          subscribed = 0,
          delivered = 0,
          resolve;
        const value = { status: 'failed', output: [] };
        const lease = {
          promise: new Promise((done) => {
            resolve = done;
          }),
          cancel() {
            canceled++;
            resolve(value);
          },
          subscribe() {
            subscribed++;
            return () => {};
          },
          onDelivered() {
            delivered++;
          },
        };
        if (timing === 'before_wait') {
          res[boundary] = true;
          // Keep the old implementation from hanging: the assertions still
          // catch missing cancellation and attempts to write a closed response.
          resolve(value);
        }
        const pending = serveTianxiClientToolLease(res, lease, stream);
        const initialBody = res.body;
        if (timing === 'during_wait') {
          res[boundary] = true;
          resolve(value);
        }
        assert.equal(await pending, value);
        assert.equal(canceled, 1);
        assert.equal(delivered, 0);
        assert.equal(res.body, timing === 'before_wait' ? '' : initialBody);
        assert.equal(subscribed, stream && timing === 'during_wait' ? 1 : 0);
        assert.equal(res.listenerCount('close'), 0);
      }
    }
  }
});
test('final SSE history uses the emitted response ID', async () => {
  let saved;
  const manager = createTianxiClientToolSessions();
  const { lease } = fixture(manager, 0, {
    onFinal: (final) => {
      saved = final.id;
    },
  });
  const res = fakeResponse(),
    delivered = await serveTianxiClientToolLease(res, lease, true);
  assert.equal(saved, delivered.id);
  assert.ok(res.body.includes(saved));
  manager.close();
});
test('returned external starts preserve process boundaries without phantom pending calls', async () => {
  const manager = createTianxiClientToolSessions({ compile: () => ({ cmd: 'safe' }) });
  const external = {
    type: 'act_exec',
    data: {
      exec_mode: 'local',
      actions: [
        {
          ...action('read_file', { file_path: 'probe.txt' }),
          id: 'opaque:read/1',
        },
      ],
    },
  };
  const { lease } = fixture(manager, 1, {
    async run(_, context) {
      await new Promise((resolve) =>
        context.onExternalToolCall(external, () => {
          resolve();
          return true;
        })
      );
      return {
        frames: [
          { type: 'task_output', data: { content_type: 'text', content: '正在核对文件。' } },
          external,
          { type: 'task_output', data: { content_type: 'text', content: 'FINAL' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ],
      };
    },
  });
  const call = (await lease.promise).output[0];
  const final = await manager.resume('owner', [output(call)]).promise;
  assert.equal(final.status, 'completed');
  assert.equal(final.incomplete_details, null);
  assert.equal(final.output_text, 'FINAL');
  assert.ok(final.output.every((item) => item.type === 'message'));
  manager.close();
});
for (const sdkScenario of [null, ...TIANXI_SDK_MODELS])
  test(`HTTP handler starts and resumes client execution without creating another native task (${sdkScenario?.modelId || 'super'})`, async () => {
    let queries = 0;
    const manager = createTianxiClientToolSessions({ compile: () => ({ cmd: 'safe' }) });
    const handlers = createTianxiOfficialHandlers({
      clientToolSessions: manager,
      resolveTianxiNativeReadTools: () => nativeTools,
      supportsTianxiClientTools: () => true,
      logRequestEnd() {},
      openAIResponsesToChat: () => ({}),
      sendJsonError(res, status, body) {
        res.writeHead(status, {});
        res.end(JSON.stringify(body));
      },
      async callTianxiOfficialBridge(_payload, _profile, context) {
        if (sdkScenario) {
          assert.equal(_payload.metadata.tianxi.sdk_model, undefined);
          assert.equal(_payload.metadata.tianxi.agent_id, 'super');
          assert.equal(_payload.metadata.tianxi.llm, sdkScenario.modelId);
        }
        queries++;
        await new Promise((resolve) =>
          context.onExternalToolCall(
            { data: { actions: [action('read_file', { file_path: 'probe.txt' })] } },
            () => {
              resolve();
              return true;
            }
          )
        );
        return {
          frames: [
            { type: 'task_output', data: { content_type: 'text', content: 'FINAL' } },
            { type: 'task_status', data: { status: 'COMPLETED' } },
          ],
        };
      },
    });
    const prepared = {
      rewriteTo: sdkScenario ? sdkScenario.modelId : 'super',
      model: sdkScenario ? sdkScenario.alias : 'tianxi/super',
      route: sdkScenario
        ? { to: sdkScenario.modelId, tianxiSdkModel: sdkScenario.modelId }
        : { to: 'super' },
      profile: { id: 'profile', tianxiClientReadTools: true },
    };
    const req = { method: 'POST', headers: {}, entryAuth: { key: { id: 'key' } } };
    const first = fakeResponse();
    await handlers.handleTianxiOfficialResponses(
      req,
      first,
      Buffer.from(
        JSON.stringify(
          sdkScenario
            ? {
                model: prepared.model,
                input: [
                  { type: 'additional_tools', role: 'developer', tools },
                  { role: 'user', content: 'read' },
                ],
              }
            : { model: prepared.model, input: 'read', tools }
        )
      ),
      prepared,
      0,
      '/v1/responses'
    );
    const call = JSON.parse(first.body).output[0];
    const denied = fakeResponse();
    await handlers.handleTianxiOfficialResponses(
      { ...req, entryAuth: { key: { id: 'other' } } },
      denied,
      Buffer.from(JSON.stringify({ input: [output(call)] })),
      prepared,
      0,
      '/v1/responses'
    );
    assert.equal(denied.statusCode, 404);
    const otherProfile = fakeResponse();
    await handlers.handleTianxiOfficialResponses(
      req,
      otherProfile,
      Buffer.from(JSON.stringify({ input: [output(call)] })),
      { ...prepared, profile: { ...prepared.profile, id: 'other-profile' } },
      0,
      '/v1/responses'
    );
    assert.equal(otherProfile.statusCode, 404);
    const invalidPolicy = fakeResponse();
    await handlers.handleTianxiOfficialResponses(
      req,
      invalidPolicy,
      Buffer.from(JSON.stringify({ input: [output(call)], parallel_tool_calls: 'false' })),
      prepared,
      0,
      '/v1/responses'
    );
    assert.equal(invalidPolicy.statusCode, 400);
    const last = fakeResponse();
    await handlers.handleTianxiOfficialResponses(
      req,
      last,
      Buffer.from(JSON.stringify({ input: [output(call)] })),
      prepared,
      0,
      '/v1/responses'
    );
    assert.equal(JSON.parse(last.body).output_text, 'FINAL');
    assert.equal(queries, 1);
    manager.close();
  });
test('official handler wires only fixed failure categories and call counts into proxy diagnostics', async () => {
  const diagnostics = [];
  const handlers = createTianxiOfficialHandlers({
    resolveTianxiNativeReadTools: () => nativeTools,
    supportsTianxiClientTools: () => true,
    logRequestEnd() {},
    logProxyEvent: (kind, value) => diagnostics.push({ kind, value }),
    openAIResponsesToChat: () => ({}),
    sendJsonError() {
      assert.fail('unexpected validation error');
    },
    callTianxiOfficialBridge() {
      throw new Error('SECRET token prompt');
    },
  });
  const res = fakeResponse();
  await handlers.handleTianxiOfficialResponses(
    { method: 'POST', headers: {}, entryAuth: { key: { id: 'key' } } },
    res,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'read', tools })),
    {
      rewriteTo: 'super',
      model: 'tianxi/super',
      profile: { id: 'profile', tianxiClientReadTools: true },
    },
    0,
    '/v1/responses'
  );
  assert.equal(JSON.parse(res.body).status, 'failed');
  assert.deepEqual(diagnostics, [
    {
      kind: 'tianxi_client_tool_failed',
      value: { category: 'tianxi_client_provider_failed', clientCalls: 0 },
    },
  ]);
  assert.ok(!JSON.stringify({ body: res.body, diagnostics }).includes('SECRET'));
});

test('new boundary regressions are discovered by the unified CI unit entry', () => {
  const selected = selectUnitTestFiles(
    discoverTestFiles(require('node:path').resolve(__dirname, '..'))
  );
  for (const file of [
    'test/tianxi-client-tools.test.js',
    'test/tianxi-frame-budget.test.js',
    'test/proxy-script-readiness.test.js',
  ])
    assert.ok(selected.includes(file));
});
