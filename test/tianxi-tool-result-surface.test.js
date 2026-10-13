'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  resolveTianxiResultBridge,
  createTianxiResultCall,
  isTianxiResultCall,
} = require('../lib/proxy/tianxi-tool-result-continuation');

test('cached call replay accepts only canonical reader programs and references', () => {
  const { replayTianxiResultCall } = require('../lib/proxy/tianxi-tool-result-replay');
  const ref = 'txr_' + 'c'.repeat(32);
  for (const binding of [
    { namespace: 'functions', name: 'exec', kind: 'code_mode' },
    { namespace: 'mcp__tianxi_progress', name: 'read_result' },
    { name: 'mcp__tianxi_progress__read_result' },
  ]) {
    const call = createTianxiResultCall(ref, binding);
    assert.equal(isTianxiResultCall(call), true);
    const field = call.type === 'custom_tool_call' ? 'input' : 'arguments';
    for (const invalid of [
      null,
      [],
      {},
      { ...call, [field]: 'PRIVATE' },
      { ...call, private: 'SECRET' },
      { ...call, call_id: 'other' },
      { ...call, name: 'Bash' },
      { ...call, status: 'incomplete' },
      { ...call, id: 'bad' },
    ]) {
      assert.equal(isTianxiResultCall(invalid), false);
      assert.throws(() =>
        replayTianxiResultCall({ status: 'completed', output: [] }, invalid, {}, true)
      );
    }
  }
});
const reader = { type: 'function', name: 'read_result' };
const namespace = { type: 'namespace', name: 'mcp__tianxi_progress', tools: [reader] };
const flat = { type: 'function', name: 'mcp__tianxi_progress__read_result' };
const codeMode = {
  type: 'namespace',
  name: 'functions',
  tools: [
    { type: 'custom', name: 'exec', description: 'Use tools and ALL_TOOLS from the code runtime.' },
  ],
};

test('Code Mode bridges only the advertised exec runtime and generates a bounded read-only call', async () => {
  const { parseTianxiResultContinuation } = require('../lib/proxy/tianxi-tool-result-continuation');
  const binding = resolveTianxiResultBridge(
    [],
    [{ type: 'additional_tools', role: 'developer', tools: [codeMode] }]
  );
  assert.equal(binding.kind, 'code_mode');
  const reference = 'txr_' + 'b'.repeat(32);
  const call = createTianxiResultCall(reference, binding);
  assert.equal(call.type, 'custom_tool_call');
  assert.equal(call.namespace, 'functions');
  assert.equal(call.name, 'exec');
  assert.equal(call.arguments, undefined);
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    'ALL_TOOLS',
    'tools',
    'text',
    call.input
  );
  const displayed = [];
  let calls = 0;
  const registry = [{ name: 'mcp__tianxi_progress__read_result' }];
  await run(
    registry,
    {
      mcp__tianxi_progress__read_result: async (args) => {
        calls++;
        assert.deepEqual(args, { reference });
        return {
          content: [
            { type: 'text', text: 'Safe status' },
            { type: 'image', data: 'private' },
          ],
        };
      },
    },
    (value) => displayed.push(value)
  );
  assert.equal(calls, 1);
  assert.deepEqual(displayed, ['Safe status']);
  await assert.rejects(
    run([], {}, () => {}),
    /unavailable/
  );
  await assert.rejects(
    run(registry, { mcp__tianxi_progress__read_result: async () => ({ isError: true }) }, () => {}),
    /retrieval failed/
  );
  assert.deepEqual(
    parseTianxiResultContinuation([
      { type: 'custom_tool_call_output', call_id: call.call_id, output: 'untrusted' },
    ]),
    { kind: 'bridge', references: [reference] }
  );
  assert.deepEqual(
    parseTianxiResultContinuation([
      { role: 'user', content: 'new task' },
      { type: 'custom_tool_call_output', call_id: 'call_other' },
    ]),
    { kind: 'none' }
  );
  assert.equal(resolveTianxiResultBridge([codeMode, namespace]).name, 'read_result');
});

test('Code Mode cannot be enabled by arbitrary names, unsafe references or incompatible callers', () => {
  for (const declaration of [
    { ...codeMode, name: 'other' },
    { ...codeMode, tools: [{ ...codeMode.tools[0], name: 'exec_command' }] },
    { ...codeMode, tools: [{ ...codeMode.tools[0], description: 'Execute arbitrary code' }] },
    {
      ...codeMode,
      tools: [{ ...codeMode.tools[0], description: 'ALL_TOOLS tools ' + 'x'.repeat(65536) }],
    },
    { ...codeMode, tools: [{ ...codeMode.tools[0], allowed_callers: ['programmatic'] }] },
  ])
    assert.equal(resolveTianxiResultBridge([declaration]), null);
  const binding = resolveTianxiResultBridge([codeMode]);
  for (const reference of ['', null, 'txr_"; throw new Error()', 'txr_' + 'a'.repeat(10000)])
    assert.equal(createTianxiResultCall(reference, binding), null);
});

test('Result bridge resolves eager, additional and discovered tools with the declared call shape', () => {
  for (const declaration of [namespace, flat]) {
    for (const inputType of ['tools', 'additional_tools', 'tool_search_output']) {
      const input =
        inputType === 'tools'
          ? []
          : [
              {
                type: inputType,
                role: 'developer',
                status: 'completed',
                execution: 'client',
                tools: [declaration],
              },
            ];
      const binding = resolveTianxiResultBridge(inputType === 'tools' ? [declaration] : [], input);
      assert.equal(binding.source, inputType);
      const call = createTianxiResultCall('txr_' + 'a'.repeat(32), binding);
      assert.equal(call.type, 'function_call');
      assert.equal(call.name, declaration === flat ? flat.name : reader.name);
      assert.equal(call.namespace, declaration === flat ? undefined : namespace.name);
      assert.deepEqual(JSON.parse(call.arguments), { reference: 'txr_' + 'a'.repeat(32) });
    }
  }
  assert.equal(
    resolveTianxiResultBridge([{ ...namespace, tools: undefined, functions: [reader] }]).name,
    'read_result'
  );
});

test('Deferred tools require a completed discovery or developer injection before direct dispatch', () => {
  const deferred = { ...namespace, tools: [{ ...reader, defer_loading: true }] };
  assert.equal(resolveTianxiResultBridge([deferred]), null);
  for (const execution of ['client', 'server']) {
    const binding = resolveTianxiResultBridge(
      [deferred],
      [{ type: 'tool_search_output', status: 'completed', execution, tools: [deferred] }]
    );
    assert.equal(binding.source, 'tool_search_output');
  }
  for (const input of [
    [{ type: 'additional_tools', role: 'user', tools: [namespace] }],
    [
      {
        type: 'tool_search_output',
        status: 'in_progress',
        execution: 'client',
        tools: [namespace],
      },
    ],
    [{ type: 'tool_search_output', status: 'completed', execution: 'invalid', tools: [namespace] }],
  ])
    assert.equal(resolveTianxiResultBridge([], input), null);
  for (const allowed_callers of [['programmatic'], 'direct', []])
    assert.equal(
      resolveTianxiResultBridge([{ ...namespace, tools: [{ ...reader, allowed_callers }] }]),
      null
    );
  assert.equal(
    resolveTianxiResultBridge([
      { ...namespace, tools: [{ ...reader, allowed_callers: ['direct', 'programmatic'] }] },
    ]).name,
    'read_result'
  );
});

test('Malformed and extreme tool surfaces fail closed, and descriptors cannot select other tools', () => {
  for (const tools of [null, {}, [], [null], [[namespace]], Array(1025).fill(namespace)])
    assert.equal(resolveTianxiResultBridge(tools), null);
  for (const input of [
    42,
    {},
    Array(4097).fill({}),
    [{ type: 'additional_tools', role: 'developer', tools: null }],
    [{ type: 'additional_tools', role: 'developer', tools: Array(1025).fill(namespace) }],
    Array(3).fill({ type: 'additional_tools', role: 'developer', tools: Array(1024).fill(flat) }),
  ])
    assert.equal(resolveTianxiResultBridge([], input), null);
  assert.equal(resolveTianxiResultBridge([namespace, null]), null);
  assert.equal(resolveTianxiResultBridge([{ ...namespace, tools: [null] }]), null);
  for (const binding of [null, {}, { namespace: 'other', name: 'read_result' }, { name: 'Bash' }])
    assert.equal(createTianxiResultCall('txr_' + 'a'.repeat(32), binding), null);
  assert.equal(resolveTianxiResultBridge([{ ...flat, namespace: 'other' }]), null);
});
