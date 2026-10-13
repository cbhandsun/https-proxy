'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { Response, ReadableStream, AbortSignal, AbortController, structuredClone } = globalThis;
const { once } = require('node:events');
const { createContextRecoveryClient } = require('../lib/client/context-recovery-client');
const { createRecoveryHistory } = require('../lib/client/context-recovery-history');
const { safeData, validateOriginal } = require('../lib/client/context-recovery-data');
const { compactionReplayFailure } = require('../lib/proxy/context-compaction-lifecycle');
const {
  createContextCompactionEnvelopeStore,
} = require('../lib/proxy/context-compaction-envelope');
const { prepareWorkBuddyCompactionInput } = require('../lib/proxy/workbuddy-compaction-bridge');
const {
  CONTEXT_TARGET_HEADER,
  contextTargetToken,
  inspectClientContextTarget,
} = require('../lib/proxy/client-context-target');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const path = require('node:path');

const options = {
  enabled: true,
  endpoint: 'http://127.0.0.1:3085/v1/responses',
  model: 'model',
  owner: 'profile',
  threadId: 'thread',
  targetBinding: {
    owner: 'profile',
    provider: 'workbuddy-wbipc',
    model: 'model',
    endpoint: 'https://host:443/v2',
  },
};
const source = [
  { type: 'message', role: 'system', content: '原始策略：只读，不执行命令🙂' },
  {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: '禁止写入和发消息' }],
  },
  { type: 'message', role: 'user', content: '先读取两个原文' },
  { type: 'function_call', call_id: 'a', name: 'read', arguments: '{ "path": "甲🙂" }' },
  { type: 'function_call', call_id: 'b', name: 'read', arguments: '{"path":"乙"}' },
  { type: 'function_call_output', call_id: 'b', output: '乙证据：中段42🙂' },
  { type: 'function_call_output', call_id: 'a', output: '甲证据：0\u0000尾部' },
  { type: 'message', role: 'assistant', content: '尚未验证结果' },
  { type: 'message', role: 'user', content: '撤销先前要求，只按新约束给出结论🙂' },
];
const request = {
  model: 'model',
  instructions: '原生客户端完整策略，不修改🙂',
  stream: true,
  store: false,
  previous_response_id: 'stale-response',
  input: [
    { type: 'compaction', encrypted_content: 'hpm-local-compaction-v2:expired' },
    source.at(-1),
  ],
  tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
  tool_choice: 'auto',
  parallel_tool_calls: true,
};

function failure(code = 'invalid_local_compaction') {
  const result = compactionReplayFailure({ code });
  return new Response(JSON.stringify(result.payload), {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      [CONTEXT_TARGET_HEADER]: contextTargetToken(options.targetBinding),
    },
  });
}

function mockClient(responder, overrides = {}) {
  const sent = [];
  const client = createContextRecoveryClient({
    ...options,
    targetBinding: { ...options.targetBinding, owner: overrides.owner ?? options.owner },
    ...overrides,
    async fetchImpl(url, init) {
      const body = JSON.parse(init.body);
      sent.push({ url, init, body });
      return responder(sent.length, body, init);
    },
  });
  return {
    client,
    sent,
    capture: (body = request, originalInput = source) =>
      client.capture({ request: body, originalInput, complete: true }),
  };
}

test('explicit opt-in rebuilds exact original history once, retaining roles, revocation, parallel IDs and policy', async () => {
  const f = mockClient((round) =>
    round === 1
      ? failure()
      : new Response('event: response.completed\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
  );
  const before = JSON.stringify(request);
  const handle = f.capture();
  const result = await f.client.send(request, { history: handle });
  assert.equal(await result.text(), 'event: response.completed\n\n');
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1].body.input, source);
  const expected = { ...request, input: source };
  delete expected.previous_response_id;
  assert.deepEqual(f.sent[1].body, expected);
  assert.equal(f.sent[1].url, f.sent[0].url);
  assert.equal(f.sent[1].init.redirect, 'manual');
  assert.equal(f.sent[1].init.credentials, 'omit');
  assert.equal(JSON.stringify(request), before);
  assert.deepEqual(Object.keys(handle), []);
  f.client.close();
});

test('disabled clients and callers without a history capability never retry', async () => {
  for (const enabled of [false, true]) {
    const f = mockClient(() => failure(), { enabled });
    assert.equal((await f.client.send(request)).status, 400);
    assert.equal(f.sent.length, 1);
    if (!enabled) {
      assert.throws(() => f.capture(), { code: 'client_recovery_disabled' });
      await assert.rejects(f.client.send(request, { history: {} }), {
        code: 'client_recovery_disabled',
      });
    }
    f.client.close();
  }
  assert.throws(() => createContextRecoveryClient(), { code: 'invalid_client_recovery' });
});

test('only exact pre-generation local-compaction contracts recover; all other errors remain errors', async () => {
  const cases = [
    [
      400,
      {
        error: {
          code: 'unapproved_channel',
          recovery: { action: 'resend_full_history', replay_external_tools: false },
        },
      },
    ],
    [400, compactionReplayFailure({ code: 'foreign_compaction_state' }).payload],
    [502, compactionReplayFailure({ code: 'invalid_local_compaction' }).payload],
    [
      400,
      {
        error: {
          ...compactionReplayFailure({}).payload.error,
          recovery: { action: 'resend_full_history', replay_external_tools: true },
        },
      },
    ],
    [
      400,
      {
        error: {
          ...compactionReplayFailure({}).payload.error,
          recovery: { action: 'resend_full_history' },
        },
      },
    ],
    [400, { error: { ...compactionReplayFailure({}).payload.error, type: 'api_error' } }],
    [429, compactionReplayFailure({}).payload],
    [500, compactionReplayFailure({}).payload],
    [400, null],
  ];
  for (const [status, payload] of cases) {
    const wire = JSON.stringify(payload);
    const f = mockClient(
      () => new Response(wire, { status, headers: { 'content-type': 'application/json' } })
    );
    const response = await f.client.send(request, { history: f.capture() });
    assert.equal(response.status, status);
    assert.equal(await response.text(), wire);
    assert.equal(f.sent.length, 1);
    f.client.close();
  }
  for (const code of [
    'compaction_evidence_unavailable',
    'compaction_requires_full_history',
    'local_compaction_closed',
    'local_compaction_clock_invalid',
  ]) {
    const f = mockClient(() => failure(code));
    assert.equal(
      (await f.client.send(request, { history: f.capture() })).status,
      code === 'compaction_evidence_unavailable' ? 502 : 400
    );
    assert.equal(f.sent.length, 2, 'a second error is returned, never looped');
    f.client.close();
  }
});

test('successful or non-JSON streams are not consumed, interpreted or retried', async () => {
  for (const [status, type] of [
    [200, 'text/event-stream'],
    [200, 'application/json'],
    [400, 'text/event-stream'],
    [400, 'text/plain'],
  ]) {
    const response = new Response('data: {"type":"response.failed"}\n\n', {
      status,
      headers: { 'content-type': type },
    });
    const f = mockClient(() => response);
    assert.equal(await f.client.send(request, { history: f.capture() }), response);
    assert.equal(response.bodyUsed, false);
    assert.equal(f.sent.length, 1);
    f.client.close();
  }
});

test('unconfirmed/old gateways and mismatched route acknowledgements cannot request original history', async () => {
  for (const acknowledged of [null, '', 'v1.' + '0'.repeat(64)]) {
    const f = mockClient(() => {
      const response = failure();
      if (acknowledged === null) response.headers.delete(CONTEXT_TARGET_HEADER);
      else response.headers.set(CONTEXT_TARGET_HEADER, acknowledged);
      return response;
    });
    const response = await f.client.send(request, { history: f.capture() });
    assert.equal(response.status, 400);
    assert.equal(f.sent.length, 1);
    assert.notDeepEqual(f.sent[0].body.input, source);
    assert.equal(
      f.sent[0].init.headers.get(CONTEXT_TARGET_HEADER),
      contextTargetToken(options.targetBinding)
    );
    f.client.close();
  }
  for (const targetBinding of [
    undefined,
    null,
    {},
    { ...options.targetBinding, owner: 'other' },
    { ...options.targetBinding, provider: 'other' },
    { ...options.targetBinding, model: '' },
  ])
    assert.throws(() => createContextRecoveryClient({ ...options, targetBinding }));
});

test('missing, incomplete, fabricated or unsupported original histories fail before dispatch', () => {
  const f = mockClient(() => failure());
  for (const originalInput of [
    null,
    [],
    [source[0]],
    [
      { role: 'user', content: [] },
      { type: 'compaction', encrypted_content: 'opaque' },
    ],
    [{ role: 'assistant', content: '[HPM_LOCAL_COMPACTION_SUMMARY_V1]\nsummary' }],
    [{ role: 'assistant', tool_calls: [], content: 'chat format' }],
    [{ type: 'reasoning', encrypted_content: 'opaque' }],
    [{ role: 'tool', content: 'unpaired' }],
    [{ role: 'user', content: [{ type: 'input_text', text: 1 }] }],
    [{ role: 'user', content: [null] }],
    [{ role: 'user', content: [{ type: 'unknown' }] }],
  ]) {
    assert.throws(() => f.capture(request, originalInput));
  }
  assert.throws(() => f.client.capture({ request, originalInput: source, complete: false }), {
    code: 'original_history_unavailable',
  });
  assert.throws(() => f.client.capture({ request, originalInput: undefined, complete: true }));
  assert.throws(() => f.client.capture(null), { code: 'invalid_client_recovery' });
  assert.throws(() => f.client.capture([]), { code: 'invalid_client_recovery' });
  assert.throws(() => f.capture({ ...request, conversation: 'server-conversation' }));
  assert.throws(
    () =>
      f.capture({
        ...request,
        input: [{ type: 'compaction', encrypted_content: 'native-opaque' }],
      }),
    { code: 'foreign_compaction_state' }
  );
  assert.throws(() => f.capture({ ...request, input: [{ type: 'compaction_trigger' }] }), {
    code: 'original_history_mismatch',
  });
  assert.equal(f.sent.length, 0);
  f.client.close();
});

test('all parallel/custom tool results must be original, typed, complete and unique', () => {
  const call = { type: 'function_call', name: 'read', call_id: 'one', arguments: '{}' };
  const result = { type: 'function_call_output', call_id: 'one', output: 'exact' };
  const invalid = [
    [call],
    [result],
    [result, call],
    [call, call, result],
    [call, result, result],
    [{ ...call, arguments: 'broken' }, result],
    [{ ...call, arguments: '[]' }, result],
    [{ ...call, arguments: 'null' }, result],
    [{ ...call, call_id: '' }, result],
    [{ ...call, name: 'bad\nname' }, result],
    [{ ...call, arguments: 1 }, result],
    [call, { ...result, output: 1 }],
    [call, { ...result, type: 'custom_tool_call_output' }],
    [call, { ...result, call_id: 'foreign' }],
    [null],
    [[]],
  ];
  for (const input of invalid) assert.throws(() => validateOriginal(safeData(input)));
  validateOriginal(
    safeData([
      { type: 'custom_tool_call', name: 'read', call_id: 'custom', input: 'exact source' },
      {
        type: 'custom_tool_call_output',
        call_id: 'custom',
        output: [{ type: 'input_text', text: '🙂' }],
      },
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,a' },
          { type: 'input_file', file_id: 'file' },
          { type: 'refusal', refusal: 'no' },
        ],
      },
    ])
  );
});

test('history capabilities bind exact requests and client targets; mutations cannot cross requests or scopes', async () => {
  const f = mockClient(() => failure());
  const handle = f.capture();
  for (const changed of [
    { ...request, instructions: 'changed-policy' },
    { ...request, stream: false },
    { ...request, input: [...request.input, { role: 'user', content: 'new revocation' }] },
    { ...request, tools: [] },
  ]) {
    await assert.rejects(f.client.send(changed, { history: handle }), {
      code: 'original_history_mismatch',
    });
  }
  await assert.rejects(f.client.send({ ...request, model: 'other' }, { history: handle }), {
    code: 'client_recovery_target_mismatch',
  });
  for (const changes of [
    { owner: 'another' },
    { threadId: 'other-thread' },
    { endpoint: 'http://localhost:3085/v1/responses' },
  ]) {
    const other = mockClient(() => failure(), changes);
    await assert.rejects(other.client.send(request, { history: handle }), {
      code: 'original_history_mismatch',
    });
    assert.equal(other.sent.length, 0);
    other.client.close();
  }
  await assert.rejects(f.client.send(request, { history: {} }), {
    code: 'original_history_mismatch',
  });
  f.client.discard(handle);
  await assert.rejects(f.client.send(request, { history: handle }), {
    code: 'original_history_mismatch',
  });
  assert.equal(f.sent.length, 0);
  f.client.close();
});

test('snapshot copies are immutable by callers and consecutive compaction cycles retain original evidence', async () => {
  const f = mockClient((round) => (round % 2 === 1 ? failure() : new Response('ok')));
  const original = structuredClone(source);
  const handle = f.capture(request, original);
  original[0].content = 'caller overwrite';
  assert.equal((await f.client.send(request, { history: handle })).status, 200);
  assert.deepEqual(f.sent[1].body.input, source);
  for (let cycle = 0; cycle < 3; cycle++) {
    const tail = { role: 'user', content: '新一轮撤销🙂' + cycle };
    const body = {
      ...request,
      input: [
        { type: 'compaction', encrypted_content: 'hpm-local-compaction-v1:restart-' + cycle },
        tail,
      ],
    };
    const input = [...source, tail];
    const next = f.capture(body, input);
    await f.client.send(body, { history: next });
    assert.deepEqual(f.sent.at(-1).body.input, input);
    f.client.discard(next);
  }
  f.client.close();
});

test('bounded input rejects accessors, toJSON, sparse arrays, cycles, unsafe numbers and oversized/deep histories', () => {
  const f = mockClient(() => failure());
  let executed = 0;
  const getter = {
    role: 'user',
    get content() {
      executed++;
      return 'private';
    },
  };
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 2;
  let deep = {};
  for (let i = 0; i < 70; i++) deep = { child: deep };
  for (const input of [
    [getter],
    [
      {
        toJSON() {
          executed++;
          return source;
        },
      },
    ],
    cycle,
    sparse,
    [NaN],
    [Infinity],
    deep,
    [{ role: 'user', content: '🙂'.repeat(600000) }],
    Array.from({ length: 2049 }, () => source.at(-1)),
  ]) {
    assert.throws(() => f.capture(request, input));
  }
  assert.equal(executed, 0);
  assert.throws(() =>
    f.client.capture({
      get request() {
        executed++;
        return request;
      },
    })
  );
  assert.equal(executed, 0);
  assert.equal(f.sent.length, 0);
  f.client.close();
});

test('slow error streams time out without a resend or leaking stream cancellation failures', async () => {
  let cancelled = false;
  const f = mockClient(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
            return Promise.reject(new Error('PRIVATE_CANCEL_ERROR'));
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
  );
  await assert.rejects(f.client.send(request, { history: f.capture() }), {
    code: 'client_recovery_error_timeout',
  });
  assert.equal(f.sent.length, 1);
  assert.equal(cancelled, true);
  f.client.close();
});

test('snapshot admission is bounded and does not evict still-owned original history', () => {
  const history = createRecoveryHistory({ maxBytes: 2 * 1024 * 1024 });
  const body = { model: 'model', input: [source.at(-1)] };
  const handles = Array.from({ length: 16 }, () => history.capture(body, source, true));
  assert.throws(() => history.capture(body, source, true), {
    code: 'client_recovery_history_quota',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(history.acquire(handles[0], body)())), source);
  history.release(handles[0]);
  history.discard(handles[1]);
  history.capture(body, source, true);
  history.close();
  const large = [{ role: 'user', content: 'x'.repeat(1800000) }];
  for (let i = 0; i < 4; i++) history.capture({ input: large }, large, true);
  assert.throws(() => history.capture({ input: large }, large, true), {
    code: 'client_recovery_history_quota',
  });
  history.close();
});

test('cancellation, missing originals, closed clients and concurrent duplicate sends cannot dispatch a rebuild', async () => {
  for (const operation of ['abort', 'discard', 'close']) {
    const abort = new AbortController();
    const f = mockClient(() => {
      if (operation === 'abort') abort.abort();
      if (operation === 'discard') f.client.discard(handle);
      if (operation === 'close') f.client.close();
      return failure();
    });
    const handle = f.capture();
    await assert.rejects(f.client.send(request, { history: handle, signal: abort.signal }));
    assert.equal(f.sent.length, 1);
    f.client.close();
    await assert.rejects(f.client.send(request), { code: 'client_recovery_closed' });
  }
  const preAborted = new AbortController();
  preAborted.abort();
  const f = mockClient(() => failure());
  await assert.rejects(f.client.send(request, { signal: preAborted.signal }), {
    code: 'client_recovery_cancelled',
  });
  assert.equal(f.sent.length, 0);
  f.client.close();
  let finish;
  const waiting = mockClient(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const handle = waiting.capture();
  const first = waiting.client.send(request, { history: handle });
  await assert.rejects(waiting.client.send(request, { history: handle }), {
    code: 'client_recovery_busy',
  });
  finish(new Response('ok'));
  await first;
  assert.equal(waiting.sent.length, 1);
  waiting.client.close();
});

test('network failures have safe messages and never retry; redirects cannot change the authorized destination', async () => {
  for (const mode of ['throw', 'redirect', 'second-throw']) {
    const f = mockClient(
      (round) => {
        if (mode === 'second-throw' && round === 1) return failure();
        if (mode === 'redirect')
          return new Response('private', {
            status: 307,
            headers: { location: 'https://external.invalid/' },
          });
        throw new Error('PRIVATE_TOKEN_AND_CONTENT');
      },
      { headers: { Authorization: 'synthetic-token' } }
    );
    await assert.rejects(f.client.send(request, { history: f.capture() }), (error) => {
      assert.ok(!error.message.includes('PRIVATE') && !error.message.includes('synthetic-token'));
      assert.equal(
        error.code,
        mode === 'redirect'
          ? 'client_recovery_redirect_refused'
          : 'client_recovery_transport_failed'
      );
      return true;
    });
    assert.equal(f.sent.length, mode === 'second-throw' ? 2 : 1);
    f.client.close();
  }
  for (const endpoint of [
    'https://external.invalid/v1/responses',
    'file:///v1/responses',
    'http://user:password@localhost/v1/responses',
    'http://localhost/v1/responses?target=evil',
    'http://localhost/v1/responses#fragment',
    'http://localhost/v1/chat/completions',
    'broken',
    null,
  ]) {
    assert.throws(() => createContextRecoveryClient({ ...options, endpoint }));
  }
  for (const override of [
    { enabled: 'true' },
    { maxHistoryBytes: 0 },
    { maxHistoryBytes: Infinity },
    { model: '' },
    { threadId: '\n' },
    { fetchImpl: null },
    { headers: { Host: 'evil' } },
    { headers: { Authorization: 'bad\nheader' } },
    { headers: [] },
  ]) {
    assert.throws(() => createContextRecoveryClient({ ...options, ...override }));
  }
});

test('malformed, oversized or broken error bodies do not authorize recovery', async () => {
  for (const body of ['not-json', 'x'.repeat(17000)]) {
    const f = mockClient(
      () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })
    );
    if (body.length > 16384)
      await assert.rejects(f.client.send(request, { history: f.capture() }), {
        code: 'client_recovery_error_too_large',
      });
    else assert.equal(await (await f.client.send(request, { history: f.capture() })).text(), body);
    assert.equal(f.sent.length, 1);
    f.client.close();
  }
  const f = mockClient(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('PRIVATE_STREAM_ERROR'));
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
  );
  await assert.rejects(f.client.send(request, { history: f.capture() }), {
    code: 'client_recovery_transport_failed',
  });
  assert.equal(f.sent.length, 1);
  f.client.close();
});

test('real loopback HTTP rebuilds after an actual expired/restarted envelope without external-tool replay', async () => {
  let now = 100;
  const binding = {
    owner: 'profile',
    provider: 'workbuddy-wbipc',
    model: 'model',
    endpoint: 'https://host:443/v2',
  };
  const store = createContextCompactionEnvelopeStore({ now: () => now, ttlMs: 100 });
  const token = store.issue(source.slice(0, -1), binding);
  now = 201;
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(body);
    const pinned = inspectClientContextTarget(
      req.headers,
      {
        profile: { id: 'profile', protocol: 'workbuddy', targetUrl: 'https://host:443/v2' },
        rewriteTo: 'model',
        workbuddyAuth: { accessTokenEncrypted: true },
      },
      () => ({ protocol: 'https:', hostname: 'host', port: 443, path: '/v2' }),
      null
    );
    assert.equal(pinned.ok, true);
    res.setHeader(CONTEXT_TARGET_HEADER, pinned.token);
    try {
      const restored = prepareWorkBuddyCompactionInput(body, binding, store);
      assert.deepEqual(JSON.parse(JSON.stringify(restored.body.input)), source);
      assert.equal(restored.trigger, false);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"response.completed"}\n\n');
    } catch (error) {
      const failure = compactionReplayFailure(error);
      res.writeHead(failure.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(failure.payload));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = createContextRecoveryClient({
    ...options,
    endpoint: `http://127.0.0.1:${server.address().port}/v1/responses`,
  });
  try {
    for (const restart of [false, true]) {
      if (restart) store.close();
      const body = {
        ...request,
        input: [{ type: 'compaction', encrypted_content: token }, source.at(-1)],
      };
      const handle = client.capture({ request: body, originalInput: source, complete: true });
      const response = await client.send(body, {
        history: handle,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /response.completed/);
      assert.deepEqual(seen.at(-1).input, source);
      client.discard(handle);
    }
    assert.equal(seen.length, 4);
  } finally {
    client.close();
    store.close();
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }
});

test('client regressions are discovered by the unchanged unified CI unit selector', () => {
  const root = path.resolve(__dirname, '..');
  const selected = selectUnitTestFiles(discoverTestFiles(root), {
    excludedPrefixes: ['test/frontend/'],
  });
  assert.ok(selected.includes('test/client-context-recovery.test.js'));
});
