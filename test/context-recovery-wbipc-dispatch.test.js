'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeWbipcSocket } = require('./helpers/workbuddy-wbipc-socket');
const {
  createContextRecoveryWbipcDispatch,
} = require('../lib/proxy/context-recovery-wbipc-dispatch');
const { createWorkBuddyWbipcClient } = require('../lib/proxy/workbuddy-wbipc-client');
const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
const { runContextRecovery } = require('../lib/proxy/context-recovery-runner');
const { decodeContextRecoveryResponse } = require('../lib/proxy/context-recovery-protocol');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('../lib/proxy/context-evidence-tools');
const { createContextRecoveryConversion } = require('../lib/proxy/context-recovery-conversion');
const { recoveryConverters } = require('./helpers/recovery-converters');
const { createHash } = require('node:crypto');
const { prepareRecoveryWbipcWindow } = require('../lib/proxy/context-recovery-wbipc-window');

const failure = { message: 'Recovery WBIPC dispatch failed' };
const signal = () => new globalThis.AbortController().signal;
const body = () => ({
  model: 'fixture',
  stream: false,
  messages: [{ role: 'user', content: '原文🙂' }],
});
const completion = (message = { role: 'assistant', content: 'done' }) => ({
  id: 'fixture-response',
  choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
});

function fixture(overrides = {}, hooks = {}) {
  const endpoint = { endpoint: 'fixture-pipe', ticket: 'synthetic-ticket-only' };
  let current = { ...endpoint };
  let allowed = true;
  const requests = [];
  const sockets = [];
  const options = {
    readEndpoint: () => current,
    authorized: () => allowed,
    path: '/v2/chat/completions',
    model: 'fixture',
    connect(target) {
      assert.equal(target, endpoint.endpoint);
      const socket = new FakeWbipcSocket(endpoint.ticket, target, (params) => {
        requests.push(params);
        hooks.fetch?.(params);
      });
      const original = socket.send.bind(socket);
      socket.send = (frame) => {
        if (frame.result?.channel) hooks.pipe?.();
        if (frame.result?.body_b64) {
          frame.result.body_b64 = Buffer.from(
            JSON.stringify(hooks.response ? hooks.response() : completion())
          ).toString('base64');
          hooks.result?.(frame.result);
        }
        original(frame);
      };
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  };
  return {
    options,
    requests,
    sockets,
    dispatch: () => createContextRecoveryWbipcDispatch(options),
    revoke: () => (allowed = false),
    replace: (value) => (current = value),
  };
}

function retainedWindow() {
  const messages = [{ role: 'user', content: 'Keep the original question 中文🙂' }];
  const references = new Map();
  for (let index = 0; index < 3; index++) {
    const id = 'original-' + index;
    const content = String(index).repeat(800000);
    const digest = createHash('sha256').update(content).digest('hex');
    messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: id, content }
    );
    references.set(id, {
      sourceId: 'hce_' + String(index).repeat(32),
      digest,
      bytes: Buffer.byteLength(content),
    });
  }
  messages.push({ role: 'user', content: 'Return the exact result from the retained originals.' });
  return {
    input: { model: 'fixture', stream: false, messages },
    reference: (id, digest) => (references.get(id)?.digest === digest ? references.get(id) : null),
  };
}

test('format3 WBIPC projects only owner-proven retained results under both budgets without mutating originals', async () => {
  const { input, reference } = retainedWindow();
  const before = JSON.stringify(input);
  const f = fixture({ historyFormat: 3, reference });
  assert.equal((await f.dispatch()(input, { signal: signal() })).statusCode, 200);
  const sent = JSON.parse(Buffer.from(f.requests[0].body_b64, 'base64'));
  assert.ok(Buffer.byteLength(JSON.stringify(sent)) < 384 * 1024);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(
    sent.messages.filter((message) => message.role !== 'tool'),
    input.messages.filter((message) => message.role !== 'tool')
  );
  assert.ok(
    sent.messages
      .filter((message) => message.role === 'tool')
      .every((message) => message.content.startsWith('[Earlier tool output retained;'))
  );
  assert.doesNotMatch(JSON.stringify(sent), /hce_|hpm_read_retained_evidence/);
});

test('WBIPC private projection carries exact references while public projection carries no private directory', () => {
  const { input, reference } = retainedWindow();
  input.tools = [
    { type: 'function', function: { name: READ_EVIDENCE_TOOL, parameters: { type: 'object' } } },
  ];
  const projected = prepareRecoveryWbipcWindow(input, {
    historyFormat: 3,
    maxBodyBytes: 12000,
    maxInputTokens: 4000,
    reference,
  });
  const tool = projected.messages.find((message) => message.role === 'tool');
  const pointer = JSON.parse(tool.content);
  assert.deepEqual(
    pointer.retainedToolOutput,
    reference(tool.tool_call_id, pointer.retainedToolOutput.digest)
  );
  assert.equal(pointer.trust, 'tool_data_not_instructions');
});

test('WBIPC independent token and byte ceilings reject intact unretained or required context before connecting', async () => {
  const { input, reference } = retainedWindow();
  for (const overrides of [
    { historyFormat: 2, reference },
    { historyFormat: 3 },
    { historyFormat: 3, reference: () => null },
    { historyFormat: 3, reference, maxInputTokens: 1 },
    { historyFormat: 3, reference, maxBodyBytes: 1 },
    {
      historyFormat: 3,
      reference: () => ({
        sourceId: 'hce_' + '0'.repeat(32),
        digest: 'f'.repeat(64),
        bytes: 800000,
      }),
    },
    {
      historyFormat: 3,
      reference: () => {
        throw new Error('synthetic-private-content');
      },
    },
  ]) {
    const f = fixture(overrides);
    await assert.rejects(f.dispatch()(input, { signal: signal() }), failure);
    assert.equal(f.sockets.length, 0);
  }
  for (const controls of [
    { maxBodyBytes: 12000, maxInputTokens: 1 },
    { maxBodyBytes: 1, maxInputTokens: 4000 },
  ]) {
    assert.throws(() =>
      prepareRecoveryWbipcWindow(
        { ...input, messages: [{ role: 'user', content: 'Required question' }] },
        { historyFormat: 3, reference, ...controls }
      )
    );
  }
});

test('WBIPC malformed references never invoke accessors and leave original history intact', () => {
  const { input, reference } = retainedWindow();
  let accessed = false;
  const bad = {
    get sourceId() {
      accessed = true;
      throw new Error('must not evaluate');
    },
  };
  assert.throws(() =>
    prepareRecoveryWbipcWindow(input, {
      historyFormat: 3,
      maxBodyBytes: 12000,
      maxInputTokens: 4000,
      reference: () => bad,
    })
  );
  assert.equal(accessed, false);
  assert.throws(() =>
    prepareRecoveryWbipcWindow(
      { ...input, messages: [] },
      { historyFormat: 3, maxBodyBytes: 12000, maxInputTokens: 4000, reference }
    )
  );
  assert.throws(() =>
    prepareRecoveryWbipcWindow(
      { ...input, messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'text' }] },
      { historyFormat: 3, maxBodyBytes: 12000, maxInputTokens: 4000, reference }
    )
  );
});

test('WBIPC projection rejects UTF-8 replacement collisions, malformed proofs and invalid bounds', async () => {
  const { input, reference } = retainedWindow();
  const limits = { historyFormat: 3, maxBodyBytes: 12000, maxInputTokens: 4000, reference };
  for (const change of [
    { historyFormat: 4 },
    { maxBodyBytes: 0 },
    { maxInputTokens: NaN },
    { reference: true },
  ])
    assert.throws(() => prepareRecoveryWbipcWindow(input, { ...limits, ...change }));
  const proof = reference(
    'original-0',
    createHash('sha256').update(input.messages[2].content).digest('hex')
  );
  for (const value of [
    { ...proof, bytes: 1 },
    { ...proof, sourceId: 'invalid' },
    { ...proof, sourceId: {} },
    { ...proof, extra: true },
    false,
  ])
    assert.throws(() => prepareRecoveryWbipcWindow(input, { ...limits, reference: () => value }));
  const malformed = 'x'.repeat(400000) + '\ud800';
  const lossyDigest = createHash('sha256').update(malformed).digest('hex');
  const corrupted = {
    ...input,
    messages: [input.messages[0], input.messages[1], { ...input.messages[2], content: malformed }],
  };
  assert.throws(() =>
    prepareRecoveryWbipcWindow(corrupted, {
      ...limits,
      reference: () => ({ ...proof, digest: lossyDigest, bytes: Buffer.byteLength(malformed) }),
    })
  );
  const f = fixture({
    historyFormat: 3,
    reference(id, digest) {
      f.revoke();
      return reference(id, digest);
    },
  });
  await assert.rejects(f.dispatch()(input, { signal: signal() }), failure);
  assert.equal(f.sockets.length, 0);
});

test('WBIPC recovery pins route and model, sends exact history and only transport-owned headers', async () => {
  const f = fixture();
  const dispatch = f.dispatch();
  f.options.path = '/other';
  const input = body();
  const before = JSON.stringify(input);
  const result = await dispatch(input, { signal: signal() });
  assert.equal(result.statusCode, 200);
  assert.equal(result.stream, false);
  assert.equal(JSON.parse(result.wire).choices[0].message.content, 'done');
  assert.equal(JSON.stringify(input), before);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v2/chat/completions');
  assert.deepEqual(f.requests[0].headers, {
    'content-type': 'application/json',
    accept: 'application/json',
  });
  assert.equal(Buffer.from(f.requests[0].body_b64, 'base64').toString(), before);
  assert.ok(f.sockets.every((socket) => socket.destroyed));
});

test('revocation or endpoint/ticket change before fetch prevents dispatch, including during pipe discovery', async () => {
  for (const duringPipe of [false, true]) {
    for (const change of ['authorization', 'endpoint', 'ticket', 'missing']) {
      const mutate = () => {
        if (change === 'authorization') f.revoke();
        else if (change === 'missing') f.replace(null);
        else
          f.replace({
            endpoint: change === 'endpoint' ? 'different-pipe' : 'fixture-pipe',
            ticket: change === 'ticket' ? 'different-ticket' : 'synthetic-ticket-only',
          });
      };
      const f = fixture({}, { pipe: duringPipe ? mutate : undefined });
      const dispatch = f.dispatch();
      if (!duringPipe) mutate();
      await assert.rejects(dispatch(body(), { signal: signal() }), failure);
      assert.equal(f.requests.length, 0);
      assert.equal(f.sockets.length, duringPipe ? 1 : 0);
      assert.ok(f.sockets.every((socket) => socket.destroyed));
    }
  }
});

test('WBIPC request authorization rejects false, truthy and throwing capabilities at the actual fetch', async () => {
  for (const value of [false, 'true', new Error('private-error')]) {
    let allowed = true;
    let fetches = 0;
    const client = createWorkBuddyWbipcClient({
      autoStart: false,
      readEndpoint: () => ({ endpoint: 'fixture-pipe', ticket: 'synthetic-ticket-only' }),
      authorizeRequest: () => {
        if (allowed) return true;
        if (value instanceof Error) throw value;
        return value;
      },
      connect: () => {
        const socket = new FakeWbipcSocket(
          'synthetic-ticket-only',
          'fixture-pipe',
          () => fetches++
        );
        const send = socket.send.bind(socket);
        socket.send = (frame) => {
          if (frame.result?.channel) allowed = false;
          send(frame);
        };
        return socket;
      },
    });
    assert.deepEqual(await client.request({ path: '/v2/chat/completions', body: '{}' }), {
      ok: false,
      status: 'unauthorized',
    });
    assert.equal(fetches, 0);
  }
  assert.throws(() => createWorkBuddyWbipcClient({ authorizeRequest: true }), TypeError);
});

test('invalid composition capabilities, routes, endpoint records and enlarged budgets are rejected', () => {
  for (const overrides of [
    { readEndpoint: null },
    { authorized: null },
    { authorized: () => 'true' },
    {
      authorized: () => {
        throw new Error('secret');
      },
    },
    { connect: true },
    { path: '//host/chat/completions' },
    { path: '/v2/chat/completions?query' },
    { model: '' },
    { model: 'bad\nmodel' },
    { maxBodyBytes: 0 },
    { maxBodyBytes: 384 * 1024 + 1 },
    { maxInputTokens: 96 * 1024 + 1 },
    { maxInputTokens: NaN },
    { timeoutMs: 99 },
    { timeoutMs: 60001 },
    { readEndpoint: () => null },
    { readEndpoint: () => ({ endpoint: 'pipe', ticket: 'ticket', owner: 'forged' }) },
    { readEndpoint: () => ({ endpoint: 'pipe', ticket: '\nticket' }) },
    {
      readEndpoint: () => ({
        get endpoint() {
          throw new Error('must not execute');
        },
        ticket: 'x',
      }),
    },
  ])
    assert.throws(() => fixture(overrides).dispatch(), failure);
});

test('request boundaries reject unknown executable objects, invalid history and budgets without trimming or dispatch', async () => {
  let getterCalls = 0;
  const executable = Object.defineProperty({}, 'model', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'fixture';
    },
  });
  const cycle = {};
  cycle.self = cycle;
  for (const input of [
    null,
    [],
    {},
    cycle,
    executable,
    { ...body(), model: 'changed' },
    { ...body(), stream: 'false' },
    { ...body(), messages: [] },
    { ...body(), messages: [{ role: 'user', content: null }] },
    { ...body(), messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'x' }] },
    { ...body(), messages: [{ role: 'user', content: 'x'.repeat(384 * 1024) }] },
  ]) {
    const f = fixture();
    await assert.rejects(f.dispatch()(input, { signal: signal() }), failure);
    assert.equal(f.requests.length, 0);
    assert.equal(f.sockets.length, 0);
  }
  assert.equal(getterCalls, 0);
  const f = fixture({ maxInputTokens: 1 });
  await assert.rejects(f.dispatch()(body(), { signal: signal() }), failure);
  assert.equal(f.sockets.length, 0);
  const exact = body();
  const bytes = Buffer.byteLength(JSON.stringify(exact));
  assert.equal(
    (await fixture({ maxBodyBytes: bytes }).dispatch()(exact, { signal: signal() })).statusCode,
    200
  );
  const small = fixture({ maxBodyBytes: bytes - 1 });
  await assert.rejects(small.dispatch()(exact, { signal: signal() }), failure);
  assert.equal(small.sockets.length, 0);
});

test('cancelled, failed and revoked results never retry or escape with raw errors', async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  const f = fixture();
  await assert.rejects(f.dispatch()(body(), { signal: controller.signal }), failure);
  await assert.rejects(f.dispatch()(body(), { signal: {} }), failure);
  assert.equal(f.sockets.length, 0);
  for (const mode of ['cancel', 'revoke', 'failed', 'encoding', 'type', 'empty']) {
    const active = new globalThis.AbortController();
    const g = fixture(
      {},
      {
        result: (result) => {
          if (mode === 'cancel') active.abort();
          if (mode === 'revoke') g.revoke();
          if (mode === 'failed') result.status = 500;
          if (mode === 'encoding') result.headers['content-encoding'] = 'gzip';
          if (mode === 'type') result.headers['content-type'] = [];
          if (mode === 'empty') result.body_b64 = '';
        },
      }
    );
    await assert.rejects(g.dispatch()(body(), { signal: active.signal }), failure);
    assert.equal(g.requests.length, 1);
    assert.equal(g.sockets.length, 1);
    assert.ok(g.sockets[0].destroyed);
  }
  let connections = 0;
  const failed = fixture({
    connect() {
      connections++;
      throw new Error('private ticket');
    },
  });
  await assert.rejects(failed.dispatch()(body(), { signal: signal() }), failure);
  assert.equal(connections, 1);
});

test('WBIPC JSON and SSE results compose with both production client conversion adapters', async () => {
  for (const kind of ['responses', 'claude']) {
    for (const sse of [false, true]) {
      const f = fixture(
        {},
        {
          result(result) {
            if (sse) {
              result.headers['content-type'] = 'text/event-stream';
              result.body_b64 = Buffer.from(
                'data: ' +
                  JSON.stringify({
                    id: 'chat-stream',
                    choices: [
                      {
                        index: 0,
                        delta: { role: 'assistant', content: 'done' },
                        finish_reason: null,
                      },
                    ],
                  }) +
                  '\n\ndata: ' +
                  JSON.stringify({
                    id: 'chat-stream',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }) +
                  '\n\ndata: [DONE]\n\n'
              ).toString('base64');
            }
          },
        }
      );
      const conversion = createContextRecoveryConversion({
        kind,
        model: 'fixture',
        converters: recoveryConverters(),
      });
      const input =
        kind === 'responses'
          ? { model: 'fixture', input: [{ role: 'user', content: '原文🙂' }] }
          : { model: 'fixture', max_tokens: 50, messages: [{ role: 'user', content: '原文🙂' }] };
      const result = await conversion.createDispatch(f.dispatch())(input, { signal: signal() });
      const decoded = decodeContextRecoveryResponse(kind, result.wire, result.stream);
      assert.match(JSON.stringify(decoded.output), /done/);
      assert.equal(f.requests.length, 1);
    }
  }
});

test('shared recovery runner reads exact evidence through authenticated WBIPC and rebuilds next-turn private history', async (t) => {
  const runtime = createContextRecoverySessions();
  runtime.configure(true);
  t.after(() => runtime.close());
  const first = [{ role: 'user', content: 'fixture request' }];
  const call = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'source-call',
        type: 'function',
        function: { name: 'original_lookup', arguments: '{}' },
      },
    ],
  };
  const scope = { principal: 'fixture-owner', protocol: 'chat', target: 'wbipc-fixture' };
  const root = runtime.begin({ ...scope, history: first });
  assert.equal(
    root.complete(
      [call],
      [
        {
          callId: 'source-call',
          toolName: 'original_lookup',
          arguments: {},
          completed: true,
          output: '',
        },
      ],
      'root-response'
    ).ok,
    true
  );
  const source = '精确原文🙂\nline 2';
  const history = [...first, call, { role: 'tool', tool_call_id: 'source-call', content: source }];
  const session = runtime.begin({ ...scope, history }, [{ callId: 'source-call', output: source }]);
  let round = 0;
  let outgoing;
  const f = fixture(
    {},
    {
      fetch(params) {
        outgoing = JSON.parse(Buffer.from(params.body_b64, 'base64'));
      },
      response() {
        let name;
        let args;
        if (round === 0) {
          name = LIST_EVIDENCE_TOOL;
          args = {};
        } else if (round === 1) {
          const index = JSON.parse(outgoing.messages.at(-1).content);
          name = READ_EVIDENCE_TOOL;
          args = { sourceId: index.sources[0].sourceId, digest: index.sources[0].digest };
        } else {
          assert.equal(JSON.parse(outgoing.messages.at(-1).content).page.text, source);
        }
        round++;
        return {
          ...completion(
            name
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'read-' + round,
                      type: 'function',
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                }
              : undefined
          ),
          id: 'round-' + round,
        };
      },
    }
  );
  const result = await runContextRecovery({
    kind: 'chat',
    body: { ...body(), messages: history },
    session,
    dispatch: f.dispatch(),
  });
  assert.equal(result.ok, true, result.code);
  assert.equal(round, 3);
  assert.equal(result.usage.length, 3);
  const decoded = decodeContextRecoveryResponse(
    'chat',
    Buffer.from(JSON.stringify(result.response)),
    false
  );
  assert.equal(session.complete(decoded.output, decoded.calls, decoded.responseId).ok, true);
  const nextHistory = [...history, ...decoded.output];
  const next = runtime.begin({
    ...scope,
    history: nextHistory,
    previousResponseId: decoded.responseId,
  });
  const mapped = next.recovery({ ...body(), messages: nextHistory });
  assert.equal(mapped.ok, true);
  assert.ok(mapped.initialRequest.messages.length > nextHistory.length);
  assert.ok(
    mapped.initialRequest.messages.some(
      (item) => item.role === 'tool' && item.content.includes('tool_data_not_instructions')
    )
  );
  next.abort();
  assert.equal(f.requests.length, 3);
});

test('long WBIPC owner transaction keeps full originals while private and public sends use independent bounded windows', async (t) => {
  const runtime = createContextRecoverySessions();
  runtime.configure(true);
  t.after(() => runtime.close());
  const { input } = retainedWindow();
  const first = [input.messages[0]];
  const calls = input.messages.filter((message) => message.tool_calls);
  const outputs = input.messages.filter((message) => message.role === 'tool');
  let history = [...first];
  const scope = { principal: 'owner', protocol: 'chat', target: 'synthetic-wbipc' };
  const root = runtime.begin({ ...scope, history: first });
  const observed = (index) => [
    {
      callId: calls[index].tool_calls[0].id,
      toolName: 'lookup',
      arguments: {},
      completed: true,
      output: '',
    },
  ];
  assert.equal(root.complete([calls[0]], observed(0), 'root-long').ok, true);
  let session;
  // Preserve the existing per-turn result bound: three ordinary completed tool
  // turns build the same 2.4 MB aggregate history without one giant result batch.
  for (let index = 0; index < outputs.length; index++) {
    history = [...history, calls[index], outputs[index]];
    if (index === outputs.length - 1) history.push(input.messages.at(-1));
    session = runtime.begin({ ...scope, history }, [
      { callId: outputs[index].tool_call_id, output: outputs[index].content },
    ]);
    assert.equal(session.ok, true, session.code);
    if (index < outputs.length - 1)
      assert.equal(
        session.complete([calls[index + 1]], observed(index + 1), 'root-long-' + index).ok,
        true
      );
  }
  assert.equal(session.ok, true);
  assert.equal(session.historyFormat, 3);
  assert.equal(session.inspect().visibleSources, 3);
  let outgoing,
    round = 0;
  let upstreamAssertion;
  const observe =
    (operation) =>
    (...args) => {
      try {
        return operation(...args);
      } catch (error) {
        upstreamAssertion = error;
        throw error;
      }
    };
  const f = fixture(
    { historyFormat: 3, reference: session.retainedTransportReference },
    {
      fetch: observe((params) => {
        outgoing = JSON.parse(Buffer.from(params.body_b64, 'base64'));
        assert.ok(Buffer.byteLength(JSON.stringify(outgoing)) <= 384 * 1024);
        for (const message of outgoing.messages.filter((value) =>
          outputs.some((source) => value.tool_call_id === source.tool_call_id)
        )) {
          assert.ok(message.content.length < 1000);
          assert.ok(
            round === 3
              ? message.content.startsWith('[Earlier tool output retained;')
              : message.content.includes('retainedToolOutput')
          );
        }
      }),
      response: observe(() => {
        let name, args;
        if (round === 0) {
          name = LIST_EVIDENCE_TOOL;
          args = {};
        } else if (round === 1) {
          const source = JSON.parse(outgoing.messages.at(-1).content).sources[0];
          name = READ_EVIDENCE_TOOL;
          args = {
            sourceId: source.sourceId,
            digest: source.digest,
            offsetBytes: 0,
            limitBytes: 1024,
          };
        } else if (round === 2) {
          assert.equal(JSON.parse(outgoing.messages.at(-1).content).page.text, '0'.repeat(1024));
        } else {
          assert.doesNotMatch(
            JSON.stringify(outgoing.tools ?? []),
            /hpm_(?:read|list)_retained_evidence/
          );
          assert.ok(outgoing.messages.at(-1).content.includes('0'.repeat(1024)));
        }
        round++;
        return {
          ...completion(
            name
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'private-' + round,
                      type: 'function',
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                }
              : undefined
          ),
          id: 'long-' + round,
        };
      }),
    }
  );
  const result = await runContextRecovery({
    kind: 'chat',
    body: { ...body(), messages: history },
    session: { recovery: (value) => session.recovery(value, { publicGeneration: 'isolated' }) },
    dispatch: f.dispatch(),
  });
  if (upstreamAssertion) throw upstreamAssertion;
  assert.equal(result.ok, true, result.code);
  assert.equal(round, 4);
  assert.equal(result.usage.length, 4);
  assert.ok(outputs.every((message) => message.content.length === 800000));
  // Cancel before publication: the previously published root remains a valid
  // anchor, and the original results may be re-admitted without a shortened copy.
  session.abort();
  const retry = runtime.begin({ ...scope, history }, [
    { callId: outputs.at(-1).tool_call_id, output: outputs.at(-1).content },
  ]);
  assert.equal(retry.ok, true);
  const source = JSON.parse(retry.reply(LIST_EVIDENCE_TOOL, {}).text).sources[0];
  assert.equal(
    JSON.parse(
      retry.reply(READ_EVIDENCE_TOOL, {
        sourceId: source.sourceId,
        digest: source.digest,
        limitBytes: 1024,
      }).text
    ).page.text,
    '0'.repeat(1024)
  );
  retry.abort();
});
