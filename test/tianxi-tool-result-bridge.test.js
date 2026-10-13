'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AbortSignal, AbortController, Response } = globalThis;
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createTianxiOfficialHandlers } = require('../lib/proxy/tianxi-official-handlers');
const { createTianxiToolResultCache } = require('../lib/proxy/tianxi-tool-result-cache');
const {
  createTianxiResultReader,
  createTianxiResultMcpServer,
  resultEndpoint,
  readResultCredential,
} = require('../lib/proxy/tianxi-tool-result-mcp');
const { formatTianxiToolResult } = require('../lib/proxy/tianxi-progress-presentation');
const { unavailableTianxiResultResponse } = require('../lib/proxy/tianxi-tool-result-replay');
const {
  hasTianxiResultBridge,
  createTianxiResultCall,
} = require('../lib/proxy/tianxi-tool-result-continuation');

const tools = [
  {
    type: 'namespace',
    name: 'mcp__tianxi_progress',
    tools: [{ type: 'function', name: 'read_result' }],
  },
];
const frames = [
  { type: 'task_status', data: { status: 'WORKING' } },
  { type: 'task_output', data: { content_type: 'text', content: 'Checking files.' } },
  {
    type: 'act_exec',
    data: {
      exec_mode: 'native',
      actions: [{ id: 'read-1', name: 'Read', args: { path: 'PRIVATE_PATH' } }],
    },
  },
  {
    type: 'act_resp',
    data: { actions: [{ id: 'read-1', status: 'COMPLETED', result: 'PRIVATE_RESULT' }] },
  },
  { type: 'task_output', data: { content_type: 'answer', content: 'FINAL_OK' } },
  { type: 'task_status', data: { status: 'COMPLETED' } },
];

function response() {
  const res = new EventEmitter();
  Object.assign(res, {
    body: '',
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk = '') {
      this.body += chunk;
      this.writableEnded = true;
    },
  });
  return res;
}

function events(res) {
  return res.body
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
}

function harness(override = {}) {
  let executions = 0;
  const handlers = createTianxiOfficialHandlers({
    sendJsonError(res, status, payload) {
      res.writeHead(status);
      res.end(JSON.stringify(payload));
    },
    logRequestEnd() {},
    openAIResponsesToChat: () => ({}),
    resolveTianxiNativeReadTools: () => ({ nativeReadTools: true }),
    async callTianxiOfficialBridge(_payload, _profile, options) {
      executions++;
      for (const frame of frames) options.onFrame?.(frame);
      return { frames, bridgeUrl: 'tianxi://unit' };
    },
    ...override,
  });
  return {
    lastResponse: null,
    get executions() {
      return executions;
    },
    async request(body, owner = 'entry-a', profile = 'profile-a') {
      const res = response();
      this.lastResponse = res;
      await handlers.handleTianxiOfficialResponses(
        { headers: {}, method: 'POST', entryAuth: { key: { id: owner } } },
        res,
        Buffer.from(JSON.stringify({ model: 'tianxi/super', ...body })),
        {
          model: 'tianxi/super',
          rewriteTo: 'super',
          profile: { id: profile },
          route: { to: 'super' },
        },
        Date.now(),
        '/v1/responses'
      );
      return res;
    },
  };
}

test('native result receipts close the preceding reasoning item before exposing a client tool', async () => {
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      const nativeFrames = [
        { type: 'task_output', data: { reasoning_content: 'Before operations.' } },
        ...frames,
      ];
      for (const frame of nativeFrames) options.onFrame?.(frame);
      return { frames: nativeFrames };
    },
  });
  const res = await h.request({ input: 'inspect', stream: true, tools });
  const stream = events(res);
  const reasoningDone = stream.findIndex(
    (event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning'
  );
  const toolAdded = stream.findIndex(
    (event) => event.type === 'response.output_item.added' && event.item.type === 'function_call'
  );
  assert.ok(reasoningDone >= 0 && reasoningDone < toolAdded);
  assert.equal(stream[reasoningDone].item.status, 'completed');
  assert.notEqual(stream[reasoningDone].output_index, stream[toolAdded].output_index);
  const callDone = stream.find(
    (event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'
  );
  assert.equal(
    stream.filter(
      (event) =>
        event.type === 'response.output_item.done' &&
        event.item.id === stream[reasoningDone].item.id
    ).length,
    1
  );
  assert.equal(
    stream
      .find((event) => event.type === 'response.completed')
      .response.output.some((item) => item.id === callDone.item.id),
    true
  );
});

test('bridge streams one MCP retrieval call and returns final answer only on continuation', async () => {
  const h = harness();
  const first = await h.request({ input: 'inspect', stream: true, tools });
  const stream = events(first);
  const done = stream.find((event) => event.type === 'response.completed').response;
  const calls = done.output.filter((item) => item.type === 'function_call');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.namespace, 'mcp__tianxi_progress');
  assert.equal(call.name, 'read_result');
  assert.equal(done.output_text, undefined);
  assert.equal(
    stream.some(
      (event) => event.type === 'response.output_text.delta' && event.delta === 'FINAL_OK'
    ),
    false
  );
  assert.equal(first.body.includes('PRIVATE_PATH'), false);
  assert.equal(first.body.includes('PRIVATE_RESULT'), false);
  assert.equal(
    done.output.some(
      (item) => item.phase === 'commentary' && item.content[0].text.includes('Read #1')
    ),
    false
  );
  assert.equal(
    stream.filter(
      (event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'
    ).length,
    1
  );
  const reference = JSON.parse(call.arguments).reference;
  const lookup = await h.request({ input: '', metadata: { tianxi_result_reference: reference } });
  assert.equal(JSON.parse(lookup.body).status, 'completed');
  const continuation = await h.request({
    stream: true,
    input: [
      { role: 'user', content: 'inspect' },
      call,
      { type: 'function_call_output', call_id: call.call_id, output: 'untrusted client text' },
    ],
  });
  const replay = events(continuation);
  const final = replay.at(-1).response;
  assert.equal(final.output_text, 'FINAL_OK');
  assert.equal(final.status, 'completed');
  assert.equal(
    final.output.some((item) => item.type === 'function_call' || item.phase === 'commentary'),
    false
  );
  assert.equal(
    replay
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta)
      .join(''),
    'FINAL_OK'
  );
  assert.notEqual(final.id, done.id);
  assert.equal(h.executions, 1);
  const retry = await h.request({
    input: [{ type: 'function_call_output', call_id: call.call_id }],
  });
  assert.equal(JSON.parse(retry.body).output_text, 'FINAL_OK');
  assert.equal(h.executions, 1);
});

test('legacy and new result readers coexist without changing cached native categories or redispatching', async () => {
  let executions = 0;
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      executions++;
      const taskFrames = frames.map((frame) =>
        frame.type === 'act_exec'
          ? { ...frame, data: { ...frame.data, actions: [{ id: 'read-1', name: 'TaskCreate' }] } }
          : frame
      );
      taskFrames.forEach((frame) => options.onFrame?.(frame));
      return { frames: taskFrames };
    },
  });
  const initial = JSON.parse((await h.request({ input: 'inspect', tools })).body);
  const call = initial.output.find((item) => item.type === 'function_call');
  const reference = JSON.parse(call.arguments).reference;
  const lookup = async (format, owner = 'entry-a') =>
    h.request(
      {
        input: '',
        metadata: { tianxi_result_reference: reference, tianxi_result_format: format },
      },
      owner
    );
  for (const format of [undefined, '1', '2', undefined, '2']) {
    const res = await lookup(format);
    assert.equal(res.statusCode, 200);
    const result = JSON.parse(res.body);
    assert.equal(result.tool, format === '2' ? 'TaskCreate' : 'Operation');
    assert.equal(result.status, 'completed');
  }
  for (const format of [null, 2, '3', {}, [], 'PRIVATE']) {
    const res = await lookup(format);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, 'tianxi_result_format_invalid');
    assert.equal(res.body.includes('PRIVATE'), false);
  }
  assert.equal((await lookup('2', 'entry-b')).statusCode, 404);
  const reader = createTianxiResultReader({
    credential: () => '',
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.metadata.tianxi_result_format, '2');
      const res = await h.request(body);
      return new Response(res.body, { status: res.statusCode });
    },
  });
  assert.equal((await reader(reference)).tool, 'TaskCreate');
  const final = JSON.parse(
    (
      await h.request({
        input: [{ type: 'function_call_output', call_id: call.call_id }],
      })
    ).body
  );
  assert.equal(final.output_text, 'FINAL_OK');
  assert.equal(executions, 1);
});

test('non-stream replay populates operation cache and isolates entry and profile owners', async () => {
  const h = harness();
  const first = JSON.parse((await h.request({ input: 'inspect', tools })).body);
  const call = first.output.find((item) => item.type === 'function_call');
  const reference = JSON.parse(call.arguments).reference;
  const input = [{ type: 'function_call_output', call_id: call.call_id }];
  assert.equal((await h.request({ input }, 'entry-b')).statusCode, 404);
  assert.equal((await h.request({ input }, 'entry-a', 'profile-b')).statusCode, 404);
  assert.equal(
    (await h.request({ metadata: { tianxi_result_reference: reference } }, 'entry-b')).statusCode,
    404
  );
  assert.equal((await h.request({ metadata: { tianxi_result_reference: 'bad' } })).statusCode, 400);
  assert.equal(
    (
      await h.request({
        input: [{ type: 'function_call_output', call_id: 'call_tianxi_result_bad' }],
      })
    ).statusCode,
    400
  );
  assert.equal(h.executions, 1);
});

test('unregistered clients and tasks without native calls retain normal final output', async () => {
  const h = harness();
  const fallback = JSON.parse((await h.request({ input: 'inspect' })).body);
  assert.equal(fallback.output_text, 'FINAL_OK');
  assert.equal(
    fallback.output.some((item) => item.type === 'function_call'),
    false
  );
  const noCalls = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      const plain = frames.filter((frame) => !['act_exec', 'act_resp'].includes(frame.type));
      for (const frame of plain) options.onFrame?.(frame);
      return { frames: plain };
    },
  });
  const plain = events(await noCalls.request({ input: 'hello', tools, stream: true }));
  const finalId = plain.at(-1).response.output.find((item) => item.phase === 'final_answer').id;
  const text = plain
    .filter((event) => event.type === 'response.output_text.delta' && event.item_id === finalId)
    .map((event) => event.delta)
    .join('');
  assert.equal(text, 'Checking files.FINAL_OK');
  assert.equal(plain.at(-1).response.output_text, text);
});

test('interrupted native work preserves partial answer and terminal state on replay', async () => {
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      for (const frame of frames.slice(0, -1)) options.onFrame?.(frame);
      throw Object.assign(new Error('private error'), { code: 'ECONNRESET' });
    },
  });
  const initial = events(await h.request({ input: 'inspect', stream: true, tools })).at(
    -1
  ).response;
  assert.equal(initial.status, 'incomplete');
  const call = initial.output.find((item) => item.type === 'function_call');
  const replay = JSON.parse(
    (await h.request({ input: [{ type: 'function_call_output', call_id: call.call_id }] })).body
  );
  assert.equal(replay.status, 'incomplete');
  assert.equal(replay.output_text, 'FINAL_OK');
  assert.equal(replay.incomplete_details.reason, 'tianxi_native_stream_interrupted');
});

test('Dynamically loaded reader tools produce calls, preserve naming and never enter the native prompt', async () => {
  const flat = { type: 'function', name: 'mcp__tianxi_progress__read_result' };
  for (const declaration of [tools[0], flat]) {
    for (const inputType of ['additional_tools', 'tool_search_output']) {
      let executions = 0;
      let nativeInput;
      const h = harness({
        async callTianxiOfficialBridge(payload, _profile, options) {
          executions++;
          nativeInput = payload.input;
          frames.forEach((frame) => options.onFrame?.(frame));
          return { frames };
        },
      });
      const input = [
        { role: 'user', content: 'inspect' },
        {
          type: inputType,
          role: 'developer',
          status: 'completed',
          execution: 'client',
          tools: [declaration],
        },
      ];
      const first = await h.request({ input, stream: true, tools: [] });
      assert.equal(first.headers['X-Tianxi-Progress-Mode'], 'mcp-result-bridge');
      const output = events(first).at(-1).response;
      const call = output.output.find((item) => item.type === 'function_call');
      assert.ok(call);
      assert.equal(call.name, declaration === flat ? flat.name : 'read_result');
      assert.equal(call.namespace, declaration === flat ? undefined : 'mcp__tianxi_progress');
      assert.ok(
        !output.output.some(
          (item) => item.phase === 'commentary' && item.content[0].text.includes('Read #1')
        )
      );
      assert.deepEqual(nativeInput, [{ role: 'user', content: 'inspect' }]);
      assert.ok(!first.body.includes('PRIVATE_RESULT'));
      const replay = JSON.parse(
        (
          await h.request({
            input: [
              ...input,
              call,
              { type: 'function_call_output', call_id: call.call_id, output: 'untrusted result' },
            ],
          })
        ).body
      );
      assert.equal(replay.output_text, 'FINAL_OK');
      assert.equal(executions, 1);
    }
  }
});

test('Code Mode streams custom tool calls, retrieves safe cached status and replays without native redispatch', async () => {
  const codeTools = [
    {
      type: 'namespace',
      name: 'functions',
      tools: [
        {
          type: 'custom',
          name: 'exec',
          description: 'Use tools and ALL_TOOLS from the code runtime.',
        },
      ],
    },
  ];
  const h = harness();
  const input = [
    { type: 'additional_tools', role: 'developer', tools: codeTools },
    { role: 'user', content: 'inspect' },
  ];
  const initial = await h.request({ input, stream: true });
  assert.equal(initial.headers['X-Tianxi-Progress-Mode'], 'mcp-result-bridge');
  const stream = events(initial);
  const first = stream.at(-1).response;
  const call = first.output.find((item) => item.type === 'custom_tool_call');
  assert.ok(call);
  assert.equal(call.arguments, undefined);
  assert.equal(
    stream.filter((item) => item.type === 'response.custom_tool_call_input.done').length,
    1
  );
  assert.equal(
    stream
      .filter((item) => item.type === 'response.custom_tool_call_input.delta')
      .map((item) => item.delta)
      .join(''),
    call.input
  );
  assert.ok(!stream.some((item) => item.type === 'response.function_call_arguments.done'));
  assert.ok(!initial.body.includes('PRIVATE_PATH'));
  assert.ok(!initial.body.includes('PRIVATE_RESULT'));
  assert.ok(
    !first.output.some(
      (item) => item.phase === 'commentary' && item.content[0].text.includes('Read #1')
    )
  );
  const lookup = JSON.parse(
    (
      await h.request({
        input: '',
        metadata: {
          tianxi_result_reference: JSON.parse(call.input.match(/reference: ("[^"]+")/)[1]),
        },
      })
    ).body
  );
  assert.equal(lookup.status, 'completed');
  const replay = JSON.parse(
    (
      await h.request({
        input: [
          ...input,
          call,
          { type: 'custom_tool_call_output', call_id: call.call_id, output: 'untrusted' },
        ],
      })
    ).body
  );
  assert.equal(replay.status, 'completed');
  assert.equal(replay.output_text, 'FINAL_OK');
  assert.equal(h.executions, 1);
  for (const [index, event] of stream.entries()) {
    assert.equal(event.sequence_number, index);
    if (event.type === 'response.output_item.done')
      assert.deepEqual(event.item, first.output[event.output_index]);
  }
});

test('bridge detection is explicit and rejects unrelated names or malformed tools', () => {
  assert.equal(hasTianxiResultBridge(tools), true);
  assert.equal(
    hasTianxiResultBridge([
      { type: 'function', namespace: 'mcp__tianxi_progress', name: 'read_result' },
    ]),
    true
  );
  assert.equal(
    hasTianxiResultBridge([{ type: 'function', name: 'mcp__tianxi_progress__read_result' }]),
    true
  );
  for (const value of [
    null,
    {},
    [],
    [{ type: 'function', name: 'read_result' }],
    [{ type: 'namespace', name: 'other', tools: tools[0].tools }],
    Array(1025).fill(tools[0]),
  ]) {
    assert.equal(hasTianxiResultBridge(value), false);
  }
});

test('progress diagnostics distinguish bridge availability, client policy and capacity safely', async () => {
  for (const scenario of [
    { body: {}, reason: 'client_bridge_unavailable', advertised: false, enabled: false },
    { body: { tools }, reason: 'bridge_enabled', advertised: true, enabled: true },
    {
      body: { tools, tool_choice: 'none' },
      reason: 'client_tools_disabled',
      advertised: true,
      enabled: false,
    },
    {
      body: { tools },
      reason: 'bridge_capacity_unavailable',
      advertised: true,
      enabled: false,
      options: { toolResultCache: { begin: () => null } },
    },
  ]) {
    const logs = [];
    const h = harness({
      ...scenario.options,
      logRequestEnd(_method, _path, _start, _status, detail) {
        logs.push(detail);
      },
    });
    await h.request({ input: 'PRIVATE_PROMPT', stream: true, ...scenario.body });
    const summary = logs.at(-1).tianxiRequest;
    assert.equal(summary.clientResultBridgeAdvertised, scenario.advertised);
    assert.equal(summary.resultBridgeEnabled, scenario.enabled);
    assert.equal(summary.progressModeReason, scenario.reason);
    assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(summary).includes('read_result'), false);
  }
});

test('tool_choice none emits no client result calls even when the bridge is advertised', async () => {
  const h = harness();
  const stream = events(
    await h.request({ input: 'inspect', tools, stream: true, tool_choice: 'none' })
  );
  assert.equal(stream.at(-1).response.output_text, 'FINAL_OK');
  assert.equal(
    stream.some((event) => event.item?.type === 'function_call'),
    false
  );
  assert.equal(h.executions, 1);
});

test('fallback progress contains safe operation targets and returned state, without sensitive input', async () => {
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      const detailed = frames.map((frame) =>
        frame.type === 'act_exec'
          ? {
              ...frame,
              data: {
                exec_mode: 'native',
                actions: [
                  {
                    id: 'read-1',
                    name: 'Read',
                    args: { file_path: 'lib/app.js', token: 'PRIVATE_TOKEN' },
                  },
                ],
              },
            }
          : frame
      );
      detailed.forEach((frame) => options.onFrame?.(frame));
      return { frames: detailed };
    },
  });
  const res = await h.request({ input: 'inspect', stream: true });
  assert.equal(res.headers['X-Tianxi-Progress-Mode'], 'commentary');
  const commentary = events(res)
    .filter(
      (event) => event.type === 'response.output_item.done' && event.item.phase === 'commentary'
    )
    .map((event) => event.item.content[0].text)
    .join('');
  assert.ok(commentary.includes('`lib/app.js`'));
  assert.ok(commentary.includes('\u5df2\u5b8c\u6210'));
  assert.equal(res.body.includes('PRIVATE_TOKEN'), false);
  assert.equal(res.body.includes('PRIVATE_RESULT'), false);
  const bridge = await h.request({ input: 'inspect', stream: true, tools });
  assert.equal(bridge.headers['X-Tianxi-Progress-Mode'], 'mcp-result-bridge');
});

test('native task-management progress preserves meaningful subjects and failed updates in timeline', async () => {
  const taskFrames = [
    {
      type: 'act_exec',
      data: {
        exec_mode: 'native',
        actions: [
          {
            id: 'create',
            name: 'TaskCreate',
            args: { subject: 'Audit schema', description: 'PRIVATE_DESCRIPTION' },
          },
        ],
      },
    },
    { type: 'act_resp', data: { actions: [{ id: 'create', status: 'COMPLETED' }] } },
    {
      type: 'act_exec',
      data: {
        exec_mode: 'native',
        actions: [
          { id: 'update', name: 'TaskUpdate', args: { taskId: '2', status: 'in_progress' } },
        ],
      },
    },
    {
      type: 'act_resp',
      data: { actions: [{ id: 'update', status: 'FAILED', result: 'PRIVATE_FAILURE' }] },
    },
    { type: 'task_output', data: { content_type: 'answer', content: 'FINAL_OK' } },
    { type: 'task_status', data: { status: 'COMPLETED' } },
  ];
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      taskFrames.forEach((frame) => options.onFrame?.(frame));
      return { frames: taskFrames };
    },
  });
  for (const stream of [true, false]) {
    const res = await h.request({ input: 'inspect', stream });
    const final = stream ? events(res).at(-1).response : JSON.parse(res.body);
    const text = final.output
      .filter((item) => item.phase === 'commentary')
      .flatMap((item) => item.content)
      .map((part) => part.text)
      .join('');
    assert.ok(text.includes('`Audit schema`'));
    assert.ok(text.includes('\u521b\u5efa\u4efb\u52a1'));
    assert.ok(text.includes('\u4efb\u52a1 2'));
    assert.ok(text.includes('\u66f4\u65b0\u4efb\u52a1\u5931\u8d25'));
    assert.equal(text.includes('PRIVATE'), false);
    assert.ok(text.indexOf('`Audit schema`') < text.indexOf('\u4efb\u52a1 2'));
    assert.equal(final.output_text, 'FINAL_OK');
  }
});

test('invalid parallel policy fails before native dispatch or streaming headers', async () => {
  const h = harness();
  for (const value of ['false', 0, {}, [], 'PRIVATE_VALUE']) {
    for (const stream of [true, false]) {
      const res = await h.request({ input: 'inspect', tools, stream, parallel_tool_calls: value });
      assert.equal(res.statusCode, 400);
      const error = JSON.parse(res.body).error;
      assert.equal(error.type, 'invalid_request_error');
      assert.equal(error.code, 'tianxi_invalid_request_parameter');
      assert.equal(error.param, 'parallel_tool_calls');
      assert.equal(res.body.includes('PRIVATE_VALUE'), false);
      assert.equal(events(res).length, 0);
    }
  }
  assert.equal(h.executions, 0);
});

test('parallel_tool_calls false emits one client retrieval call for a native tool batch', async () => {
  const batched = [
    {
      type: 'act_exec',
      data: {
        exec_mode: 'native',
        actions: [
          { id: 'one', name: 'Read' },
          { id: 'two', name: 'Grep' },
        ],
      },
    },
    {
      type: 'act_resp',
      data: {
        actions: [
          { id: 'one', status: 'COMPLETED' },
          { id: 'two', status: 'COMPLETED' },
        ],
      },
    },
    ...frames.slice(-2),
  ];
  for (const parallel_tool_calls of [false, true, undefined]) {
    let nativeExecutions = 0;
    const h = harness({
      async callTianxiOfficialBridge(_payload, _profile, options) {
        nativeExecutions++;
        batched.forEach((frame) => options.onFrame?.(frame));
        return { frames: batched };
      },
    });
    const eventsList = events(
      await h.request({ input: 'inspect', tools, stream: true, parallel_tool_calls })
    );
    const calls = eventsList.at(-1).response.output.filter((item) => item.type === 'function_call');
    assert.equal(calls.length, parallel_tool_calls === false ? 1 : 2);
    const commentary = eventsList
      .at(-1)
      .response.output.filter((item) => item.phase === 'commentary')
      .map((item) => item.content[0].text)
      .join('');
    assert.equal(commentary.includes('Read #1'), false);
    assert.equal(commentary.includes('Grep #1'), false);
    assert.equal(commentary.includes('\u5df2\u5b8c\u6210'), false);
    assert.equal(
      eventsList.filter(
        (event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'
      ).length,
      calls.length
    );
    let replay = await h.request({
      input: calls.map((call) => ({ type: 'function_call_output', call_id: call.call_id })),
    });
    if (parallel_tool_calls === false) {
      const next = JSON.parse(replay.body).output;
      assert.equal(next.length, 1);
      assert.equal(next[0].type, 'function_call');
      assert.notEqual(next[0].call_id, calls[0].call_id);
      replay = await h.request({
        input: [{ type: 'function_call_output', call_id: next[0].call_id }],
      });
    }
    assert.equal(JSON.parse(replay.body).output_text, 'FINAL_OK');
    assert.equal(nativeExecutions, 1);
  }
});

test('serial result continuations render each cached native operation for both call styles without redispatch', async () => {
  const batch = [
    frames[0],
    {
      type: 'act_exec',
      data: {
        exec_mode: 'native',
        actions: [
          { id: 'one', name: 'Read', args: { path: 'PRIVATE_PATH' } },
          { id: 'two', name: 'Grep' },
          { id: 'three', name: 'Glob' },
        ],
      },
    },
    {
      type: 'act_resp',
      data: {
        actions: [
          { id: 'one', status: 'COMPLETED' },
          { id: 'two', status: 'FAILED', result: 'PRIVATE_RESULT' },
          { id: 'three', status: 'CANCELED' },
        ],
      },
    },
    ...frames.slice(-2),
  ];
  const codeTools = [
    {
      type: 'namespace',
      name: 'functions',
      tools: [{ type: 'custom', name: 'exec', description: 'Use tools and ALL_TOOLS.' }],
    },
  ];
  for (const stream of [true, false])
    for (const custom of [true, false]) {
      let nativeExecutions = 0;
      const h = harness({
        async callTianxiOfficialBridge(_payload, _profile, options) {
          nativeExecutions++;
          batch.forEach((frame) => options.onFrame?.(frame));
          return { frames: batch };
        },
      });
      const decode = (res) => (stream ? events(res).at(-1).response : JSON.parse(res.body));
      let res = await h.request({
        input: 'inspect',
        tools: custom ? codeTools : tools,
        stream,
        parallel_tool_calls: false,
      });
      const outputs = [],
        ids = new Set();
      for (let index = 0; index < 3; index++) {
        const body = decode(res);
        assert.equal(body.status, 'completed');
        assert.equal(body.output.length, 1);
        const call = body.output[0];
        assert.equal(call.type, custom ? 'custom_tool_call' : 'function_call');
        assert.equal(ids.has(call.call_id), false);
        ids.add(call.call_id);
        assert.equal(res.body.includes('PRIVATE'), false);
        assert.equal(res.body.includes('任务已开始'), false);
        if (stream) {
          const list = events(res);
          const added = list.find(
            (event) => event.type === 'response.output_item.added' && event.item.id === call.id
          );
          const done = list.find(
            (event) => event.type === 'response.output_item.done' && event.item.id === call.id
          );
          assert.equal(added.output_index, done.output_index);
          assert.equal(
            list.filter((event) => event.type === 'response.output_item.done').length,
            1
          );
          assert.deepEqual(
            list.map((event) => event.sequence_number),
            list.map((_event, n) => n)
          );
        }
        const reference = call.call_id.slice('call_tianxi_result_'.length);
        const lookup = await h.request({
          input: '',
          metadata: { tianxi_result_reference: reference },
        });
        assert.equal(JSON.parse(lookup.body).status, ['completed', 'failed', 'canceled'][index]);
        outputs.push({
          type: custom ? 'custom_tool_call_output' : 'function_call_output',
          call_id: call.call_id,
          output: 'PRIVATE_UNTRUSTED_RESULT',
        });
        // Replay is stable, including when only the latest output is sent.
        const request = { input: index % 2 ? [outputs.at(-1)] : outputs, stream };
        const first = decode(await h.request(request));
        res = await h.request(request);
        assert.deepEqual(
          decode(res).output.map((item) => item.call_id),
          first.output.map((item) => item.call_id)
        );
      }
      assert.equal(decode(res).output_text, 'FINAL_OK');
      assert.equal(nativeExecutions, 1);
    }
});

test('disabling tools during serial continuation fails explicitly without losing the next cached operation', async () => {
  let nativeExecutions = 0;
  const batch = [
    {
      type: 'act_exec',
      data: {
        exec_mode: 'native',
        actions: [
          { id: 'one', name: 'Read' },
          { id: 'two', name: 'Grep' },
        ],
      },
    },
    {
      type: 'act_resp',
      data: {
        actions: [
          { id: 'one', status: 'COMPLETED' },
          { id: 'two', status: 'COMPLETED' },
        ],
      },
    },
    ...frames.slice(-2),
  ];
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      nativeExecutions++;
      batch.forEach((frame) => options.onFrame?.(frame));
      return { frames: batch };
    },
  });
  const initial = JSON.parse(
    (await h.request({ input: 'inspect', tools, parallel_tool_calls: false })).body
  );
  const input = [{ type: 'function_call_output', call_id: initial.output[0].call_id }];
  const disabled = await h.request({ input, tool_choice: 'none' });
  assert.equal(disabled.statusCode, 409);
  assert.equal(JSON.parse(disabled.body).error.code, 'tianxi_result_client_tools_disabled');
  const retry = JSON.parse((await h.request({ input })).body);
  assert.equal(retry.output.length, 1);
  assert.equal(retry.output[0].type, 'function_call');
  const final = await h.request({
    input: [{ type: 'function_call_output', call_id: retry.output[0].call_id }],
  });
  assert.equal(JSON.parse(final.body).output_text, 'FINAL_OK');
  assert.equal(nativeExecutions, 1);
});

test('per-operation bridge capacity fallback preserves start and outcome without duplicate cards', async () => {
  for (const stream of [true, false]) {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELED']) {
      const batch = [
        { type: 'task_output', data: { reasoning_content: 'Before operations.' } },
        {
          type: 'act_exec',
          data: {
            exec_mode: 'native',
            actions: [
              { id: 'one', name: 'Read' },
              { id: 'two', name: 'Grep' },
            ],
          },
        },
        {
          type: 'act_resp',
          data: {
            actions: [
              { id: 'one', status },
              { id: 'two', status, result: 'PRIVATE' },
            ],
          },
        },
        { type: 'task_output', data: { reasoning_content: 'After operations.' } },
        ...frames.slice(-2),
      ];
      const h = harness({
        toolResultCache: createTianxiToolResultCache({ maxOperations: 1 }),
        async callTianxiOfficialBridge(_payload, _profile, options) {
          batch.forEach((frame) => options.onFrame?.(frame));
          return { frames: batch };
        },
      });
      const res = await h.request({ input: 'inspect', tools, stream });
      const output = stream ? events(res).at(-1).response.output : JSON.parse(res.body).output;
      assert.equal(output.filter((item) => item.type === 'function_call').length, 1);
      const notifications = output.filter((item) => item.phase === 'commentary');
      assert.equal(notifications.length, 2);
      assert.ok(notifications.every((item) => item.content[0].text.includes('Grep #1')));
      const labels = {
        COMPLETED: '\u5df2\u5b8c\u6210',
        FAILED: '\u5931\u8d25',
        CANCELED: '\u5df2\u53d6\u6d88',
      };
      assert.ok(notifications[1].content[0].text.includes(labels[status]));
      assert.equal(res.body.includes('PRIVATE'), false);
      const reasoning = output.filter((item) => item.type === 'reasoning');
      assert.equal(reasoning.length, 2);
      assert.equal(reasoning[0].summary[0].text, 'Before operations.');
      assert.equal(reasoning[1].summary[0].text, 'After operations.');
      if (stream) {
        const emitted = events(res);
        for (const [index, event] of emitted.entries()) assert.equal(event.sequence_number, index);
        for (const event of emitted.filter((event) => event.type === 'response.output_item.done')) {
          assert.deepEqual(event.item, output[event.output_index]);
        }
      }
    }
  }
});

test('live serial cards arrive before native completion and retry without reexecution', async () => {
  let emit, resolveNative;
  let executions = 0;
  const liveFrames = [];
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      executions++;
      emit = (frame) => {
        liveFrames.push(frame);
        options.onFrame(frame);
      };
      return new Promise((resolve) => {
        resolveNative = resolve;
      });
    },
  });
  const start = (id, name) => ({
    type: 'act_exec',
    data: { exec_mode: 'native', actions: [{ id, name }] },
  });
  const done = (id) => ({ type: 'act_resp', data: { actions: [{ id, status: 'COMPLETED' }] } });
  const initialPending = h.request({
    input: 'inspect',
    tools,
    stream: true,
    parallel_tool_calls: false,
  });
  const initial = h.lastResponse;
  emit(start('one', 'Read'));
  assert.equal(initial.writableEnded, false);
  emit(done('one'));
  assert.equal(initial.writableEnded, true);
  const first = events(initial).at(-1).response;
  assert.equal(first.status, 'completed');
  const call = first.output.find((item) => item.type === 'function_call');
  initial.destroyed = true;
  initial.emit('close');
  const secondPending = h.request({
    stream: true,
    input: [{ type: 'function_call_output', call_id: call.call_id }],
  });
  emit(start('two', 'Grep'));
  assert.equal(h.lastResponse.writableEnded, false);
  emit(done('two'));
  const second = events(await secondPending).at(-1).response.output[0];
  assert.notEqual(second.call_id, call.call_id);
  const retry = JSON.parse(
    (await h.request({ input: [{ type: 'function_call_output', call_id: call.call_id }] })).body
  );
  assert.equal(retry.output[0].call_id, second.call_id);
  const finalPending = h.request({
    stream: true,
    input: [{ type: 'function_call_output', call_id: second.call_id }],
  });
  for (const frame of frames.slice(-2)) emit(frame);
  resolveNative({ frames: liveFrames });
  await initialPending;
  const final = events(await finalPending).at(-1).response;
  assert.equal(final.status, 'completed');
  assert.equal(final.output_text, 'FINAL_OK');
  assert.equal(executions, 1);
  assert.equal(initial.body.includes('FINAL_OK'), false);
});

test('canceling a live continuation stops the detached native request without writing the old stream', async () => {
  let signal;
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      signal = options.signal;
      options.onFrame(frames[2]);
      options.onFrame(frames[3]);
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true })
      );
    },
  });
  const pending = h.request({ input: 'inspect', tools, stream: true, parallel_tool_calls: false });
  const initial = h.lastResponse;
  assert.equal(initial.writableEnded, true);
  const initialBody = initial.body;
  const call = events(initial)
    .at(-1)
    .response.output.find((item) => item.type === 'function_call');
  const continuation = h.request({
    stream: true,
    input: [{ type: 'function_call_output', call_id: call.call_id }],
  });
  h.lastResponse.destroyed = true;
  h.lastResponse.emit('close');
  await continuation;
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(initial.body, initialBody);
});

test('native failure after live handoff becomes a nonretryable terminal result without exposing error text', async () => {
  let fail;
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      options.onFrame(frames[2]);
      options.onFrame(frames[3]);
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    },
  });
  const initialPending = h.request({
    input: 'inspect',
    tools,
    stream: true,
    parallel_tool_calls: false,
  });
  const initial = h.lastResponse;
  const initialBody = initial.body;
  const call = events(initial)
    .at(-1)
    .response.output.find((item) => item.type === 'function_call');
  fail(new Error('PRIVATE_NATIVE_FAILURE'));
  await initialPending;
  assert.equal(initial.body, initialBody);
  const replay = await h.request({
    stream: true,
    input: [{ type: 'function_call_output', call_id: call.call_id }],
  });
  const terminal = events(replay).at(-1);
  assert.equal(terminal.type, 'response.failed');
  assert.equal(terminal.response.error.code, 'invalid_prompt');
  assert.equal(replay.body.includes('PRIVATE_NATIVE_FAILURE'), false);
});

test('cache exhaustion falls back before emitting any retrieval calls', async () => {
  const cache = createTianxiToolResultCache({ maxTasks: 1 });
  cache.begin('occupied');
  const h = harness({ toolResultCache: cache });
  const done = events(await h.request({ input: 'inspect', stream: true, tools })).at(-1).response;
  assert.equal(done.output_text, 'FINAL_OK');
  assert.equal(
    done.output.some((item) => item.type === 'function_call'),
    false
  );
});

test('answer retention overflow produces a truthful unavailable continuation without rerunning', async () => {
  const h = harness({ toolResultCache: createTianxiToolResultCache({ maxResponseBytes: 1 }) });
  const initial = JSON.parse((await h.request({ input: 'inspect', tools })).body);
  const call = initial.output.find((item) => item.type === 'function_call');
  const replay = await h.request({
    input: [{ type: 'function_call_output', call_id: call.call_id }],
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(replay.body).status, 'failed');
  assert.equal(JSON.parse(replay.body).error.code, 'invalid_prompt');
  assert.equal(h.executions, 1);
});

test('native failure remains failed with a final failure event rather than completed replay', async () => {
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      const failed = [
        ...frames.slice(0, -1),
        { type: 'task_status', data: { status: 'FAILED', error_code: 'native_failed' } },
      ];
      for (const frame of failed) options.onFrame?.(frame);
      return { frames: failed };
    },
  });
  const initial = events(await h.request({ input: 'inspect', stream: true, tools })).at(
    -1
  ).response;
  const call = initial.output.find((item) => item.type === 'function_call');
  const replay = events(
    await h.request({
      stream: true,
      input: [{ type: 'function_call_output', call_id: call.call_id }],
    })
  );
  assert.equal(replay.at(-1).type, 'response.failed');
  assert.equal(replay.at(-1).response.error.code, 'native_failed');
});

test('replayed response ids remain usable in previous_response_id history', async () => {
  const h = harness();
  const initial = JSON.parse((await h.request({ input: 'inspect', tools })).body);
  const call = initial.output.find((item) => item.type === 'function_call');
  const replay = JSON.parse(
    (await h.request({ input: [{ type: 'function_call_output', call_id: call.call_id }] })).body
  );
  const next = await h.request({ input: 'next question', previous_response_id: replay.id });
  assert.equal(next.statusCode, 200);
  assert.equal(h.executions, 2);
});

test('terminal result failures are bounded, truthful and never include private inputs', () => {
  for (const status of ['canceled', 'failed', 'incomplete', 'completed']) {
    const failure = unavailableTianxiResultResponse(status, 'tianxi/super');
    assert.equal(failure.status, 'failed');
    assert.equal(failure.error.code, 'invalid_prompt');
    assert.deepEqual(failure.output, []);
    assert.equal(JSON.stringify(failure).includes('txr_'), false);
  }
  for (const status of [null, {}, '', 'in_progress', 'PRIVATE'])
    assert.throws(() => unavailableTianxiResultResponse(status, 'tianxi/super'));
  for (const model of [null, {}, '', 'x'.repeat(257), 'secret\nheader'])
    assert.throws(() => unavailableTianxiResultResponse('canceled', model));
});

test('disconnect settles pending native operations as canceled and continuation ends without retryable conflicts', async () => {
  const h = harness({
    async callTianxiOfficialBridge(_payload, _profile, options) {
      options.onFrame(frames[2]);
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('Canceled')), {
          once: true,
        })
      );
    },
  });
  const pending = h.request({ input: 'inspect', tools, stream: true });
  const call = events(h.lastResponse).find(
    (event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'
  ).item;
  h.lastResponse.destroyed = true;
  h.lastResponse.emit('close');
  await pending;
  const record = JSON.parse(
    (
      await h.request({
        metadata: { tianxi_result_reference: JSON.parse(call.arguments).reference },
      })
    ).body
  );
  assert.equal(record.status, 'canceled');
  assert.equal(record.taskStatus, 'canceled');
  for (const stream of [false, true]) {
    const replay = await h.request({
      stream,
      input: [{ type: 'function_call_output', call_id: call.call_id }],
    });
    assert.equal(replay.statusCode, 200);
    const terminal = stream ? events(replay).at(-1).response : JSON.parse(replay.body);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.error.code, 'invalid_prompt');
    assert.ok(terminal.error.message.includes('disconnected'));
    assert.deepEqual(terminal.output, []);
    assert.equal(replay.body.includes('PRIVATE'), false);
    if (stream) assert.equal(events(replay).at(-1).type, 'response.failed');
  }
});

test('result reader polls safe loopback only and strips additional result data', async () => {
  const reference = 'txr_' + 'a'.repeat(32);
  let requests = 0;
  let waits = 0;
  const reader = createTianxiResultReader({
    credential: () => '',
    wait: async () => {
      waits++;
    },
    fetch: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:3085/v1/responses');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body).metadata, {
        tianxi_result_reference: reference,
        tianxi_result_format: '2',
      });
      requests++;
      return Response.json({
        object: 'tianxi.tool_result',
        reference,
        tool: 'Read',
        ordinal: 1,
        status: requests === 1 ? 'in_progress' : 'completed',
        taskStatus: 'in_progress',
        private: 'PRIVATE_RESULT',
      });
    },
  });
  const result = await reader(reference);
  assert.equal(requests, 2);
  assert.equal(waits, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_RESULT'), false);
  await assert.rejects(reader('bad'));
  for (const url of [
    'https://127.0.0.1:3085/v1',
    'http://example.com/v1',
    'http://localhost/v1',
    'http://user:password@127.0.0.1/v1',
    'http://127.0.0.1/v1?x=1',
    'http://127.0.0.1/v1#x',
    'http://127.0.0.1/other',
  ]) {
    assert.throws(() => resultEndpoint(url));
  }
  assert.throws(() => createTianxiResultReader({ model: 'other-provider' }));
});

test('local auth parsing is bounded and rejects malformed credentials without logging them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-tianxi-result-auth-'));
  const file = path.join(dir, 'auth.json');
  try {
    assert.equal(readResultCredential(file), '');
    assert.throws(() => readResultCredential(dir));
    fs.writeFileSync(file, '{}');
    assert.equal(readResultCredential(file), '');
    fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: 'unit-test-not-a-secret' }));
    assert.equal(readResultCredential(file), 'unit-test-not-a-secret');
    fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: 'unit-test-not-a-secret' } }));
    assert.equal(readResultCredential(file), 'unit-test-not-a-secret');
    for (const value of ['x\r\ny', 'x'.repeat(4097), {}]) {
      fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: value }));
      assert.throws(() => readResultCredential(file));
    }
    fs.writeFileSync(file, '{');
    assert.throws(() => readResultCredential(file));
    fs.writeFileSync(file, 'x'.repeat(128 * 1024 + 1));
    assert.throws(() => readResultCredential(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reader rejects unavailable, oversized, malformed, canceled and mismatched results', async () => {
  const reference = 'txr_' + 'a'.repeat(32);
  for (const result of [
    () => new Response('', { status: 404 }),
    () => new Response('x'.repeat(4097)),
    () => new Response('invalid json'),
    () => Response.json({ object: 'tianxi.tool_result', reference: 'other' }),
    () =>
      Response.json({
        object: 'tianxi.tool_result',
        reference,
        tool: 'unsafe',
        ordinal: 1,
        status: 'completed',
        taskStatus: 'completed',
      }),
  ]) {
    const reader = createTianxiResultReader({ credential: () => '', fetch: async () => result() });
    await assert.rejects(reader(reference));
  }
  const reader = createTianxiResultReader({
    credential: () => '',
    fetch: async () => {
      throw new Error('should not fetch');
    },
  });
  await assert.rejects(reader(reference, AbortSignal.abort()));
});

test('pending reader honors cancellation and deadlines while sleeping', async () => {
  const reference = 'txr_' + 'a'.repeat(32);
  const fetchPending = async () =>
    Response.json({
      object: 'tianxi.tool_result',
      reference,
      tool: 'Read',
      ordinal: 1,
      status: 'in_progress',
      taskStatus: 'in_progress',
    });
  const controller = new AbortController();
  const reader = createTianxiResultReader({ credential: () => '', fetch: fetchPending });
  const pending = reader(reference, controller.signal);
  const timer = setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending);
  clearTimeout(timer);
  const bounded = createTianxiResultReader({
    credential: () => '',
    fetch: fetchPending,
    timeoutMs: 10,
  });
  await assert.rejects(bounded(reference));
});

test('official SDK handshake and tool calls remain strictly read-only', async () => {
  let reads = 0;
  const server = createTianxiResultMcpServer(async (reference) => {
    reads++;
    return {
      reference,
      tool: 'Read',
      ordinal: 1,
      status: 'completed',
      taskStatus: 'completed',
      privateResult: 'PRIVATE_RESULT',
    };
  });
  const client = new Client({ name: 'unit-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const catalog = await client.listTools();
    assert.deepEqual(
      catalog.tools.map((tool) => tool.name),
      [
        'read_result',
        'glob_result',
        'search_result',
        'list_result',
        'task_result',
        'operation_result',
      ]
    );
    assert.ok(
      catalog.tools.every(
        (tool) =>
          tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false
      )
    );
    assert.equal(catalog.tools[0].annotations.readOnlyHint, true);
    assert.equal(catalog.tools[0].title, '\u5929\u79a7\u5de5\u5177\u6267\u884c\u7ed3\u679c');
    const reference = 'txr_' + 'a'.repeat(32);
    const result = await client.callTool({ name: 'read_result', arguments: { reference } });
    assert.equal(result.isError, false);
    assert.ok(result.content[0].text.includes('Read #1'));
    assert.equal(result.content[0].text.includes(reference), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_RESULT'), false);
    assert.equal(result.structuredContent, undefined);
    assert.equal(JSON.stringify(result).includes(reference), false);
    assert.deepEqual(Object.keys(result).sort(), ['content', 'isError']);
    assert.equal(reads, 1);
    for (const params of [
      { name: 'Read', arguments: { reference } },
      { name: 'read_result', arguments: { reference, path: 'PRIVATE_PATH' } },
      { name: 'read_result', arguments: { reference: 'bad' } },
    ])
      assert.equal((await client.callTool(params)).isError, true);
    assert.equal(reads, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('Code Mode consumes text-only MCP results without exposing lookup metadata', async () => {
  const reference = 'txr_' + 'a'.repeat(32);
  const server = createTianxiResultMcpServer(async () => ({
    reference,
    tool: 'Read',
    ordinal: 1,
    status: 'completed',
    taskStatus: 'in_progress',
  }));
  const client = new Client({ name: 'code-mode-display-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const call = createTianxiResultCall(reference, {
      kind: 'code_mode',
      namespace: 'functions',
      name: 'exec',
    });
    const output = [];
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('ALL_TOOLS', 'tools', 'text', call.input)(
      [{ name: 'mcp__tianxi_progress__read_result' }],
      {
        mcp__tianxi_progress__read_result: (args) =>
          client.callTool({ name: 'read_result', arguments: args }),
      },
      (text) => output.push(text)
    );
    assert.deepEqual(output, [formatTianxiToolResult('Read', 1, 'completed', 'in_progress')]);
    assert.equal(JSON.stringify(output).includes(reference), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP presentation reports unsuccessful tools and rejects malformed display records safely', async () => {
  const reference = 'txr_' + 'a'.repeat(32);
  const base = {
    reference,
    tool: 'Read',
    ordinal: 1,
    status: 'completed',
    taskStatus: 'completed',
  };
  let record = base;
  const server = createTianxiResultMcpServer(async () => record);
  const client = new Client({ name: 'display-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    for (const status of ['failed', 'canceled', 'incomplete']) {
      record = { ...base, status };
      const result = await client.callTool({ name: 'read_result', arguments: { reference } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(result.content[0].text, formatTianxiToolResult('Read', 1, status, 'completed'));
      assert.ok(result.content[0].text.includes('Read #1'));
    }
    for (const invalid of [
      null,
      {},
      { ...base, reference: 'PRIVATE' },
      { ...base, tool: 'PRIVATE' },
      { ...base, ordinal: 513 },
      { ...base, taskStatus: 'PRIVATE' },
    ]) {
      record = invalid;
      const result = await client.callTool({ name: 'read_result', arguments: { reference } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('task categories survive cache, HTTP reader and SDK presentation with distinct request status', async () => {
  const categories = {
    TaskCreate: '\u521b\u5efa\u4efb\u52a1',
    TaskUpdate: '\u66f4\u65b0\u4efb\u52a1',
    TaskList: '\u67e5\u770b\u4efb\u52a1\u5217\u8868',
    TaskGet: '\u67e5\u770b\u4efb\u52a1',
  };
  const cache = createTianxiToolResultCache();
  const task = cache.begin('owner');
  const reader = createTianxiResultReader({
    credential: () => '',
    fetch: async (_url, options) => {
      const reference = JSON.parse(options.body).metadata.tianxi_result_reference;
      return Response.json({
        object: 'tianxi.tool_result',
        ...cache.lookup('owner', reference),
        subject: 'PRIVATE_SUBJECT',
        result: 'PRIVATE_RESULT',
      });
    },
  });
  const server = createTianxiResultMcpServer(reader);
  const client = new Client({ name: 'task-display-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    for (const [tool, label] of Object.entries(categories)) {
      for (const status of ['completed', 'failed', 'canceled', 'incomplete']) {
        const id = `${tool}-${status}`;
        const operation = cache.start('owner', task, id, tool);
        assert.equal(operation.tool, tool);
        cache.finish('owner', task, id, status);
        const result = await client.callTool({
          name: 'read_result',
          arguments: { reference: operation.reference },
        });
        assert.equal(result.isError, status !== 'completed');
        assert.equal(result.structuredContent, undefined);
        assert.equal(
          result.content[0].text,
          formatTianxiToolResult(tool, operation.ordinal, status, 'in_progress')
        );
        assert.ok(result.content[0].text.startsWith(label));
        assert.ok(result.content[0].text.includes(`${tool} #${operation.ordinal}`));
        assert.ok(
          result.content[0].text.includes(
            '\u6574\u4f53\u4efb\u52a1\uff08\u8bfb\u53d6\u7ed3\u679c\u65f6\uff09\uff1a\u8fdb\u884c\u4e2d'
          )
        );
        assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
        assert.equal(result.content[0].text.includes(operation.reference), false);
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('SDK result calls bound concurrent readers and release slots after failure', async () => {
  const releases = [];
  const server = createTianxiResultMcpServer(
    () => new Promise((_resolve, reject) => releases.push(reject))
  );
  const client = new Client({ name: 'unit-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const request = { name: 'read_result', arguments: { reference: 'txr_' + 'a'.repeat(32) } };
    const calls = Array.from({ length: 128 }, () => client.callTool(request));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 128);
    assert.equal((await client.callTool(request)).isError, true);
    releases.splice(0).forEach((reject) => reject(new Error('private failure detail')));
    const results = await Promise.all(calls);
    assert.ok(results.every((result) => result.isError));
    assert.equal(JSON.stringify(results).includes('private failure detail'), false);
    const next = client.callTool(request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 1);
    releases[0](new Error('failed'));
    assert.equal((await next).isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
