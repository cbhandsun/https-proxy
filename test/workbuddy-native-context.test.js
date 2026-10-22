'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planNativeWorkBuddyContext,
  measureNativeWorkBuddyBody,
  nativeWorkBuddyResponseAllowed,
} = require('../lib/proxy/workbuddy-native-context');
const { createHash } = require('node:crypto');
const { composeContextProtocolOptions } = require('../lib/proxy/context-recovery-policy');
const { createWorkBuddyContextPreparation } = require('../lib/proxy/workbuddy-context-preparation');
const { prepareWorkBuddyTaskStateContext } = require('../lib/proxy/workbuddy-task-state-planner');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { prepareConvertedChatBody } = require('../lib/proxy/handlers/converted-chat-request');

const limits = { targetBodyBytes: 100000, operationalInputTokens: 100000 };
const policy = composeContextProtocolOptions({}, { appSettings: { contextPolicyVersion: 2 } });
const input = () => ({
  model: 'other',
  messages: [
    { role: 'user', content: 'PRIVATE_USER🙂' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c', content: 'PRIVATE_RESULT🙂'.repeat(1000) },
    { role: 'user', content: 'continue' },
  ],
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  optional: undefined,
});

test('native response validation rejects private tools, retired or duplicate IDs and invalid external tool arguments', () => {
  const body = input();
  const call = { id: 'new', type: 'function', function: { name: 'read', arguments: '{}' } };
  const wire = (calls, extra = {}) =>
    JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: calls ? 'tool_calls' : 'stop',
          message: { role: 'assistant', content: null, ...(calls ? { tool_calls: calls } : {}) },
          ...extra,
        },
      ],
    });
  assert.equal(nativeWorkBuddyResponseAllowed(wire([call]), body, 100000), true);
  assert.equal(nativeWorkBuddyResponseAllowed(wire(null), body, 100000), true);
  assert.equal(nativeWorkBuddyResponseAllowed('PRIVATE_BROKEN', body, 100000), false);
  assert.equal(nativeWorkBuddyResponseAllowed(wire([call]), body, 1), false);
  assert.equal(
    nativeWorkBuddyResponseAllowed(wire([call]), body, 100000, [
      createHash('sha256').update(call.id).digest('hex'),
    ]),
    false
  );
  for (const calls of [
    [call, call],
    [{ ...call, id: 'c' }],
    [{ ...call, id: '' }],
    [{ ...call, id: ' ' }],
    [{ ...call, id: '\u0000' }],
    [{ ...call, type: 'custom' }],
    [null],
    [false],
    [[]],
    ...['hpm_read_context_artifact', 'hpm_discover_tools', 'undeclared'].map((name) => [
      { ...call, function: { ...call.function, name } },
    ]),
    ...['oops', 'null', '[]', 'false', 1].map((argumentsValue) => [
      { ...call, function: { ...call.function, arguments: argumentsValue } },
    ]),
  ])
    assert.equal(nativeWorkBuddyResponseAllowed(wire(calls), body, 100000), false);
  assert.equal(
    nativeWorkBuddyResponseAllowed(wire([call]), { ...body, tool_choice: 'none' }, 100000),
    false
  );
  assert.equal(
    nativeWorkBuddyResponseAllowed(
      wire([call]),
      { ...body, tool_choice: { function: { name: 'other' } } },
      100000
    ),
    false
  );
  assert.equal(
    nativeWorkBuddyResponseAllowed(wire([call], { finish_reason: 'stop' }), body, 100000),
    false
  );
  for (const name of ['hpm_read_context_artifact', 'hpm_discover_tools']) {
    const offered = { ...body, tools: [{ type: 'function', function: { name } }] };
    assert.equal(
      nativeWorkBuddyResponseAllowed(
        wire([{ ...call, function: { ...call.function, name } }]),
        offered,
        100000
      ),
      false
    );
  }
});

test('native admission measures the whole window and never changes identities, tool schema or diagnostics contents', () => {
  const body = input();
  const before = JSON.stringify(body);
  const measured = measureNativeWorkBuddyBody(body);
  assert.equal(measured.bytes, Buffer.byteLength(before));
  for (const options of [
    limits,
    { ...limits, targetBodyBytes: 1 },
    { ...limits, operationalInputTokens: 1 },
  ]) {
    const result = planNativeWorkBuddyContext(body, options);
    assert.equal(result.body, body);
    assert.equal(result.body.messages, body.messages);
    assert.equal(result.body.tools, body.tools);
    assert.equal(result.changed, false);
    assert.equal(result.fits, options === limits);
    assert.equal(result.diagnostics.artifactsStored, 0);
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /PRIVATE_USER|PRIVATE_RESULT/);
  }
  assert.equal(JSON.stringify(body), before);
  assert.equal(planNativeWorkBuddyContext({ messages: [] }, limits).fits, true);
});

test('native admission rejects unsafe, empty, malformed and extreme data without executing hooks or leaking errors', () => {
  let executed = 0;
  const cycle = {};
  cycle.self = cycle;
  let deep = {};
  for (let index = 0; index < 66; index++) deep = { next: deep };
  const bad = [
    null,
    [],
    {},
    { messages: null },
    { messages: [], x: NaN },
    { messages: [], x: Infinity },
    { messages: [], x: 1n },
    { messages: [], x: () => {} },
    { messages: [undefined] },
    { messages: [], x: cycle },
    { messages: [], x: deep },
    { messages: new Array(300000) },
    { messages: new Array(1) },
    { messages: [], x: new Date() },
    {
      get messages() {
        executed++;
        return [];
      },
    },
    {
      messages: [],
      toJSON() {
        executed++;
        return {};
      },
    },
    {
      messages: [],
      x: {
        get type() {
          executed++;
          return 'text';
        },
      },
    },
    { messages: [], x: 'x'.repeat(64 * 1024 * 1024 + 1) },
    new Proxy(
      {},
      {
        ownKeys() {
          throw Error('PRIVATE_VALUE');
        },
      }
    ),
  ];
  for (const body of bad)
    assert.throws(() => measureNativeWorkBuddyBody(body), {
      code: 'invalid_native_context_request',
      message: 'Invalid native context request',
    });
  for (const value of [
    undefined,
    null,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    '100',
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const key of ['targetBodyBytes', 'operationalInputTokens'])
      assert.throws(() => planNativeWorkBuddyContext(input(), { ...limits, [key]: value }), {
        code: 'invalid_native_context_request',
      });
  }
  assert.throws(
    () =>
      planNativeWorkBuddyContext(input(), {
        ...limits,
        get targetBodyBytes() {
          executed++;
          return 100000;
        },
      }),
    { code: 'invalid_native_context_request' }
  );
  assert.equal(executed, 0);
  const body = { messages: [], [Symbol('internal')]: true };
  Object.defineProperty(body, '__hpmDiagnostics', { value: { private: true } });
  assert.equal(measureNativeWorkBuddyBody(body).bytes, Buffer.byteLength('{"messages":[]}'));
});

test('all native planner entry points bypass history, storage, scheduling and summary callbacks, even with force', async () => {
  const body = input();
  const options = {
    ...limits,
    contextPolicyOptions: policy,
    force: true,
    get artifactStore() {
      throw Error('must not open store');
    },
    get historyBranch() {
      throw Error('must not capture history');
    },
  };
  const runtime = new Proxy(
    {},
    {
      get() {
        throw Error('must not run recovery');
      },
    }
  );
  const preparation = await createWorkBuddyContextPreparation().prepare(body, options, runtime);
  assert.equal(preparation.background, null);
  assert.equal(preparation.plan.body, body);
  assert.equal((await prepareWorkBuddyTaskStateContext(body, options, runtime)).body, body);
  assert.equal(planWorkBuddyWbipcRequest(body, options).body, body);
  assert.equal(planWorkBuddyWbipcRequest(body, { contextPolicyOptions: policy }).fits, true);
});

test('provider preparation cannot fold original tool evidence before the native budget check', () => {
  for (const prepared of [
    { authProvider: 'workbuddy', profile: { protocol: 'workbuddy', optimizeContext: true } },
    { profile: { protocol: 'claude', optimizeContext: true } },
  ]) {
    const body = input();
    const before = JSON.stringify(body.messages);
    prepareConvertedChatBody(prepared, body, body.model, {
      protocolOptions: policy,
      optimizerOptions: { keepRecentTurns: 0, maxHistoricalToolChars: 1 },
    });
    assert.equal(JSON.stringify(body.messages), before);
  }
});
