'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setImmediate: flush } = require('node:timers/promises');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocket, WebSocketServer } = require('ws');
const { createWebSocketProxy } = require('../lib/proxy/websocket-proxy');
const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
const { attachContextRecoveryStorage } = require('../lib/proxy/context-recovery-sessions');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const {
  createRecoveryCacheMissBoundary,
  isRecoveryHttpCacheMiss,
  recoveryCacheMissBody,
  recoveryCacheMissEvent,
} = require('../lib/proxy/context-recovery-cache-miss');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const {
  parseRecoveryWebSocketMessage,
  recoveryWebSocketStreamError,
  recoveryWebSocketBody,
} = require('../lib/proxy/context-recovery-websocket-wire');
const {
  createRecoveryWebSocketConnection,
} = require('../lib/proxy/context-recovery-websocket-connection');
const {
  createRecoveryWebSocketDispatch,
} = require('../lib/proxy/context-recovery-websocket-dispatch');
const {
  createRecoveryWebSocketContinuations,
} = require('../lib/proxy/context-recovery-websocket-continuation');
const {
  createRecoveryWebSocketWarmups,
} = require('../lib/proxy/context-recovery-websocket-warmup');
const {
  MAX_HANDSHAKE_BODY_BYTES,
  recoveryHandshakeHeaders,
  recoveryHandshakeRejection,
} = require('../lib/proxy/context-recovery-websocket-handshake');

const wire = (value) => Buffer.from(JSON.stringify(value));
const response = (id, output) => ({
  id,
  object: 'response',
  status: 'completed',
  output,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const message = (id) => ({
  type: 'message',
  id: 'msg_' + id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: id, annotations: [] }],
});
const call = (id, name, args = {}) => ({
  type: 'function_call',
  id: 'fc_' + id,
  call_id: id,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
});
const create = (stream, input, previous) => ({
  type: 'response.create',
  model: 'synthetic-model',
  store: false,
  input,
  tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
  ...(stream === undefined ? {} : { stream_id: stream }),
  ...(previous ? { previous_response_id: previous } : {}),
});

test('WS ancestry projection never attaches a public generation to an empty private response', async () => {
  const requests = [];
  const dispatch = createRecoveryWebSocketDispatch(async (body) => {
    requests.push(body);
    return { statusCode: 200, stream: false, wire: wire(response('private-empty', [])) };
  });
  const input = [{ role: 'user', content: 'synthetic task' }];
  const privateBody = {
    ...create('main', input, 'public-ancestor'),
    tools: [{ type: 'function', name: LIST }],
  };
  await dispatch(privateBody, {});
  await dispatch(
    create(
      'main',
      [...input, { role: 'user', content: 'authorized supporting page' }],
      'public-ancestor'
    ),
    {}
  );
  assert.equal(requests[1].previous_response_id, 'public-ancestor');
  assert.equal(requests[1].input.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1].tools)), create('main', []).tools);
});

test('WS trusted long-history dispatch preserves exact ancestry and legacy admission', async () => {
  const history = Array.from({ length: 3 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: String(index) + '原文🙂'.repeat(90000),
  }));
  const body = { model: 'model', input: history };
  let legacyCalls = 0;
  await assert.rejects(
    createRecoveryWebSocketDispatch(async () => {
      legacyCalls++;
    })(body, {})
  );
  assert.equal(legacyCalls, 0);
  const requests = [];
  const hidden = call('long-hidden', LIST);
  const dispatch = createRecoveryWebSocketDispatch(
    async (request) => {
      requests.push(request);
      return {
        statusCode: 200,
        stream: false,
        wire: wire(response('long-' + requests.length, [hidden])),
      };
    },
    [],
    3
  );
  await dispatch(body, {});
  assert.deepEqual(
    requests[0].input.map((item) => item.content),
    history.map((item) => item.content)
  );
  const result = { type: 'function_call_output', call_id: 'long-hidden', output: 'exact-page' };
  await dispatch({ ...body, input: [...history, hidden, result] }, {});
  assert.equal(requests[1].previous_response_id, 'long-1');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1].input)), [result]);
});

test('WS long ingress bounds exact aggregate bytes, each item, metadata and upstream responses independently', () => {
  const exact = create(
    undefined,
    Array.from({ length: 16 }, () => ({ role: 'user', content: 'x'.repeat(2 * 1024 * 1024 - 512) }))
  );
  exact.padding = '';
  exact.padding = 'x'.repeat(32 * 1024 * 1024 - wire(exact).length);
  assert.equal(wire(exact).length, 32 * 1024 * 1024);
  assert.equal(parseRecoveryWebSocketMessage(wire(exact), 3).input.length, 16);
  for (const invalid of [
    { ...exact, padding: exact.padding + 'x' },
    create(undefined, [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }]),
    { ...create(undefined, []), instructions: 'x'.repeat(2 * 1024 * 1024) },
    { type: 'response.completed', response: { text: 'x'.repeat(2 * 1024 * 1024) } },
  ])
    assert.throws(() => parseRecoveryWebSocketMessage(wire(invalid), 3));
  assert.throws(() => parseRecoveryWebSocketMessage(wire(exact)));
  assert.throws(() => parseRecoveryWebSocketMessage(wire(exact), 9));
});

test('WS long ingress staging cannot bypass unavailable or legacy binding and has a connection byte ceiling', async (t) => {
  const input = wire(
    create(
      undefined,
      Array.from({ length: 3 }, () => ({ role: 'user', content: 'x'.repeat(900000) }))
    )
  );
  for (const reply of [
    { ok: false, code: 'context_recovery_request_unsupported' },
    { ok: true, historyFormat: 2, abort() {} },
  ]) {
    const runtime = createContextRecoverySessions();
    runtime.beginAsync = async () => reply;
    const f = connectionFixture(t, { runtime });
    f.connection.client(input);
    for (let index = 0; index < 10 && !f.closes(); index++) await flush();
    assert.equal(f.requests.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.closes(), 1);
  }
  const queued = connectionFixture(t);
  for (let index = 0; index < 13; index++) queued.connection.client(input);
  await flush();
  assert.equal(queued.closes(), 1);
  assert.equal(queued.connection.inspect().queuedBytes, 0);
  assert.equal(queued.requests.length, 0);
});

test(
  'actual compressed WS admits long history after warmup and keeps exact recovery private',
  { timeout: 15000 },
  async (t) => {
    const history = Array.from({ length: 3 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: String(index) + '原文🙂'.repeat(90000),
    }));
    let rounds = 0,
      sawExact = false;
    t.after(() => t.diagnostic('long-history completed upstream rounds: ' + rounds));
    const f = await fixture(t, (event, socket) => {
      if (event.generate === false) {
        socket.send(
          JSON.stringify({ type: 'response.completed', response: response('long-warmup', []) })
        );
        return;
      }
      rounds++;
      let output;
      if (rounds === 1) {
        assert.deepEqual(event.input, history);
        output = [call('long-external', 'lookup')];
      } else if (rounds === 2) output = [call('long-list', LIST)];
      else if (rounds === 3) {
        const index = JSON.parse(event.input.at(-1).output);
        const source = index.sources[0];
        output = [call('long-read', READ, { sourceId: source.sourceId, digest: source.digest })];
      } else if (rounds === 4) {
        const page = JSON.parse(event.input.at(-1).output);
        assert.equal(page.page.text, 'exact long original🙂');
        sawExact = true;
        output = [message('private-draft')];
      } else {
        assert.equal(rounds, 5);
        assert.equal(event.previous_response_id, 'long-live-1');
        assert.deepEqual(event.tools, create(undefined, []).tools);
        assert.ok(event.input.at(-1).content.includes('exact long original🙂'));
        assert.doesNotMatch(JSON.stringify(event.input), /long-list|long-read|private-draft/);
        output = [message('long-done')];
      }
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: response('long-live-' + rounds, output),
        })
      );
    });
    let next = f.next();
    f.client.send(JSON.stringify({ ...create(undefined, []), generate: false }));
    assert.equal((await next).response.id, 'long-warmup');
    next = f.next();
    const bytes = wire(create(undefined, history, 'long-warmup'));
    assert.ok(bytes.length > 2 * 1024 * 1024);
    f.client.send(bytes.subarray(0, bytes.length / 2), { binary: false, fin: false });
    f.client.send(bytes.subarray(bytes.length / 2), { binary: false, fin: true });
    assert.equal((await next).response.id, 'long-live-1');
    next = f.next();
    f.client.send(
      wire(
        create(
          undefined,
          [
            {
              type: 'function_call_output',
              call_id: 'long-external',
              output: 'exact long original🙂',
            },
          ],
          'long-live-1'
        )
      ),
      { binary: false }
    );
    assert.equal((await next).response.id, 'long-live-5');
    assert.equal(sawExact, true);
    assert.equal(rounds, 5);
    assert.equal(
      f.events.some(
        (event) => JSON.stringify(event).includes(LIST) || JSON.stringify(event).includes(READ)
      ),
      false
    );
  }
);

test('empty WS warmup admission is single-use, lane/policy/connection-bound and expires without extending any root', () => {
  let time = 1000;
  const warmup = { ...create('main', []), generate: false };
  const completed = response('warmup-receipt', []);
  const generation = { ...create('main', [{ role: 'user', content: 'fixture' }], completed.id) };
  const cache = createRecoveryWebSocketWarmups({ now: () => time });
  cache.remember(warmup, completed, 'main');
  for (const [body, lane] of [
    [generation, 'other'],
    [generation, undefined],
    [{ ...generation, model: 'other-model' }, 'main'],
    [{ ...generation, instructions: 'other-policy' }, 'main'],
    [{ ...generation, tools: [] }, 'main'],
    [{ ...generation, tool_choice: 'none' }, 'main'],
    [{ ...generation, input: [] }, 'main'],
    [{ ...generation, generate: false }, 'main'],
    [{ ...generation, previous_response_id: 'unobserved' }, 'main'],
  ])
    assert.equal(cache.admission(body, lane), body);
  const admitted = cache.admission(generation, 'main');
  assert.equal(Object.hasOwn(admitted, 'previous_response_id'), false);
  assert.equal(generation.previous_response_id, completed.id);
  assert.equal(cache.admission(generation, 'main'), generation);
  const other = createRecoveryWebSocketWarmups({ now: () => time });
  assert.equal(other.admission(generation, 'main'), generation);
  for (const [body, result] of [
    [{ ...warmup, input: [{ role: 'user', content: 'hidden-prefill' }] }, completed],
    [{ ...warmup, previous_response_id: 'ancestor' }, completed],
    [warmup, { ...completed, output: [message('not-empty')] }],
    [warmup, { ...completed, status: 'incomplete' }],
    [warmup, { ...completed, id: '' }],
  ]) {
    other.remember(body, result, 'main');
    assert.equal(other.admission(generation, 'main'), generation);
  }
  cache.remember(warmup, completed, 'main');
  time += 60000;
  assert.equal(cache.admission(generation, 'main'), generation);
  cache.remember(warmup, completed, 'main');
  time--;
  assert.equal(cache.admission(generation, 'main'), generation);
  time += 2;
  cache.remember(warmup, completed, 'main');
  cache.close();
  assert.equal(cache.admission(generation, 'main'), generation);
});

test('warmup receipts reject unsafe inputs and clock failures and keep their per-connection bound', () => {
  const warmup = { ...create(undefined, []), generate: false };
  const completed = response('receipt', []);
  const generation = create(undefined, [{ role: 'user', content: 'fixture' }], 'receipt');
  let time = 100;
  const cache = createRecoveryWebSocketWarmups({ now: () => time });
  cache.remember({ ...warmup, previous_response_id: null }, completed, undefined);
  assert.equal(
    Object.hasOwn(cache.admission(generation, undefined), 'previous_response_id'),
    false
  );
  for (let lane = 0; lane < 34; lane++) cache.remember(warmup, completed, 'lane-' + lane);
  assert.equal(cache.admission(generation, 'lane-33'), generation);
  assert.equal(
    Object.hasOwn(cache.admission(generation, 'lane-32'), 'previous_response_id'),
    false
  );
  let accessed = false;
  const unsafe = {
    get input() {
      accessed = true;
      throw new Error('must not execute');
    },
  };
  cache.remember(unsafe, completed, undefined);
  assert.equal(accessed, false);
  assert.equal(cache.admission(unsafe, undefined), unsafe);
  assert.equal(accessed, false);
  cache.remember(warmup, completed, undefined);
  time = Number.NaN;
  assert.equal(cache.admission(generation, undefined), generation);
  cache.remember(warmup, completed, undefined);
  time = Number.MAX_SAFE_INTEGER;
  assert.equal(cache.admission(generation, undefined), generation);
  cache.close();
  cache.remember(warmup, completed, undefined);
  assert.throws(() => createRecoveryWebSocketWarmups({ now: 1 }));
});

test(
  'native-shaped WS warmup captures originals, runs private reads and preserves hosted and namespace custom output',
  { timeout: 10000 },
  async (t) => {
    const original = 'synthetic original UTF-8 原文';
    const tools = [
      { type: 'function', name: 'lookup', parameters: { type: 'object' } },
      { type: 'namespace', name: 'native', tools: [{ type: 'custom', name: 'patch' }] },
      { type: 'web_search' },
    ];
    const finalOutput = [
      {
        type: 'web_search_call',
        id: 'ws-native-result',
        status: 'completed',
        action: { type: 'search', queries: ['synthetic'] },
      },
      {
        type: 'custom_tool_call',
        id: 'ctc-native-result',
        call_id: 'client-custom',
        name: 'patch',
        namespace: 'native',
        input: 'opaque\ninput',
        status: 'completed',
      },
      message('done'),
    ];
    let requests = 0,
      reads = 0;
    const f = await fixture(t, (event, socket) => {
      requests++;
      if (requests <= 2 || requests === 6) assert.deepEqual(event.tools, tools);
      else
        assert.deepEqual(
          event.tools.map((tool) => tool.name),
          [LIST, READ]
        );
      let output, id;
      if (event.generate === false) {
        output = [];
        id = 'native-warmup-capture';
      } else if (requests === 2) {
        assert.equal(event.previous_response_id, 'native-warmup-capture');
        output = [call('observed-call', 'lookup')];
        id = 'native-observed';
      } else if (requests === 3) {
        assert.equal(event.input[0].output, original);
        assert.ok(event.tools.some((tool) => tool.name === LIST));
        output = [call('internal-list', LIST)];
        id = 'native-list';
      } else if (requests === 4) {
        const sources = JSON.parse(event.input[0].output).sources;
        assert.equal(sources.length, 1);
        output = [
          call('internal-read', READ, { sourceId: sources[0].sourceId, digest: sources[0].digest }),
        ];
        id = 'native-read';
      } else if (requests === 5) {
        assert.equal(requests, 5);
        assert.equal(JSON.parse(event.input[0].output).page.text, original);
        reads++;
        output = [message('private-draft')];
        id = 'native-private';
      } else {
        assert.equal(requests, 6);
        assert.equal(event.previous_response_id, 'native-observed');
        assert.ok(event.input.at(-1).content.includes(JSON.stringify(original).slice(1, -1)));
        assert.doesNotMatch(
          JSON.stringify(event.input),
          /internal-list|internal-read|private-draft/
        );
        output = finalOutput;
        id = 'native-final';
      }
      socket.send(JSON.stringify({ type: 'response.completed', response: response(id, output) }));
    });
    const warmed = f.next();
    f.client.send(
      JSON.stringify({ ...create(undefined, []), tools, stream: true, generate: false })
    );
    assert.equal((await warmed).response.id, 'native-warmup-capture');
    const observed = f.next();
    f.client.send(
      JSON.stringify({
        ...create(undefined, [{ role: 'user', content: 'fixture' }], 'native-warmup-capture'),
        tools,
        stream: true,
      })
    );
    assert.equal((await observed).response.id, 'native-observed');
    const recovered = f.next();
    f.client.send(
      JSON.stringify({
        ...create(
          undefined,
          [{ type: 'function_call_output', call_id: 'observed-call', output: original }],
          'native-observed'
        ),
        tools,
        stream: true,
      })
    );
    assert.deepEqual((await recovered).response.output, finalOutput);
    assert.equal(requests, 6);
    assert.equal(reads, 1);
    assert.equal(f.sessions.inspect().snapshots, 2);
    assert.doesNotMatch(
      JSON.stringify(f.events),
      /hpm_list_retained_evidence|hpm_read_retained_evidence|internal-list|internal-read/
    );
    assert.ok(f.events.some((event) => event.type === 'response.custom_tool_call_input.done'));
  }
);

async function fixture(t, onRequest, options = {}) {
  const previous = process.env.API_KEY;
  process.env.API_KEY = 'synthetic-upstream';
  t.after(() => {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
  });
  let handshakeAttempts = 0;
  const upstream = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    perMessageDeflate: { threshold: 0 },
    handleProtocols: (protocols) => [...protocols].at(-1),
    verifyClient: (info, done) => {
      handshakeAttempts++;
      if (options.verifyClient) options.verifyClient(info, done);
      else if (options.rejection)
        done(false, options.rejection.status, options.rejection.body, options.rejection.headers);
      else done(true);
    },
  });
  let upstreamHandshake;
  upstream.on('headers', (headers) => {
    options.beforeAccept?.(config);
    headers.push(...(options.headers || []));
    upstreamHandshake = [...headers];
  });
  await once(upstream, 'listening');
  const peers = new Set();
  upstream.on('connection', (socket, request) => {
    t.diagnostic('synthetic upstream connected');
    peers.add(socket);
    assert.equal(request.headers.authorization, 'Bearer synthetic-upstream');
    assert.equal(request.headers['x-hpm-evidence-token'], undefined);
    socket.on('message', (data) => onRequest(JSON.parse(data.toString()), socket));
  });
  const sessions = createContextRecoverySessions();
  sessions.configure(true);
  const config = {
    appSettings: { contextRecoveryEnabled: true },
    entryAuth: { enabled: true, keys: [{ id: 'owner', key: 'synthetic-entry', enabled: true }] },
  };
  const profile = {
    id: 'synthetic',
    protocol: 'openai',
    authMode: 'api-key',
    apiKey: 'synthetic-upstream',
    targetUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
  };
  const handler = createWebSocketProxy({
    getConfig: () => config,
    getProfiles: () => [profile],
    getActiveProfile: () => profile,
    contextRecoveryLifecycle: { sessions },
    recoveryProviderAllowed: () => true,
  });
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connection', (socket) => sockets.add(socket));
  proxy.on('upgrade', (req, socket, head) => {
    void handler(req, socket, head, { protocol: 'openai-responses', listenPort: 3445 });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(
    `ws://127.0.0.1:${proxy.address().port}/v1/responses`,
    options.protocols || [],
    {
      headers: {
        authorization: 'Bearer synthetic-entry',
        'x-hpm-evidence-token': 'synthetic-private',
      },
      perMessageDeflate: { threshold: 0 },
    }
  );
  let handshake;
  client.on('upgrade', (response) => {
    handshake = response;
  });
  const events = [];
  const waiting = [];
  client.on('message', (data) => {
    const event = JSON.parse(data.toString());
    events.push(event);
    const index = waiting.findIndex((pending) => pending.type === event.type);
    if (index >= 0) waiting.splice(index, 1)[0].resolve(event);
  });
  client.on('close', () => {
    t.diagnostic('synthetic client closed');
    for (const pending of waiting.splice(0))
      pending.reject(new Error('Synthetic WebSocket closed before response completion'));
  });
  client.on('error', () => {});
  t.after(async () => {
    client.terminate();
    for (const peer of peers) peer.terminate();
    for (const socket of sockets) socket.destroy();
    proxy.close();
    upstream.close();
    await sessions.shutdownAsync();
  });
  const result = await once(client, options.rejection ? 'unexpected-response' : 'open');
  t.diagnostic('synthetic client open');
  return {
    client,
    sessions,
    events,
    config,
    handshake,
    upstreamHandshake,
    rejection: options.rejection ? result[1] : undefined,
    handshakeAttempts: () => handshakeAttempts,
    next: (type = 'response.completed') =>
      new Promise((resolve, reject) => {
        if (client.readyState !== WebSocket.OPEN)
          reject(new Error('Synthetic WebSocket is not open'));
        else waiting.push({ resolve, reject, type });
      }),
  };
}

test(
  'native Codex WS warmup and generation accept stream true without forwarding an HTTP stream control',
  { timeout: 10000 },
  async (t) => {
    const requests = [];
    const f = await fixture(t, (event, socket) => {
      requests.push(event);
      assert.equal(Object.hasOwn(event, 'stream'), false);
      const warmup = event.generate === false;
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: response(
            warmup ? 'native-warmup' : 'native-generation',
            warmup ? [] : [message('done')]
          ),
        })
      );
    });
    const body = {
      ...create(undefined, []),
      stream: true,
      generate: false,
      tools: [
        { type: 'function', name: 'get_goal', parameters: { type: 'object', properties: {} } },
        {
          type: 'namespace',
          name: 'multi_agent_v1',
          tools: [
            {
              type: 'function',
              name: 'wait_agent',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
        { type: 'web_search' },
      ],
    };
    const warmed = f.next();
    f.client.send(JSON.stringify(body));
    assert.equal((await warmed).response.id, 'native-warmup');
    assert.equal(f.sessions.inspect().snapshots, 0);
    const generated = f.next();
    const { generate: _generate, ...generation } = body;
    f.client.send(
      JSON.stringify({
        ...generation,
        input: [{ role: 'user', content: 'synthetic native shape' }],
        previous_response_id: 'native-warmup',
      })
    );
    assert.equal((await generated).response.id, 'native-generation');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].tools, body.tools);
    assert.deepEqual(requests[1].tools, body.tools);
    assert.equal(f.sessions.inspect().snapshots, 1);
  }
);

test(
  'real WS handshake preserves bounded routing metadata and selected protocol while negotiating each hop independently',
  { timeout: 10000 },
  async (t) => {
    let calls = 0;
    const f = await fixture(
      t,
      () => {
        calls++;
      },
      {
        protocols: ['synthetic-first', 'synthetic-second'],
        headers: [
          'X-Request-Id: synthetic-request',
          'X-Codex-Turn-State: synthetic-routing',
          'OpenAI-Processing-Ms: 12',
          'Set-Cookie: private=synthetic',
          'Authorization: Bearer private',
          'X-Unrelated-Private: synthetic-private',
        ],
      }
    );
    assert.equal(f.handshake.headers['x-request-id'], 'synthetic-request');
    assert.equal(f.handshake.headers['x-codex-turn-state'], 'synthetic-routing');
    assert.equal(f.handshake.headers['openai-processing-ms'], '12');
    assert.equal(f.client.protocol, 'synthetic-second');
    assert.equal(f.handshake.headers['set-cookie'], undefined);
    assert.equal(f.handshake.headers.authorization, undefined);
    assert.equal(f.handshake.headers['x-unrelated-private'], undefined);
    const upstreamAccept = f.upstreamHandshake.find((header) =>
      /^Sec-WebSocket-Accept:/i.test(header)
    );
    assert.notEqual(f.handshake.headers['sec-websocket-accept'], upstreamAccept.split(': ')[1]);
    assert.equal(calls, 0);
    assert.equal(f.handshakeAttempts(), 1);
    assert.equal(f.sessions.inspect().snapshots, 0);
  }
);

test(
  'real WS handshake rejection preserves status, safe retry metadata and bounded body without retrying or capturing evidence',
  { timeout: 10000 },
  async (t) => {
    let calls = 0;
    const f = await fixture(
      t,
      () => {
        calls++;
      },
      {
        rejection: {
          status: 429,
          body: 'Synthetic rate limit',
          headers: {
            'Retry-After': '17',
            'X-Request-Id': 'synthetic-rejected',
            'Set-Cookie': 'private=synthetic',
            Authorization: 'Bearer private',
          },
        },
      }
    );
    const chunks = [];
    for await (const chunk of f.rejection) chunks.push(chunk);
    assert.equal(f.rejection.statusCode, 429);
    assert.equal(f.rejection.headers['retry-after'], '17');
    assert.equal(f.rejection.headers['x-request-id'], 'synthetic-rejected');
    assert.equal(f.rejection.headers['set-cookie'], undefined);
    assert.equal(f.rejection.headers.authorization, undefined);
    assert.equal(Buffer.concat(chunks).toString(), 'Synthetic rate limit');
    assert.equal(calls, 0);
    assert.equal(f.handshakeAttempts(), 1);
    assert.equal(f.sessions.inspect().snapshots, 0);
  }
);

test('WS handshake metadata admits only bounded own data and never executes or leaks malformed headers', () => {
  assert.deepEqual(recoveryHandshakeHeaders({}), []);
  assert.deepEqual(recoveryHandshakeHeaders(Object.create({ 'x-request-id': 'inherited' })), []);
  const source = {
    'X-Request-Id': 'synthetic',
    'Content-Type': 'text/plain',
    'Set-Cookie': 'secret',
  };
  assert.deepEqual(recoveryHandshakeHeaders(source), ['x-request-id: synthetic']);
  assert.deepEqual(recoveryHandshakeHeaders(source, true), [
    'x-request-id: synthetic',
    'content-type: text/plain',
  ]);
  assert.equal(source['Set-Cookie'], 'secret');
  let getters = 0;
  const accessor = {
    get 'x-request-id'() {
      getters++;
      return 'secret';
    },
  };
  const hidden = {
    get authorization() {
      getters++;
      throw Error('secret');
    },
  };
  assert.deepEqual(recoveryHandshakeHeaders(hidden), []);
  for (const input of [
    null,
    undefined,
    [],
    1,
    '',
    accessor,
    { 'x-request-id': ['secret'] },
    { 'x-request-id': null },
    { 'x-request-id': 'secret\r\nSet-Cookie: secret' },
    { 'x-request-id': 'secret\u007f' },
    { 'x-request-id': 'secret\u0100' },
    { 'x-request-id': 's'.repeat(4097) },
    { 'x-request-id': 'one', 'X-Request-Id': 'two' },
    Object.fromEntries(Array.from({ length: 1025 }, (_, index) => ['x-' + index, 'v'])),
    { 'x-request-id': 's'.repeat(4096), 'x-codex-turn-state': 's'.repeat(4096) },
    new Proxy(
      {},
      {
        ownKeys() {
          throw Error('secret');
        },
      }
    ),
  ])
    assert.throws(() => recoveryHandshakeHeaders(input), {
      message: 'Recovery WebSocket handshake unavailable',
    });
  assert.throws(() => recoveryHandshakeHeaders({}, 'secret'), /handshake unavailable/);
  assert.equal(getters, 0);
  assert.equal(recoveryHandshakeHeaders({ 'x-request-id': 's'.repeat(4096) }).length, 1);
});

test('WS rejection framing preserves bounded bytes and recalculates framing without credentials or upstream status text', () => {
  for (const status of [300, 401, 429, 503, 599]) {
    const body = Buffer.from('Synthetic error 🙂\r\n');
    const encoded = recoveryHandshakeRejection(
      status,
      {
        'content-type': 'application/json',
        'content-length': '999999',
        'transfer-encoding': 'chunked',
        connection: 'keep-alive',
        authorization: 'secret',
        'set-cookie': 'secret',
        'www-authenticate': 'Bearer realm="synthetic"',
      },
      body
    );
    const split = encoded.indexOf('\r\n\r\n');
    const headers = encoded.subarray(0, split).toString();
    assert.match(headers, new RegExp('^HTTP/1.1 ' + status + ' '));
    assert.match(headers, /Connection: close/);
    assert.ok(headers.includes('Content-Length: ' + body.length));
    assert.match(headers, /www-authenticate: Bearer realm="synthetic"/);
    assert.doesNotMatch(headers, /secret|999999|chunked|keep-alive/);
    assert.deepEqual(encoded.subarray(split + 4), body);
  }
  assert.match(
    recoveryHandshakeRejection(401, {}, Buffer.alloc(0)).toString(),
    /Content-Length: 0/
  );
  const full = Buffer.alloc(MAX_HANDSHAKE_BODY_BYTES, 7);
  assert.ok(recoveryHandshakeRejection(503, {}, full).subarray(-full.length).equals(full));
  for (const status of [0, 101, 200, 299, 600, 400.5, NaN, '429'])
    assert.throws(
      () => recoveryHandshakeRejection(status, {}, Buffer.alloc(0)),
      /handshake unavailable/
    );
  for (const body of [null, '', {}, Buffer.alloc(MAX_HANDSHAKE_BODY_BYTES + 1)])
    assert.throws(() => recoveryHandshakeRejection(429, {}, body), /handshake unavailable/);
});

test(
  'real WS oversized or malformed handshake rejection becomes a fixed 502 with no partial body or retry',
  { timeout: 10000 },
  async (t) => {
    for (const rejection of [
      { status: 503, body: 'secret'.repeat(12000), headers: { 'Retry-After': '17' } },
      { status: 401, body: 'secret', headers: { 'X-Request-Id': 'secret'.repeat(700) } },
    ]) {
      const f = await fixture(t, () => assert.fail('generation must not run'), { rejection });
      const chunks = [];
      for await (const chunk of f.rejection) chunks.push(chunk);
      assert.equal(f.rejection.statusCode, 502);
      assert.equal(Buffer.concat(chunks).toString(), 'Bad Gateway');
      assert.equal(f.rejection.headers['retry-after'], undefined);
      assert.equal(f.handshakeAttempts(), 1);
      assert.equal(f.sessions.inspect().snapshots, 0);
    }
  }
);

test(
  'real WS handshake rechecks current recovery permission before publishing upstream metadata',
  { timeout: 10000 },
  async (t) => {
    await assert.rejects(
      fixture(t, () => assert.fail('generation must not run'), {
        headers: ['X-Codex-Turn-State: synthetic-private'],
        beforeAccept: (config) => {
          config.appSettings.contextRecoveryEnabled = false;
        },
      }),
      /socket hang up|closed/
    );
  }
);

test(
  'real WS incomplete rejection has an absolute deadline and closes both peers without publishing a partial error',
  { timeout: 10000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const request = http.request;
    let observed = false;
    let attempts = 0;
    t.mock.method(http, 'request', function (...args) {
      const outgoing = request.apply(this, args);
      outgoing.on('response', (response) => {
        if (response.statusCode !== 429) return;
        observed = true;
        queueMicrotask(() => t.mock.timers.tick(10000));
      });
      return outgoing;
    });
    await assert.rejects(
      fixture(t, () => assert.fail('generation must not run'), {
        verifyClient(info) {
          attempts++;
          info.req.socket.write(
            'HTTP/1.1 429 Too Many Requests\r\nContent-Length: 1000\r\n\r\npartial-private'
          );
        },
      }),
      /socket hang up|closed/
    );
    assert.equal(observed, true);
    assert.equal(attempts, 1);
  }
);

test(
  'ordinary upstream WS failures retain their events and permit the next request without publishing failed evidence',
  { timeout: 10000 },
  async (t) => {
    for (const type of ['error', 'response.failed', 'response.incomplete']) {
      await t.test(type, async (t) => {
        let calls = 0;
        const upstreamError = {
          type: 'invalid_request_error',
          code: 'previous_response_not_found',
          message: 'Synthetic upstream failure',
          param: 'previous_response_id',
        };
        const failed =
          type === 'error'
            ? { type, error: upstreamError, event_id: 'fixture-error' }
            : {
                type,
                response: {
                  ...response('failed-response', [call('partial-call', 'lookup')]),
                  status: type === 'response.failed' ? 'failed' : 'incomplete',
                  error: upstreamError,
                },
              };
        const f = await fixture(t, (body, socket) => {
          calls++;
          t.diagnostic('synthetic upstream request ' + calls);
          const event =
            calls === 1
              ? failed
              : { type: 'response.completed', response: response('success', [message('done')]) };
          socket.send(JSON.stringify(event));
        });
        const rejected = f.next(type);
        f.client.send(
          JSON.stringify(create(undefined, [{ role: 'user', content: 'synthetic question' }]))
        );
        assert.deepEqual(await rejected, failed);
        assert.equal(f.client.readyState, WebSocket.OPEN);
        assert.equal(f.sessions.inspect().snapshots, 0);
        const completed = f.next();
        f.client.send(
          JSON.stringify(
            create(undefined, [{ role: 'user', content: 'fresh retry chosen by client' }])
          )
        );
        assert.equal((await completed).response.id, 'success');
        assert.equal(calls, 2);
        assert.equal(f.events.filter((event) => event.type === type).length, 1);
        assert.equal(
          f.events.some(
            (event) =>
              event.type === 'response.completed' && event.response.id === 'failed-response'
          ),
          false
        );
      });
    }
  }
);

test('WS dispatch projects only exact descendants onto the latest response ID', async () => {
  for (const mode of ['incremental', 'full', 'empty', 'changed-history', 'changed-base', 'mixed']) {
    const requests = [];
    const input = mode === 'empty' ? [] : [{ role: 'user', content: 'original🙂\r\n' }];
    const hidden = call('private1', LIST);
    const external = call('external1', 'lookup');
    const output = mode === 'mixed' ? [hidden, external] : [hidden];
    const dispatch = createRecoveryWebSocketDispatch(async (body, context) => {
      requests.push(JSON.parse(JSON.stringify(body)));
      assert.equal(context, marker);
      return {
        statusCode: 200,
        stream: false,
        wire: wire(response('r' + requests.length, output)),
      };
    });
    const marker = { signal: new globalThis.AbortController().signal };
    const body = { ...create(undefined, input), previous_response_id: 'ancestor' };
    delete body.type;
    if (mode === 'full') delete body.previous_response_id;
    const before = JSON.stringify(body);
    await dispatch(body, marker);
    const result = { type: 'function_call_output', call_id: 'private1', output: 'exact🙂' };
    const next = { ...body, input: [...input, hidden, result] };
    if (mode === 'changed-base') next.previous_response_id = 'sibling';
    if (mode === 'changed-history') next.input[0] = { role: 'user', content: 'changed' };
    await dispatch(next, marker);
    assert.equal(JSON.stringify(body), before);
    assert.deepEqual(requests[0], body);
    if (['mixed', 'changed-base', 'changed-history'].includes(mode))
      assert.deepEqual(requests[1], next);
    else {
      assert.equal(requests[1].previous_response_id, 'r1');
      assert.deepEqual(requests[1].input, [result]);
      assert.deepEqual(requests[1].tools, body.tools);
      assert.equal(requests[1].store, false);
    }
  }
});

test('WS dispatch rejects unsafe requests without executing getters or replays', async () => {
  assert.throws(() => createRecoveryWebSocketDispatch(null));
  let getters = 0;
  const accessor = { input: [] };
  Object.defineProperty(accessor, 'model', {
    enumerable: true,
    get() {
      getters++;
      return 'unsafe';
    },
  });
  for (const input of [
    null,
    [],
    {},
    { input: [null] },
    { input: [], previous_response_id: '' },
    accessor,
    { input: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] },
  ]) {
    let calls = 0;
    const dispatch = createRecoveryWebSocketDispatch(async () => {
      calls++;
    });
    await assert.rejects(dispatch(input, {}), /dispatch unavailable/);
    await assert.rejects(dispatch({ input: [] }, {}), /dispatch unavailable/);
    assert.equal(calls, 0);
  }
  assert.equal(getters, 0);
});

test('WS explicit null continuation projects only exact descendants and preserves the public request', async () => {
  const seen = [];
  const hidden = call('private-null', LIST);
  const dispatch = createRecoveryWebSocketDispatch(async (body) => {
    seen.push(JSON.parse(JSON.stringify(body)));
    return {
      statusCode: 200,
      stream: false,
      wire: wire(response('null-' + seen.length, [hidden])),
    };
  });
  const first = { input: [{ role: 'user', content: 'full window' }], previous_response_id: null };
  const before = JSON.stringify(first);
  await dispatch(first, {});
  const result = { type: 'function_call_output', call_id: hidden.call_id, output: 'exact' };
  await dispatch({ ...first, input: [...first.input, hidden, result] }, {});
  assert.deepEqual(seen[0], first);
  assert.equal(seen[1].previous_response_id, 'null-1');
  assert.deepEqual(seen[1].input, [result]);
  assert.equal(JSON.stringify(first), before);
});

test(
  'actual WS explicit null full window automatically recovers original evidence',
  { timeout: 15000 },
  async (t) => {
    const user = { role: 'user', content: 'synthetic null reconnect' };
    const lookup = call('null-lookup', 'lookup');
    const original = 'null reconnect original🙂\r\nsecond line';
    let rounds = 0;
    const f = await fixture(t, (event, socket) => {
      rounds++;
      let output;
      if (rounds === 1) {
        assert.equal(event.previous_response_id, null);
        output = [lookup];
      } else if (rounds === 2) {
        assert.equal(event.previous_response_id, null);
        assert.equal(
          event.tools.some((tool) => tool.name === LIST),
          true
        );
        output = [call('null-list', LIST)];
      } else if (rounds === 3) {
        assert.equal(event.previous_response_id, 'null-resp2');
        assert.equal(event.input.length, 1);
        const index = JSON.parse(event.input[0].output);
        assert.equal(index.sources.length, 1);
        output = [
          call('null-read', READ, {
            sourceId: index.sources[0].sourceId,
            digest: index.sources[0].digest,
          }),
        ];
      } else if (rounds === 4) {
        assert.equal(rounds, 4);
        assert.equal(event.previous_response_id, 'null-resp3');
        assert.equal(event.input.length, 1);
        assert.equal(JSON.parse(event.input[0].output).page.text, original);
        output = [message('private-draft')];
      } else {
        assert.equal(rounds, 5);
        assert.equal(event.previous_response_id, null);
        assert.ok(event.input.at(-1).content.includes(JSON.stringify(original).slice(1, -1)));
        assert.doesNotMatch(JSON.stringify(event.input), /null-list|null-read|private-draft/);
        assert.deepEqual(event.tools, create(undefined, []).tools);
        output = [message('null recovered')];
      }
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          stream_id: event.stream_id,
          response: response('null-resp' + rounds, output),
        })
      );
    });
    const first = f.next();
    f.client.send(JSON.stringify({ ...create('main', [user]), previous_response_id: null }));
    assert.equal((await first).response.id, 'null-resp1');
    const second = f.next();
    f.client.send(
      JSON.stringify({
        ...create('main', [
          user,
          lookup,
          { type: 'function_call_output', call_id: lookup.call_id, output: original },
        ]),
        previous_response_id: null,
      })
    );
    const done = await second;
    assert.equal(done.response.output[0].content[0].text, 'null recovered');
    assert.equal(rounds, 5);
    assert.equal(f.sessions.inspect().roots, 1);
    assert.equal(JSON.stringify(f.events).includes(original), false);
    assert.equal(
      f.events.some((event) => event.item?.name === LIST || event.item?.name === READ),
      false
    );
  }
);

test('WS dispatch preserves protocol failures and fences malformed or rejected transport', async () => {
  for (const mode of [
    'reject',
    'utf8',
    'json',
    'status',
    'stream',
    'missing-id',
    'incomplete',
    'accessor',
  ]) {
    let calls = 0,
      getters = 0;
    const original = {
      statusCode: 200,
      stream: false,
      wire: wire(response('r1', [message('final')])),
    };
    if (mode === 'utf8') original.wire = Buffer.from([255]);
    if (mode === 'json') original.wire = Buffer.from('{');
    if (mode === 'status') original.statusCode = 400;
    if (mode === 'stream') original.stream = true;
    if (mode === 'missing-id') original.wire = wire({ status: 'completed', output: [] });
    if (mode === 'incomplete') original.wire = wire({ id: 'r1', status: 'incomplete', output: [] });
    if (mode === 'accessor')
      Object.defineProperty(original, 'wire', {
        get() {
          getters++;
          throw new Error('private');
        },
      });
    const dispatch = createRecoveryWebSocketDispatch(async () => {
      calls++;
      if (mode === 'reject') throw new Error('private transport details');
      return original;
    });
    if (['reject', 'utf8', 'json'].includes(mode)) {
      await assert.rejects(
        dispatch({ input: [] }, {}),
        /^Error: Recovery WebSocket dispatch unavailable$/
      );
      await assert.rejects(dispatch({ input: [] }, {}));
      assert.equal(calls, 1);
    } else {
      assert.equal(await dispatch({ input: [] }, {}), original);
      assert.equal(await dispatch({ input: [] }, {}), original);
      assert.equal(calls, 2);
    }
    assert.equal(getters, 0);
  }
});

test('WS dispatch isolates concurrent runners and bounds large ancestry fingerprints', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const output = [message('large')];
  output[0].content[0].text = 'x'.repeat(1100 * 1024);
  const dispatch = createRecoveryWebSocketDispatch(async () => {
    await gate;
    return { statusCode: 200, stream: false, wire: wire(response('r1', output)) };
  });
  const body = { input: [{ role: 'user', content: 'x'.repeat(1100 * 1024) }] };
  const pending = dispatch(body, {});
  await assert.rejects(dispatch(body, {}));
  release();
  assert.equal((await pending).statusCode, 200);
});

test('mixed WS continuation joins private results only after publication and current authorization', () => {
  let now = 100,
    allowed = true;
  const store = createRecoveryWebSocketContinuations({ now: () => now });
  const input = [{ type: 'function_call_output', call_id: 'private1', output: 'original🙂\r\n' }];
  const token = store.reserve('r1', input, 1100, () => allowed);
  assert.equal(store.blocked('r1'), true);
  assert.throws(() => store.read('r1', true));
  assert.throws(() => store.commit({}));
  store.commit(token);
  assert.equal(store.blocked('r1'), false);
  assert.throws(() => store.commit(token));
  for (const authority of [false, undefined, 1]) assert.throws(() => store.read('r1', authority));
  const read = JSON.parse(JSON.stringify(store.read('r1', true)));
  assert.deepEqual(read, input);
  const copy = store.read('r1', true);
  copy[0].output = 'changed';
  assert.deepEqual(JSON.parse(JSON.stringify(store.read('r1', true))), input);
  assert.equal(JSON.stringify(store.inspect()).includes('original'), false);
  assert.deepEqual(store.read('unknown', true), []);
  allowed = false;
  assert.deepEqual(store.read('r1', true), []);
  assert.equal(store.inspect().bytes, 0);
  assert.throws(() => store.commit(token));
  allowed = true;
  const withdrawn = store.reserve('r2', input, 1100, () => true);
  store.discard(withdrawn);
  store.discard(withdrawn);
  assert.equal(store.inspect().records, 0);
  const expired = store.reserve('r3', input, 1100, () => true);
  now = 1100;
  assert.deepEqual(store.read('r3', true), []);
  assert.throws(() => store.commit(expired));
  store.close();
  assert.equal(store.inspect().closed, true);
  assert.throws(() => store.reserve('r4', input, 1200, () => true));
});

test('mixed WS continuation keeps the original 24 hour deadline while accepting legacy shorter deadlines', () => {
  let time = 100;
  const store = createRecoveryWebSocketContinuations({ now: () => time });
  const input = [
    { type: 'function_call_output', call_id: 'private', output: 'synthetic-original' },
  ];
  try {
    const legacy = store.reserve('legacy', input, 1800100, () => true);
    const current = store.reserve('current', input, 86400100, () => true);
    store.commit(legacy);
    store.commit(current);
    time = 1800100;
    assert.deepEqual(store.read('legacy', true), []);
    assert.deepEqual(JSON.parse(JSON.stringify(store.read('current', true))), input);
    time = 86400099;
    assert.deepEqual(JSON.parse(JSON.stringify(store.read('current', true))), input);
    time = 86400100;
    assert.deepEqual(store.read('current', true), []);
  } finally {
    store.close();
  }
});

test('mixed WS continuation rejects invalid records, executable input and retention overflow', () => {
  assert.throws(() => createRecoveryWebSocketContinuations({ now: 1 }));
  const store = createRecoveryWebSocketContinuations({ now: () => 100 });
  const item = { type: 'function_call_output', call_id: 'private1', output: '' };
  let invoked = 0;
  const bad = { ...item };
  Object.defineProperty(bad, 'output', {
    enumerable: true,
    get() {
      invoked++;
      return 'unsafe';
    },
  });
  for (const input of [
    null,
    {},
    [],
    [null],
    [1],
    [item, item],
    [bad],
    [{ ...item, name: LIST }],
    [{ ...item, type: 'function_call' }],
    [{ ...item, call_id: '' }],
    [{ ...item, output: null }],
    Array.from({ length: 17 }, (_, i) => ({ ...item, call_id: 'id' + i })),
    [{ ...item, output: 'x'.repeat(2 * 1024 * 1024) }],
  ])
    assert.throws(() => store.reserve('r1', input, 1100, () => true));
  for (const [id, expiry, callback] of [
    ['', 1100, () => true],
    ['r1', 100, () => true],
    ['r1', NaN, () => true],
    ['r1', 86400101, () => true],
    ['r1', 1100, null],
    ['r1', 1100, () => false],
  ])
    assert.throws(() => store.reserve(id, [item], expiry, callback));
  assert.equal(invoked, 0);
  assert.equal(store.inspect().records, 0);
  for (let i = 0; i < 256; i++) store.reserve('r' + i, [item], 1100, () => true);
  assert.throws(() => store.reserve('overflow', [item], 1100, () => true));
  assert.throws(() => store.reserve('r0', [item], 1100, () => true));
  store.close();
  const bytes = createRecoveryWebSocketContinuations({ now: () => 100 });
  bytes.reserve('large1', [{ ...item, output: 'x'.repeat(1100 * 1024) }], 1100, () => true);
  assert.throws(() =>
    bytes.reserve('large2', [{ ...item, output: 'x'.repeat(1100 * 1024) }], 1100, () => true)
  );
  bytes.close();
});

test('mixed WS continuation reclaims idle expired data and fences bad clocks and callbacks', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 100,
    checked = 0;
  const input = [{ type: 'function_call_output', call_id: 'private1', output: 'original' }];
  const store = createRecoveryWebSocketContinuations({ now: () => now });
  store.reserve('r1', input, 1100, () => {
    checked++;
    return true;
  });
  const before = checked;
  now = 1100;
  t.mock.timers.tick(1000);
  assert.ok(checked > before);
  assert.equal(store.inspect().bytes, 0);
  now = 99;
  assert.equal(store.inspect().closed, true);
  for (const mode of ['clock', 'callback']) {
    let fail = false;
    const record = createRecoveryWebSocketContinuations({
      now: () => {
        if (fail && mode === 'clock') throw new Error('private');
        return 100;
      },
    });
    record.reserve('r1', input, 1100, () => {
      if (fail) throw new Error('private');
      return true;
    });
    fail = true;
    assert.equal(record.inspect().bytes, 0);
    record.close();
  }
});

test('WS dispatch joins completed private outputs before new client input without mutating either', async () => {
  const deferred = [{ type: 'function_call_output', call_id: 'hidden', output: 'original🙂' }];
  const body = {
    ...create(
      undefined,
      [{ type: 'function_call_output', call_id: 'external', output: 'client result' }],
      'r1'
    ),
  };
  delete body.type;
  const before = JSON.stringify([deferred, body]);
  let sent;
  const dispatch = createRecoveryWebSocketDispatch(async (request) => {
    sent = request;
    return { statusCode: 200, stream: false, wire: wire(response('r2', [message('done')])) };
  }, deferred);
  await dispatch(body, {});
  assert.equal(sent.previous_response_id, 'r1');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.input)), [...deferred, ...body.input]);
  assert.equal(JSON.stringify([deferred, body]), before);
  await assert.rejects(dispatch({ ...body, input: [...deferred, ...body.input] }, {}));
  for (const invalid of [
    null,
    {},
    [null],
    [deferred[0], deferred[0]],
    [{ ...deferred[0], output: null }],
  ])
    assert.throws(() => createRecoveryWebSocketDispatch(async () => {}, invalid));
});

test('WS wire rejects malformed, executable, oversized and transport-specific input', () => {
  for (const input of [
    Buffer.from([255]),
    Buffer.from('{'),
    wire(null),
    wire([]),
    wire({ type: 4 }),
    wire({ type: 'response.create', stream_id: '' }),
    wire({ type: 'response.create', stream_id: '\0' }),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  ])
    assert.throws(() => parseRecoveryWebSocketMessage(input));
  const parsed = parseRecoveryWebSocketMessage(
    wire(create('lane', [{ role: 'user', content: 'hello' }]))
  );
  assert.equal(recoveryWebSocketBody(parsed).stream_id, undefined);
  assert.deepEqual(
    recoveryWebSocketBody({ ...parsed, stream: true }),
    recoveryWebSocketBody(parsed)
  );
  for (const stream of [false, null, 0, 1, '', 'true', [], {}])
    assert.throws(() => recoveryWebSocketBody({ ...parsed, stream }));
  assert.throws(() => recoveryWebSocketBody({ ...parsed, background: false }));
});

for (const externalCount of [1, 3]) {
  test(
    'actual fragmented WS isolates repeated recovery and ' + externalCount + ' external results',
    { timeout: 15000 },
    async (t) => {
      let rounds = 0,
        published = 0,
        privateStep = 0,
        previousPublic;
      const original = 'exact original🙂\r\nsecond line';
      const f = await fixture(t, (event, socket) => {
        rounds++;
        assert.equal(event.store, false);
        let output;
        if (event.tools.some((tool) => tool.name === LIST)) {
          assert.deepEqual(
            event.tools.map((tool) => tool.name),
            [LIST, READ]
          );
          privateStep++;
          if (privateStep === 1) {
            assert.equal(event.previous_response_id, previousPublic);
            output = [call('private-list-' + rounds, LIST)];
          } else if (privateStep === 2) {
            assert.equal(event.previous_response_id, 'separate-' + (rounds - 1));
            const source = JSON.parse(event.input.at(-1).output).sources[0];
            output = [
              call('private-read-' + rounds, READ, {
                sourceId: source.sourceId,
                digest: source.digest,
              }),
            ];
          } else {
            assert.equal(privateStep, 3);
            assert.equal(event.previous_response_id, 'separate-' + (rounds - 1));
            assert.equal(JSON.parse(event.input.at(-1).output).page.text, original);
            output = [message('private-draft')];
          }
        } else {
          assert.deepEqual(event.tools, create('main', []).tools);
          if (published) {
            assert.equal(privateStep, 3);
            assert.equal(event.previous_response_id, previousPublic);
            assert.ok(event.input.at(-1).content.includes(JSON.stringify(original).slice(1, -1)));
            assert.doesNotMatch(
              JSON.stringify(event.input),
              /private-list-|private-read-|private-draft/
            );
          }
          privateStep = 0;
          published++;
          previousPublic = 'separate-' + rounds;
          output =
            published <= externalCount
              ? [call('lookup' + published, 'lookup', { step: published })]
              : [message(published === externalCount + 1 ? 'done' : 'continued')];
        }
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            stream_id: event.stream_id,
            response: response('separate-' + rounds, output),
          })
        );
      });
      let next = f.next();
      const initial = JSON.stringify(
        create('main', [{ role: 'user', content: 'synthetic question' }])
      );
      f.client.send(initial.slice(0, 13), { fin: false });
      f.client.send(initial.slice(13), { fin: true });
      let result = await next;
      assert.equal(result.response.id, 'separate-1');
      for (let index = 1; index <= externalCount; index++) {
        assert.deepEqual(
          result.response.output.map((item) => item.call_id),
          ['lookup' + index]
        );
        assert.equal(result.response.output[0].arguments, JSON.stringify({ step: index }));
        next = f.next();
        f.client.send(
          JSON.stringify(
            create(
              'main',
              [{ type: 'function_call_output', call_id: 'lookup' + index, output: original }],
              result.response.id
            )
          )
        );
        result = await next;
        assert.equal(rounds, 1 + 4 * index);
      }
      assert.equal(result.response.output[0].content[0].text, 'done');
      next = f.next();
      f.client.send(JSON.stringify(create('main', [], result.response.id)));
      result = await next;
      assert.equal(result.response.output[0].content[0].text, 'continued');
      assert.equal(rounds, 1 + 4 * (externalCount + 1));
      assert.equal(f.sessions.inspect().roots, 1);
      assert.doesNotMatch(
        JSON.stringify(f.events),
        /hpm_list_retained_evidence|hpm_read_retained_evidence|private-draft|exact original/
      );
    }
  );
}

test(
  'named WS streams interleave while the same lane remains FIFO',
  { timeout: 15000 },
  async (t) => {
    const sent = [];
    let releaseFirst;
    const f = await fixture(t, (event, socket) => {
      sent.push(event.stream_id);
      const responseId = 'resp' + sent.length;
      const finish = () =>
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            stream_id: event.stream_id,
            response: response(responseId, [message(event.stream_id)]),
          })
        );
      if (sent.length === 1) releaseFirst = finish;
      else finish();
    });
    const first = f.next(),
      second = f.next(),
      third = f.next();
    f.client.send(JSON.stringify(create('a', [{ role: 'user', content: 'one' }])));
    f.client.send(JSON.stringify(create('a', [{ role: 'user', content: 'two' }])));
    f.client.send(JSON.stringify(create('b', [{ role: 'user', content: 'three' }])));
    assert.equal((await first).stream_id, 'b');
    assert.deepEqual(sent, ['a', 'b']);
    releaseFirst();
    assert.equal((await second).stream_id, 'a');
    assert.equal((await third).stream_id, 'a');
    assert.deepEqual(sent, ['a', 'b', 'a']);
  }
);

test('WS stream admission accepts only the documented ASCII identifiers and default lane', () => {
  for (const stream of ['main', 'A0_.-', 'x'.repeat(256)])
    assert.equal(parseRecoveryWebSocketMessage(wire(create(stream, []))).stream_id, stream);
  assert.equal(parseRecoveryWebSocketMessage(wire(create(undefined, []))).stream_id, undefined);
  for (const stream of [
    '',
    null,
    0,
    [],
    {},
    'x'.repeat(257),
    '中文',
    'a:b',
    'a/b',
    'a b',
    'a\nb',
    '\ud800',
  ])
    assert.throws(
      () => parseRecoveryWebSocketMessage(wire(create(stream, []))),
      (error) => error.code === 'invalid_stream_id' && !error.message.includes('中文')
    );
});

test(
  'WS stream admission returns bounded errors without interrupting active lanes on a real compressed socket',
  { timeout: 15000 },
  async (t) => {
    const requests = [];
    let release, started;
    const running = new Promise((resolve) => {
      started = resolve;
    });
    const f = await fixture(t, (event, socket) => {
      requests.push(event);
      const finish = () =>
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            stream_id: event.stream_id,
            response: response('stream-' + requests.length, [message('done')]),
          })
        );
      if (event.stream_id === 'main') {
        release = finish;
        started();
      } else finish();
    });
    f.client.send(JSON.stringify({ ...create('main', []), generate: false }));
    await running;
    for (const stream of ['', 'a:b', '中文', 'x'.repeat(257), null]) {
      const rejected = f.next('error');
      f.client.send(
        JSON.stringify({
          ...create(stream, [{ role: 'user', content: 'PRIVATE_STREAM_PAYLOAD' }]),
          generate: false,
        })
      );
      const event = await rejected;
      assert.equal(event.status, 400);
      assert.equal(event.error.type, 'invalid_request_error');
      assert.equal(event.error.code, 'invalid_stream_id');
      assert.equal(event.error.param, 'stream_id');
      assert.equal(Object.hasOwn(event, 'stream_id'), false);
      assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
      assert.equal(requests.length, 1);
      assert.equal(f.client.readyState, WebSocket.OPEN);
    }
    const other = f.next();
    f.client.send(JSON.stringify({ ...create('other', []), generate: false }));
    assert.equal((await other).stream_id, 'other');
    const original = f.next();
    release();
    assert.equal((await original).stream_id, 'main');
    assert.equal(f.sessions.inspect().snapshots, 0);
  }
);

test(
  'WS stream admission reports the named-stream limit and preserves existing and default lanes',
  { timeout: 15000 },
  async (t) => {
    let requests = 0;
    const f = await fixture(t, (event, socket) => {
      requests++;
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          ...(event.stream_id === undefined ? {} : { stream_id: event.stream_id }),
          response: response('limit-' + requests, []),
        })
      );
    });
    async function run(stream) {
      const next = f.next();
      f.client.send(JSON.stringify({ ...create(stream, []), generate: false }));
      assert.equal((await next).stream_id, stream);
    }
    await run(undefined);
    for (let index = 0; index < 32; index++) await run('lane-' + index);
    const rejected = f.next('error');
    f.client.send(JSON.stringify({ ...create('lane-32', []), generate: false }));
    const error = await rejected;
    assert.equal(error.status, 400);
    assert.equal(error.stream_id, 'lane-32');
    assert.equal(error.error.code, 'websocket_stream_limit_reached');
    assert.equal(error.error.param, 'stream_id');
    assert.equal(requests, 33);
    await run('lane-0');
    await run(undefined);
    assert.equal(requests, 35);
    assert.equal(f.client.readyState, WebSocket.OPEN);
  }
);

test('WS stream admission error encoding accepts only fixed codes and validated own scalar IDs', () => {
  let accessed = false;
  const hostile = {
    toString() {
      accessed = true;
      throw new Error('synthetic private');
    },
  };
  const invalid = recoveryWebSocketStreamError('invalid_stream_id', hostile);
  assert.deepEqual(Object.keys(invalid).sort(), ['error', 'status', 'type']);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.error.code, 'invalid_stream_id');
  assert.equal(invalid.error.param, 'stream_id');
  for (const id of [undefined, null, 1, [], hostile, '', 'x'.repeat(257), 'a\n', 'a\r\n', '中文'])
    assert.throws(() => recoveryWebSocketStreamError('websocket_stream_limit_reached', id), {
      message: 'Recovery WebSocket protocol unavailable',
    });
  for (const code of [undefined, null, hostile, 'synthetic private', 'toString'])
    assert.throws(() => recoveryWebSocketStreamError(code, 'main'), {
      message: 'Recovery WebSocket protocol unavailable',
    });
  for (const id of ['a', 'A0_.-', 'x'.repeat(256)]) {
    const event = recoveryWebSocketStreamError('websocket_stream_limit_reached', id);
    assert.equal(event.stream_id, id);
    assert.equal(event.error.code, 'websocket_stream_limit_reached');
    assert.equal(event.status, 400);
  }
  assert.equal(accessed, false);
});

test('WS stream admission error replies recheck authorization and close safely on failed send', async (t) => {
  for (const mode of ['revoked', 'authorization-threw', 'send-threw', 'send-rejected']) {
    let allowed = true,
      sends = 0;
    const f = connectionFixture(t, {
      authorized: () => {
        if (!allowed && mode === 'authorization-threw') throw new Error('synthetic private');
        return allowed;
      },
      sendClient: () => {
        sends++;
        if (mode === 'send-threw') throw new Error('synthetic private');
        return Promise.reject(new Error('synthetic private'));
      },
    });
    f.connection.client(wire(create('invalid:private', [])));
    if (mode === 'revoked' || mode === 'authorization-threw') allowed = false;
    await flush();
    assert.equal(sends, mode.startsWith('send-') ? 1 : 0, mode);
    assert.equal(f.closes(), 1, mode);
    assert.deepEqual(f.requests, [], mode);
    assert.deepEqual(f.events, [], mode);
    assert.deepEqual(
      f.connection.inspect(),
      { closed: true, active: 0, queued: 0, lanes: 0, queuedBytes: 0 },
      mode
    );
    f.connection.client(wire(create('main', [])));
    f.connection.upstream(wire({ type: 'error', error: { message: 'synthetic private' } }));
    await flush();
    assert.equal(f.closes(), 1, mode);
    assert.deepEqual(f.requests, [], mode);
  }
});

test('WS stream admission bounds held replies and drops queued replies after overflow', async (t) => {
  for (const held of [false, true]) {
    const replies = [],
      release = [];
    const f = connectionFixture(t, {
      sendClient: (event) => {
        replies.push(event);
        return new Promise((resolve) => release.push(resolve));
      },
    });
    for (let index = 0; index < 32; index++)
      f.connection.client(wire(create('invalid:private', [])));
    assert.deepEqual(f.connection.inspect(), {
      closed: false,
      active: 0,
      queued: 0,
      lanes: 0,
      queuedBytes: 0,
    });
    if (held) {
      await flush();
      assert.equal(replies.length, 32);
      assert.ok(
        replies.every(
          (event) =>
            event.error.code === 'invalid_stream_id' &&
            !Object.hasOwn(event, 'stream_id') &&
            !JSON.stringify(event).includes('private')
        )
      );
    }
    f.connection.client(wire(create('invalid:private', [])));
    assert.equal(f.closes(), 1);
    await flush();
    assert.equal(replies.length, held ? 32 : 0);
    for (const resolve of release) resolve();
    await flush();
    assert.deepEqual(f.requests, []);
    assert.equal(f.closes(), 1);
    assert.equal(f.connection.inspect().queuedBytes, 0);
  }
});

test('WS stream admission rejected IDs do not consume active lane or byte capacity', async (t) => {
  const f = connectionFixture(t);
  f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic' }])));
  await flush();
  const before = f.connection.inspect();
  assert.equal(before.active, 1);
  for (let index = 0; index < 40; index++) {
    f.connection.client(wire(create('invalid:private', [])));
    await flush();
    assert.deepEqual(f.connection.inspect(), before);
  }
  assert.equal(f.events.length, 40);
  assert.equal(f.requests.length, 1);
  assert.equal(f.closes(), 0);
  f.connection.upstream(
    wire({
      type: 'response.completed',
      stream_id: 'main',
      response: response('completed', [message('done')]),
    })
  );
  await flush();
  assert.equal(f.connection.inspect().active, 0);
  assert.equal(f.connection.inspect().queuedBytes, 0);
  assert.equal(f.events.at(-1).type, 'response.completed');
});

test('WS stream admission never translates malformed client data or invalid upstream IDs into recoverable errors', async (t) => {
  for (const mode of ['client-json', 'client-binary', 'upstream-id']) {
    const f = connectionFixture(t);
    if (mode === 'upstream-id') {
      f.connection.client(wire(create('main', [])));
      await flush();
      f.connection.upstream(
        wire({
          type: 'response.created',
          stream_id: 'invalid:private',
          response: { id: 'synthetic-private' },
        })
      );
    } else if (mode === 'client-json') f.connection.client(Buffer.from('{'));
    else f.connection.client(wire(create('invalid:private', [])), true);
    await flush();
    assert.equal(f.closes(), 1, mode);
    assert.deepEqual(f.events, [], mode);
    assert.equal(f.requests.length, mode === 'upstream-id' ? 1 : 0, mode);
    assert.equal(f.connection.inspect().active, 0, mode);
    assert.equal(f.connection.inspect().queuedBytes, 0, mode);
  }
});

test('invalid messages and unsupported control cannot start recovery or leak a late upstream event', async () => {
  let sent = 0,
    closed = 0;
  const connection = createRecoveryWebSocketConnection({
    runtime: {},
    auth: {},
    prepared: {},
    authorized: () => true,
    sendClient: async () => {
      sent++;
    },
    sendUpstream: async () => {
      sent++;
    },
    close: () => {
      closed++;
    },
  });
  connection.client(wire({ type: 'response.cancel', stream_id: 'main' }));
  connection.upstream(
    wire({ type: 'response.completed', response: response('late', [message('private')]) })
  );
  assert.equal(closed, 1);
  assert.equal(sent, 0);
  assert.equal(connection.inspect().closed, true);
});

function connectionFixture(t, options = {}) {
  const sessions = options.runtime ?? createContextRecoverySessions();
  sessions.configure(true);
  const requests = [],
    events = [];
  let closes = 0;
  const connection = createRecoveryWebSocketConnection({
    runtime: sessions,
    auth: { ok: true, enabled: true, key: { id: 'synthetic' } },
    prepared: {
      profile: { id: 'synthetic', targetUrl: 'https://api.openai.com/v1', protocol: 'openai' },
    },
    authorized: options.authorized ?? (() => true),
    timeoutMs: options.timeoutMs ?? 60000,
    sendClient:
      options.sendClient ??
      (async (event) => {
        events.push(event);
      }),
    sendUpstream:
      options.sendUpstream ??
      (async (event) => {
        requests.push(event);
      }),
    close: () => {
      closes++;
    },
  });
  t.after(async () => {
    connection.close();
    await flush();
    await sessions.shutdownAsync();
  });
  return { connection, requests, events, sessions, closes: () => closes };
}

test('WS admission contention and unavailable durable state never dispatch an incomplete continuation', async (t) => {
  for (const code of [
    'context_recovery_busy',
    'context_recovery_storage_unavailable',
    'context_recovery_binding_changed',
  ]) {
    const runtime = createContextRecoverySessions();
    runtime.beginAsync = async () => ({ ok: false, code });
    const f = connectionFixture(t, { runtime });
    f.connection.client(
      wire(
        create(
          'main',
          [{ type: 'function_call_output', call_id: 'external-pending', output: 'synthetic' }],
          'mixed-parent'
        )
      )
    );
    for (let index = 0; index < 50 && !f.requests.length && !f.closes(); index++) await flush();
    assert.equal(f.requests.length, 0, code);
    assert.equal(f.closes(), 1, code);
    assert.equal(JSON.stringify(f.events).includes('synthetic'), false);
  }
});

test('WS serializes only admission and cancels queued admission without serializing model responses', async (t) => {
  for (const mode of ['concurrent-responses', 'closed', 'revoked']) {
    const runtime = createContextRecoverySessions();
    const original = runtime.beginAsync;
    let release,
      entered = 0,
      allowed = true;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    runtime.beginAsync = async (...args) => {
      entered++;
      if (entered === 1) await pending;
      return original(...args);
    };
    const f = connectionFixture(t, { runtime, authorized: () => allowed });
    f.connection.client(wire(create('first', [{ role: 'user', content: 'synthetic-one' }])));
    f.connection.client(wire(create('second', [{ role: 'user', content: 'synthetic-two' }])));
    await flush();
    assert.equal(entered, 1);
    assert.equal(f.requests.length, 0);
    if (mode === 'closed') f.connection.close();
    if (mode === 'revoked') allowed = false;
    release();
    for (
      let index = 0;
      index < 50 && (mode === 'concurrent-responses' ? f.requests.length < 2 : !f.closes());
      index++
    )
      await flush();
    if (mode === 'concurrent-responses') {
      assert.equal(entered, 2);
      assert.equal(f.requests.length, 2);
      assert.equal(f.connection.inspect().active, 2);
      assert.equal(f.closes(), 0);
    } else {
      assert.equal(entered, 1);
      assert.equal(f.requests.length, 0);
      assert.equal(f.closes(), 1);
    }
  }
});

test(
  'real WS ordinary progress reaches the client before the provider completes, without duplicate events',
  { timeout: 10000 },
  async (t) => {
    let finish;
    const f = await fixture(t, (body, socket) => {
      const start = { ...response('live', []), status: 'in_progress', usage: null };
      socket.send(
        JSON.stringify({
          type: 'response.created',
          stream_id: body.stream_id,
          sequence_number: 0,
          response_id: 'live',
          response: start,
        })
      );
      socket.send(
        JSON.stringify({
          type: 'response.output_text.delta',
          stream_id: body.stream_id,
          sequence_number: 1,
          response_id: 'live',
          item_id: 'msg_live',
          output_index: 0,
          content_index: 0,
          delta: 'live',
        })
      );
      finish = () =>
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            stream_id: body.stream_id,
            sequence_number: 2,
            response_id: 'live',
            response: response('live', [message('live')]),
          })
        );
    });
    const progress = f.next('response.output_text.delta');
    f.client.send(JSON.stringify(create('main', [{ role: 'user', content: 'synthetic' }])));
    assert.equal((await progress).delta, 'live');
    assert.deepEqual(
      f.events.map((event) => event.type),
      ['response.created', 'response.output_text.delta']
    );
    assert.equal(f.sessions.inspect().snapshots, 0);
    const completed = f.next();
    finish();
    assert.equal((await completed).response.id, 'live');
    assert.deepEqual(
      f.events.map((event) => event.sequence_number),
      [0, 1, 2]
    );
  }
);

test(
  'real WS conflicting response identities cannot publish a terminal response or grant history',
  { timeout: 10000 },
  async (t) => {
    let fail;
    const f = await fixture(t, (body, socket) => {
      socket.send(
        JSON.stringify({
          type: 'response.created',
          stream_id: body.stream_id,
          sequence_number: 0,
          response_id: 'visible',
          response: { ...response('visible', []), status: 'in_progress' },
        })
      );
      fail = () =>
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            stream_id: body.stream_id,
            sequence_number: 1,
            response_id: 'visible',
            response: response('different', [message('must-not-publish')]),
          })
        );
    });
    const created = f.next('response.created');
    f.client.send(
      JSON.stringify(create('main', [{ role: 'user', content: 'synthetic identity' }]))
    );
    assert.equal((await created).response.id, 'visible');
    const closed = once(f.client, 'close');
    fail();
    await closed;
    assert.deepEqual(
      f.events.map((event) => event.type),
      ['response.created']
    );
    assert.equal(f.sessions.inspect().snapshots, 0);
    assert.equal(JSON.stringify(f.events).includes('must-not-publish'), false);
  }
);

test('ordinary WS progress never grants terminal history before publication acknowledgement', async (t) => {
  for (const mode of ['acknowledged', 'invalid-ack', 'revoked']) {
    await t.test(mode, async (t) => {
      const runtime = createContextRecoverySessions();
      const begin = runtime.beginAsync;
      let release,
        entered,
        allowed = true;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const preparing = new Promise((resolve) => {
        entered = resolve;
      });
      t.mock.method(runtime, 'beginAsync', async function (...args) {
        const session = await begin.apply(this, args);
        assert.equal(session.ok, true);
        const complete = session.completePublicAsync;
        session.completePublicAsync = async (...values) => {
          entered();
          await gate;
          if (mode === 'invalid-ack') return { ok: false };
          return complete.apply(session, values);
        };
        return session;
      });
      const f = connectionFixture(t, { runtime, authorized: () => allowed });
      try {
        f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic' }])));
        await flush();
        const created = {
          type: 'response.created',
          stream_id: 'main',
          response: { id: 'live', status: 'in_progress', output: [] },
        };
        f.connection.upstream(wire(created));
        await flush();
        assert.deepEqual(JSON.parse(JSON.stringify(f.events)), [created]);
        f.connection.upstream(
          wire({
            type: 'response.completed',
            stream_id: 'main',
            response: response('live', [message('done')]),
          })
        );
        await preparing;
        assert.equal(f.events.length, 1);
        assert.equal(runtime.inspect().snapshots, 0);
        if (mode === 'revoked') allowed = false;
        release();
        for (let index = 0; index < 20 && f.connection.inspect().active; index++) await flush();
        assert.equal(f.connection.inspect().active, 0);
        assert.equal(f.events.length, mode === 'acknowledged' ? 2 : 1);
        assert.equal(f.closes(), mode === 'acknowledged' ? 0 : 1);
        assert.equal(runtime.inspect().snapshots, mode === 'acknowledged' ? 1 : 0);
      } finally {
        release();
      }
    });
  }
});

test('ordinary WS progress preserves send ordering, cancellation and per-dispatch limits', async (t) => {
  for (const mode of ['ordered', 'close', 'send-rejected', 'event-limit', 'revoked']) {
    await t.test(mode, async (t) => {
      let release,
        entered,
        allowed = true;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const sending = new Promise((resolve) => {
        entered = resolve;
      });
      const sent = [];
      const f = connectionFixture(t, {
        authorized: () => allowed,
        sendClient: async (event) => {
          if (!sent.length) {
            entered();
            await gate;
            if (mode === 'send-rejected') throw new Error('Synthetic send rejected');
          }
          sent.push(event);
        },
      });
      try {
        f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic' }])));
        await flush();
        f.connection.upstream(
          wire({
            type: 'response.created',
            stream_id: 'main',
            sequence_number: 0,
            response: { id: 'live' },
          })
        );
        await sending;
        f.connection.upstream(
          wire({
            type: 'response.output_text.delta',
            stream_id: 'main',
            sequence_number: 1,
            response_id: 'live',
            delta: 'synthetic',
          })
        );
        if (mode === 'event-limit') {
          for (let index = 2; index <= 4096; index++)
            f.connection.upstream(
              wire({
                type: 'response.in_progress',
                stream_id: 'main',
                sequence_number: index,
                response_id: 'live',
              })
            );
        } else if (mode === 'close') f.connection.close();
        else {
          if (mode === 'revoked') allowed = false;
          f.connection.upstream(
            wire({
              type: 'response.completed',
              stream_id: 'main',
              sequence_number: 2,
              response: response('live', [message('done')]),
            })
          );
        }
        await flush();
        assert.deepEqual(sent, []);
        assert.equal(f.requests.length, 1);
        release();
        await flush();
        for (let index = 0; index < 20 && f.connection.inspect().active; index++) await flush();
        assert.equal(f.connection.inspect().active, 0);
        assert.equal(f.connection.inspect().queuedBytes, 0);
        assert.equal(f.closes(), mode === 'ordered' ? 0 : 1);
        // An already invoked transport can acknowledge after close. Queued
        // deltas and terminal events must never be invoked after cancellation.
        assert.deepEqual(
          sent.map((event) => event.type),
          mode === 'ordered'
            ? ['response.created', 'response.output_text.delta', 'response.completed']
            : mode === 'send-rejected'
              ? []
              : ['response.created']
        );
        assert.equal(f.sessions.inspect().snapshots, mode === 'ordered' ? 1 : 0);
      } finally {
        release();
      }
    });
  }
});

test('ordinary WS errors wait for abort acknowledgement and cannot bypass revocation or failed publication', async (t) => {
  for (const mode of ['acknowledged', 'abort-rejected', 'revoked', 'send-rejected']) {
    await t.test(mode, async (t) => {
      const runtime = createContextRecoverySessions();
      const original = runtime.beginAsync;
      let release, entered;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const aborting = new Promise((resolve) => {
        entered = resolve;
      });
      t.mock.method(runtime, 'beginAsync', async function (...args) {
        const session = await original.apply(this, args);
        assert.equal(session.ok, true);
        const abort = session.abortAsync;
        session.abortAsync = async () => {
          entered();
          await gate;
          if (mode === 'abort-rejected') throw new Error('Synthetic private abort failure');
          return abort.call(session);
        };
        return session;
      });
      let allowed = true;
      const f = connectionFixture(t, {
        runtime,
        authorized: () => allowed,
        ...(mode === 'send-rejected'
          ? {
              sendClient: async () => {
                throw new Error('Synthetic private transport failure');
              },
            }
          : {}),
      });
      try {
        f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic' }])));
        await flush();
        assert.equal(f.requests.length, 1);
        const failure = { type: 'error', stream_id: 'main', error: { code: 'synthetic_failure' } };
        f.connection.upstream(wire(failure));
        await aborting;
        assert.deepEqual(f.events, []);
        if (mode === 'revoked') allowed = false;
        release();
        for (let index = 0; index < 20 && f.connection.inspect().active; index++) await flush();
        assert.equal(f.connection.inspect().active, 0);
        assert.equal(f.closes(), mode === 'acknowledged' ? 0 : 1);
        assert.deepEqual(
          JSON.parse(JSON.stringify(f.events)),
          mode === 'acknowledged' ? [failure] : []
        );
        assert.equal(f.sessions.inspect().snapshots, 0);
        assert.equal(f.requests.length, 1);
      } finally {
        release();
      }
    });
  }
});

test(
  'an unadvertised external call in a private WS response stays hidden and is never replayed',
  { timeout: 10000 },
  async (t) => {
    let rounds = 0;
    const f = await fixture(t, (body, socket) => {
      rounds++;
      if (rounds === 3) {
        assert.equal(body.previous_response_id, 'mixed2');
        assert.deepEqual(
          body.input.map((item) => item.call_id),
          ['private-list', 'lookup2']
        );
        socket.send(
          JSON.stringify({
            type: 'error',
            stream_id: 'main',
            error: { code: 'synthetic_failure', message: 'private-marker-' + LIST },
          })
        );
        return;
      }
      const output =
        rounds === 1
          ? [call('lookup1', 'lookup')]
          : [call('private-list', LIST), call('lookup2', 'lookup')];
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          stream_id: 'main',
          response: response('mixed' + rounds, output),
        })
      );
    });
    const completed = f.next();
    f.client.send(
      JSON.stringify(create('main', [{ role: 'user', content: 'synthetic question' }]))
    );
    assert.equal((await completed).response.id, 'mixed1');
    const closed = once(f.client, 'close');
    f.client.send(
      JSON.stringify(
        create(
          'main',
          [
            {
              type: 'function_call_output',
              call_id: 'lookup1',
              output: 'synthetic retained evidence',
            },
          ],
          'mixed1'
        )
      )
    );
    await closed;
    assert.equal(rounds, 2);
    assert.equal(f.events.filter((event) => event.type === 'response.completed').length, 1);
    assert.equal(JSON.stringify(f.events).includes('private-marker'), false);
    assert.equal(JSON.stringify(f.events).includes(LIST), false);
  }
);

test('a fork refuses unfinished public ancestry and never uses withdrawn history', async (t) => {
  for (const valid of [true, false]) {
    const runtime = createContextRecoverySessions();
    const begin = runtime.beginAsync;
    let release, entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const finishing = new Promise((resolve) => {
      entered = resolve;
    });
    t.mock.method(runtime, 'beginAsync', async function (...args) {
      const session = await begin.apply(this, args);
      if (args[0].previousResponseId === 'r1' && session.ok) {
        const finish = session.finishPublicationAsync;
        session.finishPublicationAsync = async () => {
          entered();
          await gate;
          if (!valid) throw new Error('Synthetic publication uncertainty');
          return finish.call(session);
        };
      }
      return session;
    });
    const f = connectionFixture(t, { runtime });
    try {
      f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic' }])));
      await flush();
      f.connection.upstream(
        wire({
          type: 'response.completed',
          stream_id: 'main',
          response: response('r1', [call('lookup1', 'lookup')]),
        })
      );
      await flush();
      f.connection.client(
        wire(
          create(
            'main',
            [{ type: 'function_call_output', call_id: 'lookup1', output: 'original' }],
            'r1'
          )
        )
      );
      await flush();
      f.connection.upstream(
        wire({
          type: 'response.completed',
          stream_id: 'main',
          response: response('private-draft', [message('private-draft')]),
        })
      );
      await flush();
      assert.equal(f.requests.length, 3);
      assert.equal(f.requests[2].previous_response_id, 'r1');
      assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2].tools)), create('main', []).tools);
      f.connection.upstream(
        wire({
          type: 'response.completed',
          stream_id: 'main',
          response: response('r2', [call('lookup2', 'lookup')]),
        })
      );
      await finishing;
      f.connection.client(
        wire(
          create(
            'fork',
            [{ type: 'function_call_output', call_id: 'lookup2', output: 'external result' }],
            'r2'
          )
        )
      );
      await flush();
      assert.equal(f.requests.length, 3);
      assert.equal(f.connection.inspect().queued, 0);
      assert.equal(f.events.at(-1).error.code, 'previous_response_not_found');
      release();
      await flush();
      if (valid)
        f.connection.client(
          wire(
            create(
              'fork',
              [{ type: 'function_call_output', call_id: 'lookup2', output: 'external result' }],
              'r2'
            )
          )
        );
      for (let index = 0; index < 10 && f.requests.length === 3 && !f.closes(); index++)
        await flush();
      if (valid) {
        assert.equal(f.requests.length, 4);
        assert.equal(f.requests[3].stream_id, 'fork');
        assert.equal(f.requests[3].previous_response_id, 'r2');
        assert.deepEqual(
          f.requests[3].input.map((item) => item.call_id),
          ['lookup2']
        );
        f.connection.upstream(
          wire({
            type: 'response.completed',
            stream_id: 'fork',
            response: response('r3', [message('done')]),
          })
        );
        await flush();
        assert.equal(f.requests.length, 5);
        assert.equal(f.requests[4].previous_response_id, 'r2');
        f.connection.upstream(
          wire({
            type: 'response.completed',
            stream_id: 'fork',
            response: response('r4', [message('done')]),
          })
        );
        await flush();
        assert.equal(f.closes(), 0);
      } else {
        assert.equal(f.requests.length, 3);
        assert.equal(f.closes(), 1);
        assert.equal(f.connection.inspect().queued, 0);
      }
      assert.equal(
        f.events.some((event) => JSON.stringify(event).includes(LIST)),
        false
      );
    } finally {
      release();
      f.connection.close();
    }
  }
});

test('WS response identity validates both event fields before progress or terminal publication', async (t) => {
  const invalid = [
    {
      type: 'response.completed',
      response_id: 'r1',
      response: response('other', [message('done')]),
    },
    { type: 'response.created', response_id: 'r1', response: { id: 'other' } },
    { type: 'response.in_progress', response_id: 'r1', response: { id: '' } },
    { type: 'response.in_progress', response_id: 'r1', response: { id: 'x'.repeat(257) } },
    { type: 'response.in_progress', response_id: 'r1', response: { id: 1 } },
    { type: 'response.in_progress', response_id: 'r1', response: { id: null } },
    { type: 'response.in_progress', response_id: null, response: { id: 'r1' } },
  ];
  for (const output of invalid) {
    const f = connectionFixture(t);
    f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic identity' }])));
    await flush();
    f.connection.upstream(
      wire({
        type: 'response.created',
        stream_id: 'main',
        sequence_number: 0,
        response: { id: 'r1' },
      })
    );
    await flush();
    assert.equal(f.events.length, 1);
    f.connection.upstream(wire({ ...output, stream_id: 'main', sequence_number: 1 }));
    await flush();
    assert.equal(f.closes(), 1, 'conflicting or malformed identity must close before publication');
    assert.equal(f.events.length, 1);
    assert.equal(f.sessions.inspect().snapshots, 0);
    assert.equal(f.connection.inspect().active, 0);
    assert.equal(f.requests.length, 1, 'identity failure must not replay the request');
  }
});

test('WS matching event and embedded response identities preserve normal progress and one publication', async (t) => {
  const f = connectionFixture(t);
  f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic identity' }])));
  await flush();
  f.connection.upstream(
    wire({
      type: 'response.created',
      stream_id: 'main',
      sequence_number: 0,
      response_id: 'r1',
      response: { id: 'r1' },
    })
  );
  await flush();
  f.connection.upstream(
    wire({ type: 'response.in_progress', stream_id: 'main', sequence_number: 1, response_id: 'r1' })
  );
  await flush();
  f.connection.upstream(
    wire({
      type: 'response.completed',
      stream_id: 'main',
      sequence_number: 2,
      response_id: 'r1',
      response: response('r1', [message('done')]),
    })
  );
  await flush();
  assert.equal(f.closes(), 0);
  assert.deepEqual(
    f.events.map((event) => event.sequence_number),
    [0, 1, 2]
  );
  assert.equal(f.sessions.inspect().snapshots, 1);
  assert.equal(f.requests.length, 1);
});

test('WS failure paths fence response identity, ordering, binary data and message budgets', async (t) => {
  for (const mode of ['id', 'sequence', 'binary', 'size', 'unknown-lane', 'malformed']) {
    const f = connectionFixture(t);
    f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic' }])));
    await flush();
    assert.equal(f.requests.length, 1);
    f.connection.upstream(
      wire({
        type: 'response.created',
        stream_id: 'main',
        sequence_number: 1,
        response: { id: 'r1' },
      })
    );
    if (mode === 'id')
      f.connection.upstream(
        wire({
          type: 'response.completed',
          stream_id: 'main',
          response: response('other', [message('done')]),
        })
      );
    if (mode === 'sequence')
      f.connection.upstream(
        wire({ type: 'response.in_progress', stream_id: 'main', sequence_number: 1 })
      );
    if (mode === 'binary') f.connection.upstream(Buffer.from('binary'), true);
    if (mode === 'size') f.connection.upstream(Buffer.alloc(2 * 1024 * 1024 + 1));
    if (mode === 'unknown-lane')
      f.connection.upstream(
        wire({
          type: 'response.completed',
          stream_id: 'other',
          response: response('r1', [message('done')]),
        })
      );
    if (mode === 'malformed') f.connection.upstream(Buffer.from('{'));
    await flush();
    assert.equal(f.closes(), 1);
    assert.deepEqual(f.events, []);
    assert.equal(f.connection.inspect().active, 0);
  }
});

test('WS transport rejection, timeout, policy revocation and close during send release active ownership', async (t) => {
  for (const mode of ['dispatch', 'send', 'timeout', 'revoked', 'held-send']) {
    let allowed = true,
      entered;
    const sending = new Promise((resolve) => {
      entered = resolve;
    });
    const options = { authorized: () => allowed };
    if (mode === 'dispatch')
      options.sendUpstream = async () => {
        throw new Error('synthetic private');
      };
    if (mode === 'send')
      options.sendClient = async () => {
        throw new Error('synthetic private');
      };
    if (mode === 'timeout') options.timeoutMs = 10;
    if (mode === 'held-send')
      options.sendClient = () => {
        entered();
        return new Promise(() => {});
      };
    const f = connectionFixture(t, options);
    f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic' }])));
    await flush();
    if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 30));
    else if (mode !== 'dispatch') {
      if (mode === 'revoked') allowed = false;
      f.connection.upstream(
        wire({
          type: 'response.completed',
          stream_id: 'main',
          response: response('r1', [message('done')]),
        })
      );
      if (mode === 'held-send') {
        await sending;
        f.connection.close();
      }
    }
    await flush();
    await flush();
    assert.equal(f.closes(), 1, mode);
    assert.equal(f.connection.inspect().active, 0, mode);
    assert.deepEqual(f.events, [], mode);
  }
});

test('WS admission bounds active responses and queued request bytes', async (t) => {
  const f = connectionFixture(t);
  for (let index = 0; index < 17; index++)
    f.connection.client(
      wire(create('lane' + index, [{ role: 'user', content: 'synthetic ' + index }]))
    );
  await flush();
  assert.equal(f.connection.inspect().active, 16);
  assert.equal(f.connection.inspect().queued, 1);
  for (let index = 17; index < 32; index++)
    f.connection.client(
      wire(create('lane' + index, [{ role: 'user', content: 'synthetic ' + index }]))
    );
  assert.equal(f.connection.inspect().active, 16);
  assert.equal(f.connection.inspect().queued, 16);
  assert.equal(f.connection.inspect().lanes, 32);
  assert.equal(f.closes(), 0);
  // Overflow the request budget on an existing lane, independently of named-stream admission.
  f.connection.client(wire(create('lane0', [{ role: 'user', content: 'synthetic overflow' }])));
  await flush();
  assert.equal(f.closes(), 1);
  assert.equal(f.connection.inspect().queuedBytes, 0);
  const large = connectionFixture(t);
  for (let index = 0; index < 3; index++)
    large.connection.client(wire(create('main', [{ role: 'user', content: 'x'.repeat(800000) }])));
  await flush();
  assert.equal(large.closes(), 1);
  assert.equal(large.connection.inspect().queuedBytes, 0);
});

test('entry profile restrictions reject WS before credential resolution or connection', async (t) => {
  let calls = 0;
  t.mock.method(http, 'request', () => {
    calls++;
    throw new Error('No synthetic network expected');
  });
  const handler = createWebSocketProxy({
    getConfig: () => ({
      entryAuth: {
        enabled: true,
        keys: [
          { id: 'owner', key: 'synthetic-entry', enabled: true, allowedProfileIds: ['allowed'] },
        ],
      },
    }),
    getActiveProfile: () => ({ id: 'forbidden', targetUrl: 'http://127.0.0.1:1/v1' }),
    resolveOfficialCredentials: async () => {
      calls++;
    },
  });
  let reply = '';
  await handler(
    { url: '/v1/responses', headers: { authorization: 'Bearer synthetic-entry' } },
    {
      end: (text) => {
        reply = text;
      },
    },
    Buffer.alloc(0),
    {}
  );
  assert.match(reply, /^HTTP\/1.1 403 /);
  assert.equal(calls, 0);
});

test('WS publication waits for actual SQLite write acknowledgement and rejects an invalid ACK', async (t) => {
  for (const valid of [true, false]) {
    const database = new DatabaseSync(':memory:');
    const store = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
      now: () => 100,
    });
    const runtime = createContextRecoverySessions({ now: () => 100 });
    let release, written;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const saved = new Promise((resolve) => {
      written = resolve;
    });
    let held = false;
    attachContextRecoveryStorage(runtime, {
      execute(command) {
        const value = store.execute(command);
        if (command.operation === 'save' && !held) {
          held = true;
          written();
          return gate.then(() => (valid ? value : { revision: 0 }));
        }
        return value;
      },
    });
    const f = connectionFixture(t, { runtime });
    try {
      f.connection.client(wire(create('main', [{ role: 'user', content: 'synthetic' }])));
      await flush();
      assert.equal(f.requests.length, 1);
      f.connection.upstream(
        wire({
          type: 'response.completed',
          stream_id: 'main',
          response: response('r1', [message('done')]),
        })
      );
      await saved;
      assert.deepEqual(f.events, []);
      assert.equal(store.execute({ operation: 'inspect' }).records, 1);
      release();
      for (let index = 0; index < 10 && f.connection.inspect().active; index++) await flush();
      if (valid) {
        assert.equal(f.events.length, 1);
        assert.equal(f.closes(), 0);
      } else {
        assert.deepEqual(f.events, []);
        assert.equal(f.closes(), 1);
      }
    } finally {
      release();
      f.connection.close();
      await flush();
      await runtime.shutdownAsync();
      store.close();
      database.close();
    }
  }
});

test(
  'an actual new WS connection supplies a full public window and keeps private recovery outside the public window',
  { timeout: 15000 },
  async (t) => {
    let rounds = 0;
    const firstInput = [{ role: 'user', content: 'full-window task' }];
    const firstResult = {
      type: 'function_call_output',
      call_id: 'full-external-first',
      output: 'original🙂\r\nexact',
    };
    const secondResult = {
      type: 'function_call_output',
      call_id: 'full-external-next',
      output: 'external-done',
    };
    const f = await fixture(t, (event, socket) => {
      rounds++;
      let output;
      if (rounds === 1) output = [call('full-external-first', 'lookup')];
      else if (rounds === 2) {
        assert.equal(event.previous_response_id, 'full-first');
        assert.deepEqual(event.input, [firstResult]);
        output = [message('full-private-draft')];
      } else if (rounds === 3) {
        assert.equal(event.previous_response_id, 'full-first');
        assert.doesNotMatch(JSON.stringify(event.input), /full-private-draft/);
        output = [call('full-external-next', 'lookup')];
      } else {
        assert.ok(rounds === 4 || rounds === 5);
        assert.equal(event.previous_response_id, undefined);
        assert.deepEqual(event.input.slice(0, 3), [
          ...firstInput,
          call('full-external-first', 'lookup'),
          firstResult,
        ]);
        assert.deepEqual(event.input.slice(3), [
          call('full-external-next', 'lookup'),
          secondResult,
        ]);
        assert.doesNotMatch(JSON.stringify(event.input), /full-private/);
        output = [message(rounds === 4 ? 'full-private-draft' : 'full-reconnected')];
      }
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          stream_id: event.stream_id,
          response: response(
            rounds === 1
              ? 'full-first'
              : rounds === 3
                ? 'full-mixed'
                : rounds === 5
                  ? 'full-final'
                  : 'private-' + rounds,
            output
          ),
        })
      );
    });
    const first = f.next();
    f.client.send(JSON.stringify(create('main', firstInput)));
    const firstPublished = await first;
    const mixed = f.next();
    f.client.send(JSON.stringify(create('main', [firstResult], 'full-first')));
    const mixedPublished = await mixed;
    const history = [
      ...firstInput,
      ...firstPublished.response.output,
      firstResult,
      ...mixedPublished.response.output,
      secondResult,
    ];
    f.client.close();
    await once(f.client, 'close');
    const next = new WebSocket(f.client.url, {
      headers: { authorization: 'Bearer synthetic-entry' },
    });
    t.after(() => next.terminate());
    const events = [];
    const completed = new Promise((resolve, reject) => {
      next.on('message', (data) => {
        const event = JSON.parse(data.toString());
        events.push(event);
        if (event.type === 'response.completed') resolve(event);
      });
      next.on('error', reject);
      next.on('close', () => reject(new Error('Synthetic full-window connection closed')));
    });
    await once(next, 'open');
    next.send(JSON.stringify(create('new', history)));
    assert.equal((await completed).response.id, 'full-final');
    assert.equal(rounds, 5);
    assert.doesNotMatch(
      JSON.stringify(events),
      /full-private|hpm_list_retained_evidence|original🙂/
    );
    next.close();
    await once(next, 'close');
  }
);

test(
  'actual reconnect cache miss emits a safe lane error and a bounded test client retries its full window without tool replay',
  { timeout: 15000 },
  async (t) => {
    const input = [{ role: 'user', content: 'cache recovery task' }];
    const original = {
      type: 'function_call_output',
      call_id: 'cache-external-first',
      output: 'cache-original🙂\r\n',
    };
    const external = {
      type: 'function_call_output',
      call_id: 'cache-external-next',
      output: 'external-once',
    };
    let requests = 0,
      misses = 0,
      fullRetries = 0,
      parallelSocket;
    const f = await fixture(t, (event, socket) => {
      requests++;
      if (event.stream_id === 'parallel') {
        parallelSocket = socket;
        return;
      }
      let id, output;
      if (requests === 1) {
        id = 'cache-first';
        output = [call('cache-external-first', 'lookup')];
      } else if (event.previous_response_id === 'cache-first') {
        id = 'cache-mixed';
        if (event.tools.some((tool) => tool.name === LIST)) {
          id = 'cache-private-result';
          output = [message('private-draft')];
        } else {
          assert.doesNotMatch(JSON.stringify(event.input), /private-draft/);
          output = [call('cache-external-next', 'lookup')];
        }
      } else if (event.previous_response_id === 'cache-mixed') {
        misses++;
        socket.send(
          JSON.stringify({
            type: 'error',
            status: 400,
            stream_id: event.stream_id,
            error: {
              type: 'invalid_request_error',
              code: 'previous_response_not_found',
              param: 'previous_response_id',
              message: 'private-upstream-response cache-private cache-original raw-auth-marker',
              internal: 'private-upstream-only',
            },
          })
        );
        assert.ok(parallelSocket);
        parallelSocket.send(
          JSON.stringify({
            type: 'response.completed',
            stream_id: 'parallel',
            response: response('parallel-done', [message('parallel')]),
          })
        );
        return;
      } else {
        if (event.tools.some((tool) => tool.name === LIST)) fullRetries++;
        assert.equal(event.previous_response_id, undefined);
        assert.deepEqual(event.input.slice(0, 3), [
          ...input,
          call('cache-external-first', 'lookup'),
          original,
        ]);
        assert.deepEqual(event.input.slice(3), [call('cache-external-next', 'lookup'), external]);
        assert.doesNotMatch(JSON.stringify(event.input), /cache-private|private-draft/);
        const internal = event.tools.some((tool) => tool.name === LIST);
        id = internal ? 'cache-restored-private' : 'cache-final';
        output = [message(internal ? 'private-draft' : 'recovered')];
      }
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          stream_id: event.stream_id,
          response: response(id, output),
        })
      );
    });
    const first = f.next();
    f.client.send(JSON.stringify(create('main', input)));
    const firstPublished = await first;
    const mixed = f.next();
    f.client.send(JSON.stringify(create('main', [original], 'cache-first')));
    const mixedPublished = await mixed;
    const history = [
      ...input,
      ...firstPublished.response.output,
      original,
      ...mixedPublished.response.output,
      external,
    ];
    f.client.close();
    await once(f.client, 'close');
    const next = new WebSocket(f.client.url, {
      headers: { authorization: 'Bearer synthetic-entry' },
    });
    t.after(() => next.terminate());
    const events = [];
    let errors = 0;
    const completed = new Promise((resolve, reject) => {
      next.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          events.push(event);
          if (event.type === 'error') {
            assert.equal(++errors, 1);
            assert.equal(event.stream_id, 'main');
            assert.equal(event.status, 400);
            assert.equal(event.error.code, 'previous_response_not_found');
            assert.equal(event.error.param, 'previous_response_id');
            assert.doesNotMatch(
              JSON.stringify(event),
              /private-upstream|cache-private|cache-original|raw-auth-marker/
            );
            next.send(JSON.stringify(create('main', history)));
          }
          if (
            events.some((item) => item.response?.id === 'cache-final') &&
            events.some((item) => item.response?.id === 'parallel-done')
          )
            resolve();
        } catch (error) {
          reject(error);
        }
      });
      next.on('error', reject);
      next.on('close', () => reject(new Error('Synthetic cache-miss connection closed')));
    });
    await once(next, 'open');
    next.send(JSON.stringify(create('parallel', [{ role: 'user', content: 'independent' }])));
    next.send(JSON.stringify(create('main', [external], 'cache-mixed')));
    await completed;
    assert.equal(requests, 7);
    assert.equal(misses, 1);
    assert.equal(fullRetries, 1);
    assert.equal(next.readyState, WebSocket.OPEN);
    assert.doesNotMatch(
      JSON.stringify(events),
      /cache-private|cache-original|raw-auth-marker|hpm_list_retained_evidence/
    );
    next.close();
    await once(next, 'close');
  }
);

test('cache-miss boundaries require exact bounded errors, real predecessors and clean event history without executing input', async () => {
  const request = { previous_response_id: 'public-parent' };
  const event = {
    type: 'error',
    status: 400,
    stream_id: 'main',
    error: { ...recoveryCacheMissBody().error, message: 'synthetic-private-id' },
  };
  const result = {
    statusCode: 200,
    stream: false,
    wire: wire({ error: event.error }),
    events: [event],
    eventCount: 1,
  };
  const matched = createRecoveryCacheMissBoundary(async () => result, 'websocket', 'main');
  assert.equal(await matched.dispatch(request), result);
  assert.equal(matched.matched(), true);
  await assert.rejects(matched.dispatch(request), /Recovery cache-miss boundary unavailable/);
  assert.equal(isRecoveryHttpCacheMiss(request, { ...result, statusCode: 400 }), true);
  let executed = 0;
  const getterResult = { ...result };
  Object.defineProperty(getterResult, 'wire', {
    get() {
      executed++;
      throw new Error('private');
    },
  });
  const getterError = { ...event.error };
  Object.defineProperty(getterError, 'code', {
    enumerable: true,
    get() {
      executed++;
      return 'previous_response_not_found';
    },
  });
  for (const [input, response] of [
    [request, null],
    [null, result],
    [{}, result],
    [{ previous_response_id: null }, result],
    [{ previous_response_id: 'x'.repeat(257) }, result],
    [Object.create(request), result],
    [request, getterResult],
    [request, { ...result, statusCode: 400 }],
    [request, { ...result, stream: true }],
    [request, { ...result, eventCount: 2 }],
    [request, { ...result, eventCount: undefined }],
    [request, { ...result, events: [event, event] }],
    [request, { ...result, events: [] }],
    [request, { ...result, events: [{ ...event, status: 500 }] }],
    [request, { ...result, events: [{ ...event, stream_id: 'other' }] }],
    [request, { ...result, events: [{ ...event, error: getterError }] }],
    [
      request,
      { ...result, events: [{ ...event, error: { ...event.error, message: 'different' } }] },
    ],
    [request, { ...result, wire: Buffer.from([255]) }],
    [request, { ...result, wire: Buffer.from('{') }],
    [request, { ...result, wire: Buffer.alloc(2 * 1024 * 1024 + 1) }],
    [
      request,
      { ...result, wire: wire({ error: { ...event.error, code: 'invalid_request_error' } }) },
    ],
    [request, { ...result, wire: wire({ error: { ...event.error, param: 'input' } }) }],
    [request, { ...result, wire: wire({ error: { ...event.error, type: 'other' } }) }],
    [request, { ...result, wire: wire({ error: { ...event.error, message: null } }) }],
    [request, { ...result, wire: wire({ error: event.error, output: [] }) }],
    [request, { ...result, encoding: 'gzip' }],
  ]) {
    const boundary = createRecoveryCacheMissBoundary(async () => response, 'websocket', 'main');
    await boundary.dispatch(input);
    assert.equal(boundary.matched(), false);
  }
  for (const response of [
    null,
    { ...result, statusCode: 200 },
    { ...result, statusCode: 400, wire: Buffer.from('{') },
  ])
    assert.equal(isRecoveryHttpCacheMiss(request, response), false);
  const getterRequest = {};
  Object.defineProperty(getterRequest, 'previous_response_id', {
    get() {
      executed++;
      return 'public-parent';
    },
  });
  assert.equal(isRecoveryHttpCacheMiss(getterRequest, { ...result, statusCode: 400 }), false);
  assert.equal(executed, 0);
  assert.deepEqual(recoveryCacheMissEvent(undefined), {
    type: 'error',
    status: 400,
    ...recoveryCacheMissBody(),
  });
  for (const id of [null, {}, '', 'bad:lane', 'x'.repeat(257)])
    assert.throws(() => recoveryCacheMissEvent(id));
  for (const args of [
    [null, 'http'],
    [() => {}, 'other'],
    [() => {}, 'http', 'main'],
    [() => {}, 'websocket', {}],
  ])
    assert.throws(() => createRecoveryCacheMissBoundary(...args));
});

test('WS cache-miss publication waits for cleanup and fails closed on revocation, close or failed delivery', async (t) => {
  for (const mode of ['acknowledged', 'abort-rejected', 'revoked', 'closed', 'send-rejected']) {
    await t.test(mode, async (t) => {
      const runtime = createContextRecoverySessions();
      let release, entered;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const aborting = new Promise((resolve) => {
        entered = resolve;
      });
      t.mock.method(runtime, 'beginAsync', async () => ({
        ok: true,
        inspect: () => ({ visibleSources: 0 }),
        abortAsync: async () => {
          entered();
          await gate;
          if (mode === 'abort-rejected') throw new Error('Synthetic private abort failure');
          return { ok: true };
        },
      }));
      let allowed = true;
      const f = connectionFixture(t, {
        runtime,
        authorized: () => allowed,
        ...(mode === 'send-rejected'
          ? {
              sendClient: async () => {
                throw new Error('Synthetic delivery failure');
              },
            }
          : {}),
      });
      try {
        f.connection.client(wire({ ...create('main', []), previous_response_id: 'public' }));
        await flush();
        assert.equal(f.requests.length, 1);
        f.connection.upstream(
          wire({
            type: 'error',
            status: 400,
            stream_id: 'main',
            error: {
              type: 'invalid_request_error',
              code: 'previous_response_not_found',
              param: 'previous_response_id',
              message: 'Synthetic private predecessor marker',
            },
          })
        );
        await aborting;
        assert.deepEqual(f.events, []);
        if (mode === 'revoked') allowed = false;
        if (mode === 'closed') f.connection.close();
        release();
        for (let index = 0; index < 20 && f.connection.inspect().active; index++) await flush();
        assert.equal(f.connection.inspect().active, 0);
        assert.deepEqual(
          JSON.parse(JSON.stringify(f.events)),
          mode === 'acknowledged' ? [recoveryCacheMissEvent('main')] : []
        );
        if (mode !== 'closed') assert.equal(f.closes(), mode === 'acknowledged' ? 0 : 1);
        assert.equal(f.requests.length, 1);
        assert.equal(f.sessions.inspect().snapshots, 0);
      } finally {
        release();
      }
    });
  }
});

test('cache-miss observation cannot retry, overlap or expose dispatch errors', async () => {
  let release;
  let calls = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const boundary = createRecoveryCacheMissBoundary(async () => {
    calls++;
    return held;
  }, 'http');
  const active = boundary.dispatch({ previous_response_id: 'public' });
  await assert.rejects(boundary.dispatch({}), /Recovery cache-miss boundary unavailable/);
  assert.equal(calls, 1);
  assert.equal(boundary.matched(), false);
  release({ statusCode: 400, stream: false, wire: wire(recoveryCacheMissBody()) });
  await active;
  assert.equal(boundary.matched(), true);
  await assert.rejects(boundary.dispatch({}), /Recovery cache-miss boundary unavailable/);
  const failed = createRecoveryCacheMissBoundary(async () => {
    throw new Error('private-dispatch-value');
  }, 'http');
  await assert.rejects(failed.dispatch({}), {
    message: 'Recovery cache-miss boundary unavailable',
  });
  assert.equal(failed.matched(), false);
  await assert.rejects(failed.dispatch({}), {
    message: 'Recovery cache-miss boundary unavailable',
  });
});

async function exerciseEncryptedWsReopen(t, history, fullWindow = false) {
  const initialTime = Date.now();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-pending-reopen-'));
  const databasePath = path.join(directory, 'checkpoint.sqlite');
  const dataKey = randomBytes(32).toString('base64');
  let database = new DatabaseSync(databasePath);
  let store = createRecoverySqliteStore({
    database,
    dataKey,
    now: () => initialTime,
  });
  const storage = { execute: (command) => store.execute(command) };
  const runtime = createContextRecoverySessions({ now: () => initialTime });
  attachContextRecoveryStorage(runtime, storage);
  const first = connectionFixture(t, { runtime });
  let restored;
  const settle = async (f) => {
    for (let index = 0; index < 50 && f.connection.inspect().active; index++) await flush();
    assert.equal(f.connection.inspect().active, 0);
    assert.equal(f.closes(), 0);
  };
  const dispatched = async (f) => {
    for (let index = 0; index < 50 && !f.requests.length; index++) await flush();
    assert.equal(f.requests.length, 1);
  };
  try {
    first.connection.client(wire(create('main', history)));
    await dispatched(first);
    assert.deepEqual(
      first.requests[0].input.map((item) => item.content),
      history.map((item) => item.content)
    );
    first.connection.upstream(
      wire({
        type: 'response.completed',
        stream_id: 'main',
        response: response('saved-first', [call('external-first', 'lookup')]),
      })
    );
    await settle(first);
    first.requests.length = 0;
    first.connection.client(
      wire(
        create(
          'main',
          [
            {
              type: 'function_call_output',
              call_id: 'external-first',
              output: 'encrypted-original🙂',
            },
          ],
          'saved-first'
        )
      )
    );
    await dispatched(first);
    first.connection.upstream(
      wire({
        type: 'response.completed',
        stream_id: 'main',
        response: response('saved-private', [message('private-draft')]),
      })
    );
    for (let index = 0; index < 50 && first.requests.length < 2; index++) await flush();
    assert.equal(first.requests.length, 2);
    assert.equal(first.requests[1].previous_response_id, 'saved-first');
    assert.doesNotMatch(JSON.stringify(first.requests[1].input), /saved-private|private-draft/);
    first.connection.upstream(
      wire({
        type: 'response.completed',
        stream_id: 'main',
        response: response('saved-public', [call('external-next', 'lookup')]),
      })
    );
    await settle(first);
    assert.equal(first.events.filter((event) => event.type === 'response.completed').length, 2);
    assert.equal(JSON.stringify(first.events).includes(LIST), false);
    first.connection.close();
    assert.equal((await runtime.shutdownAsync()).ok, true);
    for (const row of database.prepare('SELECT envelope FROM recovery_state').all()) {
      assert.equal(Buffer.from(row.envelope).includes(Buffer.from('encrypted-original')), false);
      assert.equal(Buffer.from(row.envelope).includes(Buffer.from('private-list')), false);
    }
    store.close();
    database.close();
    database = new DatabaseSync(databasePath);
    store = createRecoverySqliteStore({ database, dataKey, now: () => initialTime });
    restored = createContextRecoverySessions({ now: () => initialTime });
    attachContextRecoveryStorage(restored, storage);
    const next = connectionFixture(t, { runtime: restored });
    assert.equal(restored.inspect().roots, 0);
    next.connection.client(
      wire(
        create(
          'new-connection',
          [
            ...(fullWindow
              ? [
                  ...history,
                  call('external-first', 'lookup'),
                  {
                    type: 'function_call_output',
                    call_id: 'external-first',
                    output: 'encrypted-original🙂',
                  },
                  call('external-next', 'lookup'),
                ]
              : []),
            {
              type: 'function_call_output',
              call_id: 'external-next',
              output: 'completed-external',
            },
          ],
          fullWindow ? undefined : 'saved-public'
        )
      )
    );
    await dispatched(next);
    assert.equal(restored.inspect().roots, 1);
    const sent = next.requests[0];
    assert.equal(sent.previous_response_id, fullWindow ? undefined : 'saved-public');
    if (fullWindow) {
      assert.deepEqual(
        sent.input.slice(0, history.length).map((item) => item.content),
        history.map((item) => item.content)
      );
      assert.deepEqual(
        sent.input
          .filter((item) => item.type === 'function_call_output')
          .map((item) => item.call_id),
        ['external-first', 'external-next']
      );
    } else
      assert.deepEqual(
        sent.input.map((item) => item.call_id),
        ['external-next']
      );
    assert.doesNotMatch(JSON.stringify(sent.input), /private-list|private-draft/);
    assert.equal(sent.input.at(-1).output, 'completed-external');
    next.connection.upstream(
      wire({
        type: 'response.completed',
        stream_id: 'new-connection',
        response: response('saved-private-final', [message('private-draft')]),
      })
    );
    for (let index = 0; index < 50 && next.requests.length < 2; index++) await flush();
    assert.equal(next.requests.length, 2);
    assert.equal(next.requests[1].previous_response_id, fullWindow ? undefined : 'saved-public');
    assert.doesNotMatch(JSON.stringify(next.requests[1].input), /private-draft|saved-private/);
    next.connection.upstream(
      wire({
        type: 'response.completed',
        stream_id: 'new-connection',
        response: response('saved-final', [message('done')]),
      })
    );
    await settle(next);
    assert.equal(next.requests.length, 2);
    assert.equal(JSON.stringify(next.events).includes(LIST), false);
    assert.equal(next.events.at(-1).response.id, 'saved-final');
  } finally {
    first.connection.close();
    await runtime.shutdownAsync();
    await restored?.shutdownAsync();
    store.close();
    database.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.equal(path.basename(resolved).startsWith('hpm-pending-reopen-'), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('a fresh WS owner restores encrypted public ancestry without rerunning external tools', async (t) => {
  await exerciseEncryptedWsReopen(t, [{ role: 'user', content: 'synthetic' }]);
});

test('a fresh WS owner restores encrypted long-history public ancestry after reopening SQLite', async (t) => {
  await exerciseEncryptedWsReopen(
    t,
    Array.from({ length: 3 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: String(index) + '原文🙂'.repeat(90000),
    }))
  );
});

test('a fresh WS owner rebuilds recovery from an encrypted full public history', async (t) => {
  await exerciseEncryptedWsReopen(
    t,
    Array.from({ length: 3 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: String(index) + '原文🙂'.repeat(90000),
    })),
    true
  );
});
