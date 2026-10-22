'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { gzipSync } = require('node:zlib');
const {
  beginContextRecoveryRequest,
  beginContextRecoveryRequestAsync,
  decodeContextRecoveryResponse,
} = require('../lib/proxy/context-recovery-protocol');
const { installContextRecoveryObserver } = require('../lib/proxy/context-recovery-observer');
const { MAX_WIRE_BYTES } = require('../lib/proxy/context-api-evidence-protocol');
const { normalizeRecoveryRequestBody } = require('../lib/proxy/context-recovery-request-data');
const {
  fingerprintContextData,
  fingerprintRecoveryHistory,
} = require('../lib/proxy/context-recovery-fingerprint');

test('versioned request bodies bound aggregate history, each item and metadata without executing hooks', () => {
  for (const kind of ['chat', 'responses', 'claude', 'gemini']) {
    const key = kind === 'responses' ? 'input' : kind === 'gemini' ? 'contents' : 'messages';
    const history = Array.from({ length: 3 }, () => ({
      role: 'user',
      content: 'x'.repeat(900 * 1024),
    }));
    const body = { [key]: history, model: 'synthetic' };
    assert.throws(() => normalizeRecoveryRequestBody(kind, body));
    const copy = normalizeRecoveryRequestBody(kind, body, 3);
    assert.equal(copy[key][2].content, history[2].content);
    assert.notEqual(copy[key], history);
    assert.notEqual(copy[key][0], history[0]);
    assert.throws(() =>
      normalizeRecoveryRequestBody(kind, { ...body, model: 'x'.repeat(MAX_WIRE_BYTES) }, 3)
    );
    assert.throws(() =>
      normalizeRecoveryRequestBody(
        kind,
        { [key]: [{ role: 'user', content: 'x'.repeat(MAX_WIRE_BYTES) }] },
        3
      )
    );
    for (const value of [
      null,
      [],
      { [key]: [null] },
      { [key]: new Array(1) },
      { [key]: [], extra: undefined },
    ])
      assert.throws(() => normalizeRecoveryRequestBody(kind, value, 3));
    assert.equal(normalizeRecoveryRequestBody(kind, { [key]: [] }, 3)[key].length, 0);
  }
  let ran = 0;
  const hostile = [
    {
      get messages() {
        ran++;
        return [];
      },
    },
    {
      messages: [],
      toJSON() {
        ran++;
        return {};
      },
    },
    Object.assign(Object.create({ inherited: true }), { messages: [] }),
    { messages: [], [Symbol('private')]: true },
  ];
  const cycle = { messages: [] };
  cycle.messages.push(cycle);
  hostile.push(cycle);
  for (const value of hostile) assert.throws(() => normalizeRecoveryRequestBody('chat', value, 3));
  assert.equal(ran, 0);
  assert.throws(() => normalizeRecoveryRequestBody('chat', { messages: [] }, 9));
  assert.throws(() => normalizeRecoveryRequestBody('unknown', { messages: [] }, 3));
  const small = [{ role: 'user', content: 'Unicode🙂\u0000' }];
  assert.equal(fingerprintRecoveryHistory(small, 3), fingerprintContextData(small));
  const exact = {
    messages: Array.from({ length: 16 }, () => ({
      role: 'user',
      content: 'x'.repeat(MAX_WIRE_BYTES - 512),
    })),
    padding: '',
  };
  exact.padding = 'x'.repeat(32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 32 * 1024 * 1024);
  assert.equal(normalizeRecoveryRequestBody('chat', exact, 3).messages.length, 16);
  assert.throws(() =>
    normalizeRecoveryRequestBody('chat', { ...exact, padding: exact.padding + 'x' }, 3)
  );
});

test('native protocol admission accepts aggregate long history and bounded compressed expansion', () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const key = kind === 'responses' ? 'input' : 'messages';
    const history = Array.from({ length: 3 }, () => ({
      role: 'user',
      content: 'x'.repeat(900 * 1024),
    }));
    const body = { model: 'synthetic', [key]: history };
    const bytes = Buffer.from(JSON.stringify(body));
    for (const compressed of [false, true]) {
      let observed = 0;
      const runtime = {
        begin(request) {
          observed++;
          assert.equal(request.history.length, 3);
          assert.equal(request.history[2].content, history[2].content);
          return { ok: true };
        },
      };
      assert.equal(
        beginContextRecoveryRequest(runtime, {
          auth,
          kind,
          prepared,
          buffer: compressed ? gzipSync(bytes) : bytes,
          encoding: compressed ? 'gzip' : 'identity',
        }).ok,
        true
      );
      assert.equal(observed, 1);
    }
  }
  const bomb = Buffer.from(
    JSON.stringify({
      input: Array.from({ length: 34 }, () => ({ role: 'user', content: 'x'.repeat(1024 * 1024) })),
    })
  );
  let ran = 0;
  const result = beginContextRecoveryRequest(
    {
      begin() {
        ran++;
      },
    },
    { auth, kind: 'responses', prepared, buffer: gzipSync(bomb), encoding: 'gzip' }
  );
  assert.equal(result.ok, false);
  assert.equal(ran, 0);
});

test('long native Codex summary admission preserves its separate compaction classification', () => {
  const input = Array.from({ length: 3 }, () => ({
    role: 'user',
    content: 'x'.repeat(900 * 1024),
  }));
  input.push({
    role: 'user',
    content: [
      { type: 'input_text', text: 'CONTEXT CHECKPOINT COMPACTION create a handoff summary' },
    ],
  });
  let compactions = 0;
  const result = beginContextRecoveryRequest(
    {
      begin() {
        throw new Error('ordinary admission must not run');
      },
      beginCompaction(request) {
        compactions++;
        assert.equal(request.history.length, 4);
        return { ok: true };
      },
    },
    {
      auth,
      kind: 'responses',
      prepared,
      buffer: Buffer.from(JSON.stringify({ input, tools: [], tool_choice: 'auto' })),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(compactions, 1);
});
const auth = { ok: true, enabled: true, key: { id: 'owner-a' } };
const prepared = {
  profile: { id: 'profile-a', protocol: 'openai', targetUrl: 'https://fixture.invalid/v1' },
  rewriteTo: '-',
  authMode: 'api-key',
};
const event = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
const call = {
  type: 'function_call',
  id: 'fc-1',
  call_id: 'call-1',
  name: 'lookup',
  arguments: '{}',
};
const responses = { id: 'response-1', status: 'completed', output: [call] };
const chat = {
  id: 'chat-1',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
    },
  ],
};
const claude = {
  id: 'message-1',
  role: 'assistant',
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'look up' },
    { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
  ],
};
const wire = (value) => Buffer.from(JSON.stringify(value));

test('Responses explicit null continuation admits full history without inventing an ancestor', async () => {
  for (const asynchronous of [false, true]) {
    for (const previous of [undefined, null, 'response-ancestor']) {
      const seen = [];
      const runtime = {
        begin(request) {
          seen.push(request);
          return { ok: true };
        },
        async beginAsync(request) {
          seen.push(request);
          return { ok: true };
        },
      };
      const body = {
        model: 'model',
        input: [{ role: 'user', content: 'reconnected full window' }],
        ...(previous === undefined ? {} : { previous_response_id: previous }),
      };
      const options = { auth, kind: 'responses', prepared, buffer: wire(body) };
      const result = asynchronous
        ? await beginContextRecoveryRequestAsync(runtime, options, () => true)
        : beginContextRecoveryRequest(runtime, options);
      assert.equal(result.ok, true);
      assert.equal(seen.length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(seen[0].history)), body.input);
      assert.equal(Object.hasOwn(seen[0], 'previousResponseId'), typeof previous === 'string');
      assert.equal(seen[0].previousResponseId, previous ?? undefined);
      assert.equal(JSON.parse(options.buffer.toString()).previous_response_id, previous);
    }
  }
});

test('async protocol admission preserves authenticated parsing and passes authorization only to its private owner', async () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const authorization = () => true;
    const seen = [];
    const runtime = {
      async beginAsync(...args) {
        seen.push(args);
        return { ok: true };
      },
    };
    const message = { role: 'user', content: 'synthetic' };
    const body = {
      model: 'model',
      ...(kind === 'responses' ? { input: [message] } : { messages: [message] }),
    };
    const options = { auth, kind, prepared, buffer: gzipSync(wire(body)), encoding: 'gzip' };
    assert.equal(
      (await beginContextRecoveryRequestAsync(runtime, options, authorization)).ok,
      true
    );
    assert.equal(seen.length, 1);
    assert.match(seen[0][0].principal, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(JSON.stringify(seen[0][0].history)), [message]);
    assert.equal(Object.getPrototypeOf(seen[0][0].history[0]), null);
    assert.equal(seen[0][2], authorization);
    assert.equal(seen[0][3], false);
    if (kind === 'responses') {
      assert.equal(
        (
          await beginContextRecoveryRequestAsync(
            runtime,
            { ...options, compaction: true },
            authorization
          )
        ).ok,
        true
      );
      assert.equal(seen[1][3], true);
    }
  }
  let ran = 0;
  const options = {
    auth,
    kind: 'responses',
    prepared,
    buffer: wire({ model: 'model', input: [] }),
  };
  const reply = await beginContextRecoveryRequestAsync(
    {
      get beginAsync() {
        ran++;
        return () => {};
      },
    },
    options,
    () => true
  );
  assert.equal(reply.ok, false);
  assert.equal(ran, 0);
  assert.equal(
    (
      await beginContextRecoveryRequestAsync(
        {
          beginAsync() {
            return {
              get then() {
                ran++;
                return () => {};
              },
            };
          },
        },
        options,
        () => true
      )
    ).ok,
    false
  );
  assert.equal(ran, 0);
  assert.equal(
    (
      await beginContextRecoveryRequestAsync(
        {
          beginAsync() {
            throw new Error('private');
          },
        },
        options,
        () => true
      )
    ).code,
    'context_recovery_request_unsupported'
  );
});

test('request boundary derives identity from authenticated principal and target, not caller selectors', () => {
  const seen = [];
  const runtime = {
    begin(input, results) {
      seen.push({ input, results });
      return { ok: true };
    },
  };
  for (const kind of ['chat', 'responses', 'claude']) {
    const message = { role: 'user', content: 'fresh🙂' };
    const body = {
      model: 'model-a',
      ...(kind === 'responses' ? { input: [message] } : { messages: [message] }),
      tools: [],
    };
    assert.equal(
      beginContextRecoveryRequest(runtime, {
        auth,
        kind,
        prepared,
        buffer: gzipSync(wire(body)),
        encoding: 'gzip',
      }).ok,
      true
    );
    const parsed = seen.at(-1);
    assert.match(parsed.input.principal, /^[a-f0-9]{64}$/);
    assert.match(parsed.input.target, /^[a-f0-9]{64}$/);
    assert.equal(parsed.input.protocol, kind);
    assert.deepEqual(parsed.results, []);
    assert.equal(JSON.stringify(parsed.input).includes('fixture.invalid'), false);
  }
  const original = seen[0].input.target;
  beginContextRecoveryRequest(runtime, {
    auth,
    kind: 'chat',
    prepared: { ...prepared, rewriteTo: 'model-b' },
    buffer: wire({ model: 'model-a', messages: [] }),
  });
  assert.notEqual(seen.at(-1).input.target, original);
  assert.equal(
    beginContextRecoveryRequest(runtime, {
      auth: { ok: true, enabled: false },
      kind: 'chat',
      prepared,
      buffer: wire({ messages: [] }),
    }).code,
    'context_recovery_identity_unavailable'
  );
});

test('request parser refuses corrupt UTF-8, decompression, unknown protocols and malformed histories', () => {
  const runtime = {
    begin() {
      throw new Error('must not reach');
    },
  };
  for (const extra of [
    { buffer: Buffer.from([255]) },
    { buffer: Buffer.from('invalid') },
    { kind: 'unknown' },
    { encoding: 'unknown' },
    { encoding: 'gzip' },
    { buffer: wire({ messages: [null] }) },
    { buffer: wire({ messages: {} }) },
    { buffer: Buffer.alloc(MAX_WIRE_BYTES + 1) },
  ]) {
    const result = beginContextRecoveryRequest(runtime, {
      auth,
      kind: 'chat',
      prepared,
      buffer: wire({ messages: [] }),
      ...extra,
    });
    assert.equal(result.code, 'context_recovery_request_unsupported');
  }
  const result = beginContextRecoveryRequest(runtime, {
    auth,
    kind: 'chat',
    prepared,
    buffer: gzipSync(wire({ messages: [{ role: 'user', content: 'a'.repeat(MAX_WIRE_BYTES) }] })),
    encoding: 'gzip',
  });
  assert.equal(result.ok, false);
});

test('three JSON protocols preserve output and extract only observed completed tool calls', () => {
  for (const [kind, body] of [
    ['chat', chat],
    ['responses', responses],
    ['claude', claude],
  ]) {
    const bytes = wire(body),
      before = bytes.toString();
    const decoded = decodeContextRecoveryResponse(kind, bytes, false);
    assert.equal(decoded.calls.length, 1);
    assert.equal(decoded.calls[0].callId, 'call-1');
    assert.equal(decoded.responseId, body.id);
    assert.equal(bytes.toString(), before);
    assert.equal(decoded.output.length, 1);
  }
});

function claudeStream() {
  return [
    { type: 'message_start', message: { role: 'assistant', id: 'message-1' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look up' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

test('JSON and complete SSE bind the same whole output windows in all three protocols', () => {
  const streams = {
    chat: event({ ...chat, object: 'chat.completion' }),
    responses: event({ type: 'response.completed', response: responses }),
    claude: claudeStream().map(event).join(''),
  };
  for (const [kind, body] of [
    ['chat', chat],
    ['responses', responses],
    ['claude', claude],
  ]) {
    assert.deepEqual(
      decodeContextRecoveryResponse(kind, Buffer.from(streams[kind]), true),
      decodeContextRecoveryResponse(kind, wire(body), false)
    );
  }
});

test('Claude SSE retains message metadata through decoding and public re-encoding', () => {
  const { decodeContextRecoveryEnvelope } = require('../lib/proxy/context-recovery-protocol');
  const { encodeContextRecoveryClientWire } = require('../lib/proxy/context-recovery-client-wire');
  for (const sequence of [null, '', 'STOP']) {
    const events = claudeStream();
    Object.assign(events[0].message, {
      type: 'message',
      model: 'native-model',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    });
    Object.assign(events.at(-2).delta, { stop_sequence: sequence });
    events.at(-2).usage = { output_tokens: 2 };
    const decoded = decodeContextRecoveryEnvelope(
      'claude',
      Buffer.from(events.map(event).join('')),
      true
    );
    assert.equal(decoded.type, 'message');
    assert.equal(decoded.model, 'native-model');
    assert.equal(decoded.stop_sequence, sequence);
    const encoded = encodeContextRecoveryClientWire('claude', decoded, [decoded.usage], true);
    assert.deepEqual(decodeContextRecoveryEnvelope('claude', encoded.wire, true), decoded);
  }
  for (const patch of [
    { type: null },
    { type: 'other' },
    { model: '' },
    { model: {} },
    { model: 'x'.repeat(1025) },
    { stop_sequence: [] },
  ]) {
    const events = claudeStream();
    Object.assign(events[0].message, patch);
    assert.throws(() =>
      decodeContextRecoveryEnvelope('claude', Buffer.from(events.map(event).join('')), true)
    );
  }
  const invalid = claudeStream();
  invalid.at(-2).delta.stop_sequence = {};
  assert.throws(() =>
    decodeContextRecoveryEnvelope('claude', Buffer.from(invalid.map(event).join('')), true)
  );
});

test('Claude thinking and signature blocks remain intact in observation only', () => {
  const events = [
    { type: 'message_start', message: { role: 'assistant' } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'opaque-thinking' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'opaque-signature' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'redacted_thinking', data: 'opaque-data' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  const decoded = decodeContextRecoveryResponse(
    'claude',
    Buffer.from(events.map(event).join('')),
    true
  );
  assert.deepEqual(
    decoded.output[0].content.map((b) => ({ ...b })),
    [
      { type: 'thinking', thinking: 'opaque-thinking', signature: 'opaque-signature' },
      { type: 'redacted_thinking', data: 'opaque-data' },
    ]
  );
  assert.equal(decoded.calls.length, 0);
});

test('truncated, failed, excessive and unknown output cannot publish a completed history', () => {
  for (const [kind, body] of [
    ['chat', { ...chat, choices: [{ ...chat.choices[0], finish_reason: 'length' }] }],
    ['responses', { ...responses, status: 'failed' }],
    ['claude', { ...claude, stop_reason: 'max_tokens' }],
    ['unknown', {}],
    ['chat', null],
  ])
    assert.throws(() => decodeContextRecoveryResponse(kind, wire(body), false));
  assert.throws(() => decodeContextRecoveryResponse('responses', Buffer.from([255]), false));
  assert.throws(() =>
    decodeContextRecoveryResponse('responses', Buffer.alloc(MAX_WIRE_BYTES + 1), false)
  );
  assert.throws(() =>
    decodeContextRecoveryResponse(
      'claude',
      Buffer.from(claudeStream().slice(0, -1).map(event).join('')),
      true
    )
  );
  const bad = claudeStream();
  bad[2] = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{}' },
  };
  assert.throws(() =>
    decodeContextRecoveryResponse('claude', Buffer.from(bad.map(event).join('')), true)
  );
});

function response(statusCode = 200, type = 'application/json') {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.sent = [];
  res.getHeader = (name) => (name === 'content-type' ? type : undefined);
  res.write = function (chunk) {
    this.sent.push(chunk);
    return false;
  };
  res.end = function (chunk) {
    if (chunk != null) this.sent.push(chunk);
    this.emit('finish');
    return this;
  };
  return res;
}
function capability() {
  const calls = [];
  let aborted = 0;
  return {
    calls,
    get aborted() {
      return aborted;
    },
    complete(...args) {
      calls.push(args);
      return { ok: true };
    },
    abort() {
      aborted++;
    },
  };
}

test('observer preserves bytes and backpressure while committing decoded output exactly once', () => {
  const res = response();
  const session = capability();
  const originalWrite = res.write;
  const originalEnd = res.end;
  installContextRecoveryObserver(res, 'responses', session);
  const bytes = wire(responses);
  assert.equal(res.write(bytes.subarray(0, 5)), false);
  res.end(new Uint8Array(bytes.subarray(5)));
  assert.equal(Buffer.concat(res.sent.map((b) => Buffer.from(b))).equals(bytes), true);
  assert.equal(session.calls.length, 1);
  assert.equal(session.aborted, 0);
  assert.equal(res.write, originalWrite);
  assert.equal(res.end, originalEnd);
  res.emit('close');
  assert.equal(session.aborted, 0);
});

test('observer safely aborts failure, overflow, cancellation, content encoding and invalid bodies', () => {
  for (const scenario of [
    'failed',
    'overflow',
    'cancel',
    'encoding',
    'invalid',
    'missing',
    'reject',
  ]) {
    const res = response(scenario === 'failed' ? 500 : 200);
    const session = capability();
    if (scenario === 'reject') session.complete = () => ({ ok: false });
    if (scenario === 'encoding')
      res.getHeader = (name) => (name === 'content-encoding' ? 'gzip' : 'application/json');
    installContextRecoveryObserver(res, 'responses', session);
    if (scenario === 'cancel') {
      res.emit('close');
      res.emit('close');
    } else
      res.end(
        scenario === 'overflow'
          ? Buffer.alloc(MAX_WIRE_BYTES + 1)
          : scenario === 'invalid'
            ? 'invalid'
            : scenario === 'missing'
              ? undefined
              : wire(responses)
      );
    assert.equal(session.aborted, 1, scenario);
    assert.equal(res.listenerCount('finish'), 0);
  }
});

test('observer transfers ownership before publication without aborting or double committing the session', () => {
  const res = response();
  const session = capability();
  const originalWrite = res.write;
  const originalEnd = res.end;
  const observer = installContextRecoveryObserver(res, 'responses', session);
  assert.equal(observer.detach(), true);
  assert.equal(observer.detach(), false);
  observer.close();
  res.end(wire(responses));
  res.emit('close');
  assert.equal(res.write, originalWrite);
  assert.equal(res.end, originalEnd);
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(session.calls.length, 0);
  assert.equal(session.aborted, 0);
  const started = response();
  const observed = capability();
  const active = installContextRecoveryObserver(started, 'responses', observed);
  started.write(wire(responses));
  assert.equal(active.detach(), false);
  active.close();
  assert.equal(observed.aborted, 1);
  assert.equal(active.detach(), false);
});
