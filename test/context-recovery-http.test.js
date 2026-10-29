'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const {
  createContextRecoveryHttpDispatch,
} = require('../lib/proxy/context-recovery-http-dispatch');
const { encodeContextRecoveryClientWire } = require('../lib/proxy/context-recovery-client-wire');
const {
  decodeContextRecoveryEnvelope,
  decodeContextRecoveryResponse,
} = require('../lib/proxy/context-recovery-protocol');
const { MAX_WIRE_BYTES } = require('../lib/proxy/context-api-evidence-protocol');
const { LIST_EVIDENCE_TOOL } = require('../lib/proxy/context-evidence-tools');
const { READ_EVIDENCE_TOOL } = require('../lib/proxy/context-evidence-tools');
const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
const { runContextRecovery } = require('../lib/proxy/context-recovery-runner');

test('actual HTTP sends owner-selected long request history while keeping the original response bound', async (t) => {
  let received = 0;
  let mode = 'normal';
  const history = Array.from({ length: 3 }, () => ({
    role: 'user',
    content: 'x'.repeat(900 * 1024),
  }));
  const body = { model: 'synthetic', messages: history };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      received++;
      assert.equal(Number(request.headers['content-length']), bytes.length);
      assert.equal(JSON.parse(bytes).messages[2].content, history[2].content);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        mode === 'oversized' ? Buffer.alloc(MAX_WIRE_BYTES + 1, 120) : JSON.stringify({ ok: true })
      );
    });
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const options = {
    hostname: '127.0.0.1',
    port: server.address().port,
    path: '/synthetic',
    method: 'POST',
    headers: {},
  };
  const signal = new globalThis.AbortController().signal;
  const legacy = createContextRecoveryHttpDispatch(http, options, () => true);
  await assert.rejects(legacy(body, { signal }), /Recovery HTTP dispatch failed/);
  assert.equal(received, 0);
  const modern = createContextRecoveryHttpDispatch(http, options, () => true, {
    kind: 'chat',
    historyFormat: 3,
  });
  const result = await modern(body, { signal });
  assert.equal(JSON.parse(result.wire).ok, true);
  assert.equal(received, 1);
  mode = 'oversized';
  await assert.rejects(modern(body, { signal }), /Recovery HTTP dispatch failed/);
  assert.equal(received, 2);
  await assert.rejects(
    modern({ messages: history, padding: 'x'.repeat(32 * 1024 * 1024) }, { signal }),
    /Recovery HTTP dispatch failed/
  );
  assert.equal(received, 2);
  assert.throws(() =>
    createContextRecoveryHttpDispatch(http, options, () => true, { historyFormat: 9 })
  );
});

test('Responses client wire preserves custom namespace input and hosted search items without exposing private tools', () => {
  const output = [
    {
      type: 'custom_tool_call',
      id: 'ctc-wire',
      call_id: 'custom-wire',
      name: 'patch',
      namespace: 'native',
      input: 'opaque\nnot JSON',
      status: 'completed',
    },
    {
      type: 'web_search_call',
      id: 'ws-wire',
      status: 'completed',
      action: { type: 'search', queries: ['fixture'] },
    },
  ];
  const response = { id: 'r-native-wire', status: 'completed', output };
  for (const stream of [false, true]) {
    const encoded = encodeContextRecoveryClientWire(
      'responses',
      response,
      [{ input_tokens: 3, output_tokens: 2 }],
      stream
    );
    const decoded = decodeContextRecoveryEnvelope('responses', encoded.wire, stream);
    assert.deepEqual(JSON.parse(JSON.stringify(decoded.output)), output);
    assert.doesNotMatch(
      encoded.wire.toString(),
      /hpm_list_retained_evidence|hpm_read_retained_evidence/
    );
    if (stream) {
      assert.match(encoded.wire.toString(), /response\.custom_tool_call_input\.delta/);
      assert.match(encoded.wire.toString(), /response\.custom_tool_call_input\.done/);
      assert.doesNotMatch(encoded.wire.toString(), /response\.function_call_arguments/);
    }
  }
  for (const type of ['function_call', 'custom_tool_call']) {
    assert.throws(
      () =>
        encodeContextRecoveryClientWire(
          'responses',
          {
            ...response,
            output: [{ ...output[0], type, name: LIST_EVIDENCE_TOOL, arguments: '{}' }],
          },
          [{}],
          true
        ),
      /Unsupported recovery client output/
    );
  }
  for (const stream of [false, true])
    for (const item of [
      { ...output[0], input: {} },
      { ...output[1], status: 'in_progress' },
      { ...output[1], action: { type: 'open_page', url: 'file:///private' } },
    ])
      assert.throws(() =>
        encodeContextRecoveryClientWire('responses', { ...response, output: [item] }, [{}], stream)
      );
});

function fixture(action, authorized = () => true, recoveryOptions = {}) {
  const requests = [];
  const transport = {
    request(options, receive) {
      const request = new EventEmitter();
      request.destroy = () => {
        request.destroyed = true;
      };
      request.end = (wire) =>
        queueMicrotask(() => {
          const incoming = new EventEmitter();
          incoming.headers = { 'content-type': 'application/json' };
          incoming.statusCode = 200;
          incoming.complete = true;
          incoming.destroy = () => {
            incoming.destroyed = true;
          };
          receive(incoming);
          action(incoming, request, wire);
        });
      requests.push({ options, request });
      return request;
    },
  };
  const options = {
    hostname: 'fixture.invalid',
    path: '/v1/responses',
    method: 'POST',
    headers: {
      Authorization: 'fixture-only',
      'Content-Encoding': 'gzip',
      'Content-Length': '999',
      'x-hpm-evidence-token': 'private-fixture',
    },
  };
  return {
    dispatch: createContextRecoveryHttpDispatch(transport, options, authorized, recoveryOptions),
    requests,
    options,
  };
}

test('native HTTP cache misses require the exact bounded Responses contract and never retry', async (t) => {
  const failure = {
    error: {
      type: 'invalid_request_error',
      code: 'previous_response_not_found',
      param: 'previous_response_id',
      message: 'Synthetic private predecessor is unavailable',
    },
  };
  let requests = 0;
  let mode = 'valid';
  const server = http.createServer((request, response) => {
    requests++;
    request.resume();
    request.on('end', () => {
      const body = globalThis.structuredClone(failure);
      if (mode === 'wrong-code') body.error.code = 'synthetic_failure';
      response.writeHead(mode === 'wrong-status' ? 404 : 400, {
        'content-type': mode === 'wrong-type' ? 'text/plain' : 'application/json; charset=utf-8',
        ...(mode === 'compressed' ? { 'content-encoding': 'gzip' } : {}),
      });
      response.end(mode === 'invalid-utf8' ? Buffer.from([0xff]) : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = {
    hostname: '127.0.0.1',
    port: server.address().port,
    path: '/v1/responses',
    method: 'POST',
    headers: {},
  };
  for (mode of [
    'valid',
    'wrong-code',
    'no-previous',
    'wrong-kind',
    'wrong-type',
    'wrong-status',
    'compressed',
    'invalid-utf8',
  ]) {
    const dispatch = createContextRecoveryHttpDispatch(http, options, () => true, {
      kind: mode === 'wrong-kind' ? 'claude' : 'responses',
    });
    const pending = dispatch(mode === 'no-previous' ? {} : { previous_response_id: 'synthetic' }, {
      signal: new globalThis.AbortController().signal,
    });
    if (mode === 'valid') {
      const result = await pending;
      assert.equal(result.statusCode, 400);
      assert.equal(result.stream, false);
      assert.deepEqual(JSON.parse(result.wire), failure);
    } else await assert.rejects(pending, { message: 'Recovery HTTP dispatch failed' }, mode);
  }
  assert.equal(requests, 8, 'one network request per client attempt');
});

test('Responses dispatch waits for a whole terminal SSE block and closes an otherwise open backend', async () => {
  let incoming;
  let settled = false;
  const f = fixture(
    (r) => {
      incoming = r;
      r.complete = false;
      r.headers['content-type'] = 'text/event-stream';
    },
    () => true,
    { kind: 'responses' }
  );
  const promise = f.dispatch({}, { signal: new globalThis.AbortController().signal });
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise(setImmediate);
  incoming.emit('data', Buffer.from('event: response.completed\n\n'));
  incoming.emit(
    'data',
    Buffer.from('data: {"type":"response.output_text.delta","delta":"response.completed"}\n\n')
  );
  incoming.emit(
    'data',
    Buffer.from(
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n'
    )
  );
  await new Promise(setImmediate);
  assert.equal(settled, false, 'event names, text markers and an unterminated block cannot settle');
  incoming.emit('data', Buffer.from('\n'));
  const result = await promise;
  assert.equal(result.stream, true);
  assert.equal(incoming.destroyed, true);
  assert.equal(f.requests[0].request.destroyed, true);
  incoming.emit('error', new Error('late private error'));
  assert.equal(settled, true);
});

test('Responses dispatch rejects malformed, failed and revoked terminal streams without waiting for EOF', async () => {
  for (const mode of ['malformed', 'failed', 'incomplete', 'error', 'revoked']) {
    let allowed = true;
    const f = fixture(
      (r) => {
        r.headers['content-type'] = 'text/event-stream';
        r.complete = false;
        if (mode === 'revoked') allowed = false;
        const value =
          mode === 'malformed'
            ? '{private'
            : JSON.stringify({
                type:
                  mode === 'failed'
                    ? 'response.failed'
                    : mode === 'incomplete'
                      ? 'response.incomplete'
                      : mode === 'error'
                        ? 'error'
                        : 'response.completed',
              });
        r.emit('data', Buffer.from('data: ' + value + '\n\n'));
      },
      () => allowed,
      { kind: 'responses' }
    );
    await assert.rejects(f.dispatch({}, { signal: new globalThis.AbortController().signal }), {
      message: 'Recovery HTTP dispatch failed',
    });
    assert.equal(f.requests[0].request.destroyed, true);
  }
});

test('HTTP dispatch pins route and credentials and sends fresh identity JSON without private headers', async () => {
  const f = fixture((incoming, request, wire) => {
    assert.deepEqual(JSON.parse(wire), { input: '🙂' });
    incoming.emit('data', Buffer.from('{}'));
    incoming.emit('end');
  });
  f.options.hostname = 'changed.invalid';
  f.options.headers.Authorization = 'changed';
  const result = await f.dispatch(
    { input: '🙂' },
    { signal: new globalThis.AbortController().signal }
  );
  assert.equal(result.wire.toString(), '{}');
  assert.equal(result.stream, false);
  const { options } = f.requests[0];
  assert.equal(options.hostname, 'fixture.invalid');
  assert.equal(options.headers.Authorization, 'fixture-only');
  assert.equal(options.headers['Content-Encoding'], undefined);
  assert.equal(options.headers['Content-Length'], undefined);
  assert.equal(options.headers['x-hpm-evidence-token'], undefined);
  assert.equal(options.headers['accept-encoding'], 'identity');
  assert.equal(
    Number(options.headers['content-length']),
    Buffer.byteLength(JSON.stringify({ input: '🙂' }))
  );
});

for (const [name, action] of [
  [
    'truncated close',
    (r) => {
      r.emit('data', Buffer.from('{'));
      r.emit('close');
    },
  ],
  ['aborted', (r) => r.emit('aborted')],
  ['error', (r) => r.emit('error', new Error('private fixture detail'))],
  [
    'incomplete',
    (r) => {
      r.complete = false;
      r.emit('end');
    },
  ],
  ['oversized', (r) => r.emit('data', Buffer.alloc(MAX_WIRE_BYTES + 1))],
  ['invalid chunk', (r) => r.emit('data', 'unexpected string')],
  ['timeout', (r, q) => q.emit('timeout')],
])
  test('HTTP dispatch rejects ' + name + ' with a safe error and destroys request', async () => {
    const f = fixture(action);
    await assert.rejects(f.dispatch({}, { signal: new globalThis.AbortController().signal }), {
      message: 'Recovery HTTP dispatch failed',
    });
    assert.equal(f.requests[0].request.destroyed, true);
  });

test('HTTP dispatch stops when authorization is revoked or throws at completion', async () => {
  for (const throwing of [false, true]) {
    let allowed = true;
    const f = fixture(
      (r) => {
        allowed = false;
        r.emit('end');
      },
      () => {
        if (!allowed && throwing) throw new Error('private authorization detail');
        return allowed;
      }
    );
    await assert.rejects(
      f.dispatch({}, { signal: new globalThis.AbortController().signal }),
      /Recovery HTTP dispatch failed/
    );
  }
});

test('HTTP dispatch refuses cancelled, unauthorized and oversized requests before network access', async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  for (const [body, signal, authorized] of [
    [{}, controller.signal, () => true],
    [{}, new globalThis.AbortController().signal, () => false],
    [{ value: 'x'.repeat(MAX_WIRE_BYTES) }, new globalThis.AbortController().signal, () => true],
  ]) {
    const f = fixture(() => assert.fail('unexpected network'), authorized);
    await assert.rejects(f.dispatch(body, { signal }));
    assert.equal(f.requests.length, 0);
  }
});

test('HTTP dispatch rejects status and compression without unhandled later response errors', async () => {
  for (const mode of ['status', 'encoding']) {
    const f = fixture((r) => r.emit('error', new Error('late private error')));
    // Synchronous callback supplies response metadata before validation.
    const transport = {
      request(options, receive) {
        const q = new EventEmitter();
        q.destroy = () => {};
        q.end = () => {};
        const r = new EventEmitter();
        r.headers = mode === 'encoding' ? { 'content-encoding': 'gzip' } : {};
        r.statusCode = mode === 'status' ? 503 : 200;
        r.destroy = () => {};
        receive(r);
        r.emit('error', new Error('private late error'));
        return q;
      },
    };
    const dispatch = createContextRecoveryHttpDispatch(transport, f.options, () => true);
    await assert.rejects(dispatch({}, { signal: new globalThis.AbortController().signal }));
  }
});

test('HTTP dispatch works against actual local HTTP with chunked SSE', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ');
      res.end('{}\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dispatch = createContextRecoveryHttpDispatch(
    http,
    { hostname: '127.0.0.1', port: server.address().port, path: '/', method: 'POST', headers: {} },
    () => true
  );
  const result = await dispatch({}, { signal: new globalThis.AbortController().signal });
  assert.equal(result.stream, true);
  assert.equal(result.wire.toString(), 'data: {}\n\n');
});

test('HTTP dispatch cancellation destroys an active request and late data cannot revive it', async () => {
  const controller = new globalThis.AbortController();
  const f = fixture((r) => {
    controller.abort();
    r.emit('data', Buffer.from('{}'));
    r.emit('end');
    r.emit('close');
  });
  await assert.rejects(f.dispatch({}, { signal: controller.signal }));
  assert.equal(f.requests[0].request.destroyed, true);
});

test('HTTP dispatch handles missing content type, invalid metadata, network throw and early request close', async () => {
  for (const type of [undefined, ['invalid']]) {
    const f = fixture((r) => {
      r.headers = type === undefined ? {} : { 'content-type': type };
      r.emit('data', Buffer.from('data: {}\n\n'));
      r.emit('end');
    });
    const pending = f.dispatch({}, { signal: new globalThis.AbortController().signal });
    if (type === undefined) assert.equal((await pending).stream, true);
    else await assert.rejects(pending);
  }
  for (const throws of [false, true]) {
    const transport = {
      request() {
        if (throws) throw new Error('private socket detail');
        const q = new EventEmitter();
        q.destroy = () => {};
        q.end = () => q.emit('close');
        return q;
      },
    };
    await assert.rejects(
      createContextRecoveryHttpDispatch(
        transport,
        { headers: {} },
        () => true
      )({}, { signal: new globalThis.AbortController().signal }),
      { message: 'Recovery HTTP dispatch failed' }
    );
  }
  assert.throws(() => createContextRecoveryHttpDispatch({}, { headers: {} }, () => true));
  assert.throws(() => createContextRecoveryHttpDispatch({ request() {} }, { headers: {} }, null));
});

const outputs = {
  chat: {
    id: 'chat-1',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '🙂',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'external_lookup', arguments: '{"key":"value"}' },
            },
          ],
        },
      },
    ],
  },
  responses: {
    id: 'resp-1',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'reason-1', encrypted_content: 'opaque-fixture', summary: [] },
      {
        type: 'message',
        id: 'msg-1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '🙂', annotations: [] }],
      },
      {
        type: 'function_call',
        id: 'fc-1',
        call_id: 'call-1',
        name: 'external_lookup',
        arguments: '{"key":"value"}',
        status: 'completed',
      },
    ],
  },
  claude: {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: 'fixture thought', signature: 'fixture-signature' },
      { type: 'text', text: '🙂' },
      { type: 'tool_use', id: 'call-1', name: 'external_lookup', input: { key: 'value' } },
    ],
  },
};

for (const kind of Object.keys(outputs))
  for (const stream of [false, true])
    test(`${kind} final ${stream ? 'SSE' : 'JSON'} preserves output, external calls and aggregated usage`, () => {
      const source = outputs[kind];
      const before = JSON.stringify(source);
      const encoded = encodeContextRecoveryClientWire(
        kind,
        source,
        [
          { input_tokens: 2, output_tokens: 3 },
          { input_tokens: 4, output_tokens: 5 },
        ],
        stream
      );
      const decoded = decodeContextRecoveryEnvelope(kind, encoded.wire, stream);
      const expected = decodeContextRecoveryResponse(kind, Buffer.from(before), false);
      const actual = decodeContextRecoveryResponse(kind, encoded.wire, stream);
      assert.deepEqual(actual, expected);
      assert.equal(decoded.usage.input_tokens, 6);
      assert.equal(decoded.usage.output_tokens, 8);
      assert.equal(JSON.stringify(source), before);
      if (kind === 'responses' && stream) {
        const events = encoded.wire
          .toString()
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)));
        assert.deepEqual(
          events.map((event) => event.sequence_number),
          events.map((_, index) => index)
        );
        assert.equal(events.at(-1).type, 'response.completed');
      }
    });

test('client wire rejects invalid, empty, oversized, private-call and unsafe usage output', () => {
  for (const stream of [false, true]) {
    for (const input of [null, {}, { ...outputs.responses, output: [] }])
      assert.throws(() => encodeContextRecoveryClientWire('responses', input, [{}], stream));
    const privateCall = {
      ...outputs.responses,
      output: [
        {
          type: 'function_call',
          id: 'fc',
          call_id: 'call',
          name: LIST_EVIDENCE_TOOL,
          arguments: '{}',
        },
      ],
    };
    assert.throws(() => encodeContextRecoveryClientWire('responses', privateCall, [{}], stream));
    for (const usage of [
      [],
      [null],
      [4],
      [[]],
      [{ input_tokens: -1 }],
      [{ input_tokens: 1.5 }],
      [{ input_tokens: Number.MAX_SAFE_INTEGER }, { input_tokens: 1 }],
      [{ details: {} }, { details: 1 }],
    ])
      assert.throws(() =>
        encodeContextRecoveryClientWire('responses', outputs.responses, usage, stream)
      );
    assert.throws(() =>
      encodeContextRecoveryClientWire(
        'chat',
        { ...outputs.chat, padding: 'x'.repeat(MAX_WIRE_BYTES) },
        [{}],
        stream
      )
    );
  }
});

test('actual HTTP runner reads session evidence, releases only external output and rebuilds the next turn', async (t) => {
  const runtime = createContextRecoverySessions();
  runtime.configure(true);
  t.after(() => runtime.close());
  const first = [{ role: 'user', content: 'fixture request' }];
  const originalCall = {
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
  const scope = { principal: 'fixture-owner', protocol: 'chat', target: 'fixture-target' };
  const root = runtime.begin({ ...scope, history: first });
  assert.equal(
    root.complete(
      [originalCall],
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
  const history = [
    ...first,
    originalCall,
    { role: 'tool', tool_call_id: 'source-call', content: source },
  ];
  const session = runtime.begin({ ...scope, history }, [{ callId: 'source-call', output: source }]);
  assert.equal(session.ok, true);
  let round = 0;
  let serverError;
  const received = [];
  function completion(id, name, args) {
    return {
      id,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: id + '-call',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    };
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks));
        received.push(body);
        let output;
        if (round === 0) {
          assert.ok(body.tools.some((tool) => tool.function?.name === LIST_EVIDENCE_TOOL));
          output = completion('list-response', LIST_EVIDENCE_TOOL, {});
        } else if (round === 1) {
          const index = JSON.parse(body.messages.at(-1).content);
          assert.equal(index.sources.length, 1);
          output = completion('read-response', READ_EVIDENCE_TOOL, {
            sourceId: index.sources[0].sourceId,
            digest: index.sources[0].digest,
          });
        } else {
          assert.equal(JSON.parse(body.messages.at(-1).content).page.text, source);
          output = completion('final-response', 'external_lookup', { key: 'value' });
        }
        round++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(output));
      } catch (error) {
        serverError = error;
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dispatch = createContextRecoveryHttpDispatch(
    http,
    { hostname: '127.0.0.1', port: server.address().port, path: '/', method: 'POST', headers: {} },
    () => true
  );
  const tools = [
    {
      type: 'function',
      function: { name: 'external_lookup', parameters: { type: 'object', properties: {} } },
    },
  ];
  const result = await runContextRecovery({
    kind: 'chat',
    body: { model: 'fixture', messages: history, tools },
    session,
    dispatch,
  });
  if (serverError) throw serverError;
  assert.equal(result.ok, true, result.code);
  assert.equal(round, 3);
  const final = encodeContextRecoveryClientWire('chat', result.response, result.usage, true);
  assert.equal(final.response.usage.total_tokens, 9);
  assert.doesNotMatch(
    final.wire.toString(),
    new RegExp(LIST_EVIDENCE_TOOL + '|' + READ_EVIDENCE_TOOL)
  );
  assert.doesNotMatch(final.wire.toString(), /精确原文/);
  const decoded = decodeContextRecoveryResponse('chat', final.wire, true);
  assert.equal(session.complete(decoded.output, decoded.calls, decoded.responseId).ok, true);
  const nextHistory = [...history, ...decoded.output];
  const next = runtime.begin({
    ...scope,
    history: nextHistory,
    previousResponseId: decoded.responseId,
  });
  const mapped = next.recovery({ model: 'fixture', messages: nextHistory, tools });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.initialRequest.messages.length > nextHistory.length, true);
  assert.ok(
    mapped.initialRequest.messages.some(
      (message) => message.role === 'tool' && message.content.includes('tool_data_not_instructions')
    )
  );
  assert.equal(received.length, 3);
  next.abort();
});
