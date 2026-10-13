'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { EventEmitter } = require('node:events');
const {
  apiEvidenceKind,
  parseApiEvidenceCalls,
  parseApiEvidenceResults,
  decodeApiEvidenceResponse,
} = require('../lib/proxy/context-api-evidence-protocol');
const {
  createContextApiEvidenceRuntime,
  evidencePrincipal,
} = require('../lib/proxy/context-api-evidence-runtime');
const {
  installApiEvidenceResponseObserver,
} = require('../lib/proxy/context-api-evidence-observer');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const { redactHeaders, headersForReplay } = require('../lib/proxy/usage-report');
const { validateAppSettings } = require('../lib/proxy/validator');
const { installEntryCorsGuard } = require('../lib/proxy/entry-auth');

const auth = (id = 'owner-a') => ({
  ok: true,
  enabled: true,
  key: {
    id,
    key: undefined,
    allowedEntryProtocols: [],
    allowedEntryPorts: [],
    allowedProfileIds: [],
  },
});
const source = (id = 'call_1', args = { q: 'fresh' }) => ({
  callId: id,
  toolName: 'lookup',
  arguments: args,
  completed: true,
  output: '',
});
const json = (result) => JSON.parse(result.text);
const sse = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';
function response(kind, callId = 'call_1') {
  if (kind === 'chat')
    return {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                type: 'function',
                id: callId,
                function: { name: 'lookup', arguments: '{"q":"fresh"}' },
              },
            ],
          },
        },
      ],
    };
  if (kind === 'responses')
    return {
      status: 'completed',
      output: [
        { type: 'function_call', call_id: callId, name: 'lookup', arguments: '{"q":"fresh"}' },
        { type: 'compaction', encrypted_content: 'opaque-unchanged' },
      ],
    };
  return {
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: callId, name: 'lookup', input: { q: 'fresh' } }],
  };
}
function input(kind, output = '新证据✅', callId = 'call_1') {
  if (kind === 'chat')
    return { messages: [{ role: 'tool', tool_call_id: callId, content: output }] };
  if (kind === 'responses')
    return { input: [{ type: 'function_call_output', call_id: callId, output }] };
  return {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: output }] },
    ],
  };
}
function setup(options) {
  const runtime = createContextApiEvidenceRuntime(options);
  runtime.configure(true);
  const receipt = runtime.create(auth());
  assert.equal(receipt.ok, true);
  return { runtime, receipt, cap: runtime.bind(auth(), receipt.token) };
}

test('three protocols extract reported results and observed calls without modifying opaque/native input', () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const body = response(kind);
    const before = JSON.stringify(body);
    assert.deepEqual(
      parseApiEvidenceCalls(kind, body).map((call) => [call.callId, call.toolName]),
      [['call_1', 'lookup']]
    );
    assert.equal(JSON.stringify(body), before);
    assert.equal(parseApiEvidenceResults(kind, input(kind))[0].output, '新证据✅');
  }
  assert.equal(apiEvidenceKind('/v1/responses?x=1'), 'responses');
  for (const path of [
    null,
    1,
    '/v1/responses/compact',
    '/v1/messages/count_tokens',
    '/v1/responses/',
  ])
    assert.equal(apiEvidenceKind(path), null);
  assert.deepEqual(parseApiEvidenceCalls('unknown', {}), []);
  assert.deepEqual(parseApiEvidenceCalls('chat', { choices: [] }), []);
  assert.deepEqual(
    parseApiEvidenceCalls('responses', {
      status: 'incomplete',
      output: response('responses').output,
    }),
    []
  );
});

test('custom tools and structured reported outputs retain normalized data, never an asserted wire copy', () => {
  const calls = parseApiEvidenceCalls('responses', {
    status: 'completed',
    output: [
      { type: 'custom_tool_call', call_id: 'custom', name: 'custom_read', input: 'select data' },
    ],
  });
  assert.equal(calls[0].arguments.input, 'select data');
  const { runtime, cap } = setup();
  cap.observeCalls('responses', calls);
  cap.observeInput('responses', {
    input: [
      {
        type: 'custom_tool_call_output',
        call_id: 'custom',
        output: [{ type: 'text', text: 'résultat' }],
      },
    ],
  });
  const receipt = json(cap.reply(LIST, {})).sources[0];
  assert.deepEqual(JSON.parse(json(cap.reply(READ, receiptArguments(receipt))).page.text), [
    { type: 'text', text: 'résultat' },
  ]);
  runtime.close();
});
const receiptArguments = (receipt) => ({ sourceId: receipt.sourceId, digest: receipt.digest });

test('prospective capture ignores all unobserved history and labels results as client reported', () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const { runtime, cap } = setup();
    cap.observeInput(kind, input(kind, 'old-unobserved'));
    assert.equal(json(cap.reply(LIST, {})).sources.length, 0);
    cap.observeCalls(kind, parseApiEvidenceCalls(kind, response(kind)));
    cap.observeInput(kind, input(kind));
    const listed = json(cap.reply(LIST, {}));
    assert.equal(listed.sources.length, 1);
    assert.equal(listed.observation, 'client_reported');
    assert.equal(listed.verification, 'not_verified');
    assert.equal(json(cap.reply(READ, receiptArguments(listed.sources[0]))).page.text, '新证据✅');
    cap.observeInput(kind, input(kind, 'conflicting-history'));
    assert.equal(runtime.inspect().captured, 1);
    runtime.close();
  }
});

test('entry identity is derived from validated public authorization, never credentials or arbitrary selectors', () => {
  assert.match(evidencePrincipal(auth()), /^[a-f0-9]{64}$/);
  assert.equal(evidencePrincipal({ ...auth(), enabled: false }), null);
  assert.equal(evidencePrincipal({ ...auth(), ok: false }), null);
  assert.equal(evidencePrincipal({ key: { id: 'bad id' }, ok: true, enabled: true }), null);
  let reads = 0;
  const malicious = {
    ...auth(),
    key: {
      id: 'a',
      get allowedProfileIds() {
        reads++;
        return [];
      },
    },
  };
  assert.equal(evidencePrincipal(malicious), null);
  assert.equal(reads, 0);
  const { runtime, receipt, cap } = setup();
  assert.equal(runtime.bind(auth('owner-b'), receipt.token), null);
  const changed = auth();
  changed.key.allowedProfileIds = ['new-only'];
  assert.equal(runtime.bind(changed, receipt.token), null);
  for (const token of [undefined, [], {}, receipt.token + 'x', 'hes_' + '0'.repeat(64)])
    assert.equal(runtime.bind(auth(), token), null);
  assert.equal(runtime.remove(auth('owner-b'), receipt.token), false);
  assert.equal(runtime.remove(auth(), receipt.token), true);
  assert.equal(cap.reply(LIST, {}).ok, false);
  assert.equal(runtime.bind(auth(), receipt.token), null);
});

test('session TTL is absolute, budgets are bounded and explicit deletion/disable invalidates existing capabilities', () => {
  let now = 1;
  const { runtime, receipt, cap } = setup({ now: () => now });
  for (let i = 1; i < 4; i++) assert.equal(runtime.create(auth()).ok, true);
  assert.equal(runtime.create(auth()).error, 'evidence_session_limit');
  for (let owner = 1; owner <= 3; owner++)
    for (let i = 0; i < 4; i++) assert.equal(runtime.create(auth('owner-' + owner)).ok, true);
  assert.equal(runtime.create(auth('more')).error, 'evidence_session_limit');
  now = receipt.expiresAt;
  assert.equal(runtime.bind(auth(), receipt.token), null);
  assert.equal(runtime.inspect().sessions, 0);
  cap.observeCalls('chat', [source()]);
  const next = runtime.create(auth());
  assert.equal(next.ok, true);
  const active = runtime.bind(auth(), next.token);
  runtime.configure(false);
  assert.equal(active.reply(LIST, {}).ok, false);
  assert.equal(runtime.create(auth()).ok, false);
  runtime.configure(true);
  assert.equal(runtime.create(auth()).ok, true);
  runtime.close();
  runtime.configure(true);
  assert.equal(runtime.inspect().enabled, false);
});

test('invalid, throwing, backward or extreme clocks clear evidence and fail closed permanently', () => {
  assert.throws(() => createContextApiEvidenceRuntime({ now: 1 }));
  for (const bad of [null, NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER, 'throws']) {
    let now = 10;
    const { runtime, cap } = setup({
      now: () => {
        if (now === 'throws') throw new Error('secret');
        return now;
      },
    });
    now = bad;
    assert.equal(cap.reply(LIST, {}).ok, false);
    assert.equal(runtime.inspect().closed, true);
    assert.equal(runtime.inspect().sessions, 0);
  }
});

test('sensitive, incomplete, invalid, conflicting and excessive calls cannot become retained evidence', () => {
  const { runtime, cap } = setup();
  cap.observeCalls('chat', [source('safe')]);
  for (const value of [
    'Bearer syntheticSecret12345',
    { api_key: 'synthetic-secret' },
    'Process running with session ID 8',
  ])
    cap.observeInput('chat', input('chat', value, 'safe'));
  assert.equal(runtime.inspect().captured, 0);
  cap.observeInput('chat', input('chat', 'terminal', 'safe'));
  assert.equal(runtime.inspect().captured, 1);
  cap.observeCalls('chat', [source('conflict')]);
  cap.observeCalls('chat', [source('conflict', { q: 'other' })]);
  cap.observeInput('chat', input('chat', 'must-not-retain', 'conflict'));
  cap.observeCalls('unknown', []);
  cap.observeCalls('chat', [{}]);
  cap.observeCalls(
    'chat',
    Array.from({ length: 129 }, () => source())
  );
  cap.observeInput('chat', { messages: [input('chat').messages[0], input('chat').messages[0]] });
  cap.observeInput('chat', Buffer.from('{}'), 'unknown');
  cap.observeInput('chat', Buffer.from([255]));
  cap.observeInput('chat', Buffer.alloc(2 * 1024 * 1024 + 1));
  cap.observeInput('chat', null);
  assert.equal(json(cap.reply(LIST, {})).sources.length, 1);
  assert.ok(runtime.inspect().rejected >= 10);
  runtime.close();
});

test('bounded compressed input and exact multi-page UTF-8 readback do not execute any source tool', () => {
  const { runtime, cap } = setup();
  const original = '细节-é-✅\r\n'.repeat(1800);
  cap.observeCalls('responses', [source()]);
  cap.observeInput(
    'responses',
    gzipSync(Buffer.from(JSON.stringify(input('responses', original)))),
    'gzip'
  );
  const receipt = json(cap.reply(LIST, {})).sources[0];
  let offsetBytes = 0;
  let recovered = '';
  do {
    const page = json(cap.reply(READ, { ...receiptArguments(receipt), offsetBytes }));
    assert.equal(page.ok, true);
    recovered += page.page.text;
    offsetBytes = page.page.nextOffsetBytes;
  } while (offsetBytes !== null);
  assert.equal(recovered, original);
  assert.equal(createHash('sha256').update(recovered).digest('hex'), receipt.digest);
  assert.equal(
    json(cap.reply(READ, { ...receiptArguments(receipt), digest: '0'.repeat(64) })).ok,
    false
  );
  assert.equal(runtime.inspect().captured, 1);
  assert.equal(cap.reply('execute_original_tool', {}), null);
  for (let i = 0; i < 64; i++) cap.reply(LIST, {});
  assert.equal(cap.reply(LIST, {}).code, 'evidence_read_budget_exceeded');
  runtime.close();
});

test('terminal JSON and SSE calls agree; incomplete and failed streams create no observations', () => {
  const chatWire =
    sse({
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":' },
              },
            ],
          },
        },
      ],
    }) +
    sse({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"fresh"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    }) +
    'data: [DONE]\n\n';
  const claudeWire = [
    { type: 'message_start', message: { role: 'assistant' } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"fresh"}' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]
    .map(sse)
    .join('');
  for (const [kind, wire] of [
    ['chat', chatWire],
    ['claude', claudeWire],
    ['responses', sse({ type: 'response.completed', response: response('responses') })],
  ])
    assert.deepEqual(
      decodeApiEvidenceResponse(kind, Buffer.from(wire), true),
      parseApiEvidenceCalls(kind, response(kind))
    );
  for (const [kind, wire] of [
    ['claude', claudeWire.slice(0, claudeWire.lastIndexOf('data:'))],
    ['responses', sse({ type: 'response.created', response: { status: 'in_progress' } })],
    ['chat', 'data: {broken}\n\n'],
    ['claude', sse({ type: 'error', error: { message: 'secret' } })],
  ])
    assert.throws(() => decodeApiEvidenceResponse(kind, Buffer.from(wire), true));
  assert.equal(
    decodeApiEvidenceResponse(
      'responses',
      Buffer.from(sse({ type: 'response.failed', response: { status: 'failed', output: [] } })),
      true
    ).length,
    0
  );
});

test('invalid input/call identities, getters, duplicates, argument limits and excessive arrays fail safely', () => {
  for (const body of [
    null,
    [],
    {
      get choices() {
        throw new Error('must-not-run');
      },
    },
  ])
    assert.throws(() => parseApiEvidenceCalls('chat', body));
  const duplicate = response('responses');
  duplicate.output.push(duplicate.output[0]);
  assert.throws(() => parseApiEvidenceCalls('responses', duplicate));
  const tooMany = {
    status: 'completed',
    output: Array.from({ length: 129 }, (_, i) => ({
      type: 'function_call',
      call_id: 'c' + i,
      name: 'lookup',
      arguments: '{}',
    })),
  };
  assert.throws(() => parseApiEvidenceCalls('responses', tooMany));
  for (const args of ['broken', 'x'.repeat(4097), '{"api_key":"synthetic-secret"}']) {
    const body = response('responses');
    body.output[0].arguments = args;
    assert.equal(parseApiEvidenceCalls('responses', body).length, 0);
  }
  assert.throws(() =>
    parseApiEvidenceResults('chat', {
      messages: [{ role: 'tool', tool_call_id: 'bad id', content: 'x' }],
    })
  );
  assert.throws(() =>
    parseApiEvidenceResults('chat', { messages: [{ role: 'tool', tool_call_id: 'id' }] })
  );
  assert.throws(() => decodeApiEvidenceResponse('chat', Buffer.from([255]), false));
  assert.throws(() => decodeApiEvidenceResponse('chat', Buffer.alloc(2 * 1024 * 1024 + 1), false));
});

test('response observer preserves write/backpressure, overloads and native bytes; closing/truncation never creates calls', () => {
  function fake() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.getHeader = () => undefined;
    res.write = () => false;
    res.end = () => {
      res.emit('finish');
      return res;
    };
    return res;
  }
  const { runtime, cap } = setup();
  const res = fake();
  const beforeWrite = res.write;
  installApiEvidenceResponseObserver(res, 'responses', cap);
  const wire = JSON.stringify(response('responses'));
  assert.equal(res.write(wire.slice(0, 30)), false);
  assert.equal(res.end(wire.slice(30)), res);
  assert.equal(res.write, beforeWrite);
  cap.observeInput('responses', input('responses'));
  assert.equal(runtime.inspect().captured, 1);
  for (const scenario of ['closed', 'oversized', 'gzip', 'failed', 'invalid']) {
    const other = fake();
    if (scenario === 'gzip') other.getHeader = () => 'gzip';
    if (scenario === 'failed') other.statusCode = 500;
    installApiEvidenceResponseObserver(other, 'chat', cap);
    if (scenario === 'closed') {
      other.write('{}');
      other.emit('close');
      other.emit('finish');
    } else
      other.end(
        scenario === 'oversized'
          ? Buffer.alloc(2 * 1024 * 1024 + 1)
          : scenario === 'invalid'
            ? 'not-json'
            : JSON.stringify(response('chat', 'never'))
      );
    cap.observeInput('chat', input('chat', 'must-not-capture', 'never'));
  }
  assert.equal(runtime.inspect().captured, 1);
  assert.ok(runtime.inspect().observationFailures >= 4);
  runtime.close();
});

test('callback-only end, string encodings, byte arrays, cancellation and observer quotas preserve Node response semantics', () => {
  const { runtime, cap } = setup();
  for (const variant of ['callback', 'encoded', 'bytes']) {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.getHeader = (name) => (name === 'content-type' ? 'application/json' : undefined);
    let originalArguments;
    let callbacks = 0;
    res.write = () => true;
    const original = (res.end = (...args) => {
      originalArguments = args;
      res.emit('finish');
      args.find((value) => typeof value === 'function')?.();
      return res;
    });
    installApiEvidenceResponseObserver(res, 'chat', cap);
    const wire = JSON.stringify(response('chat', 'overload_' + variant));
    const done = () => callbacks++;
    const args =
      variant === 'callback'
        ? [done]
        : variant === 'bytes'
          ? [new Uint8Array(Buffer.from(wire)), done]
          : [wire, 'utf8', done];
    if (variant === 'callback') res.write(wire, done);
    assert.equal(res.end(...args), res);
    assert.deepEqual(originalArguments, [args[0], args[1], args[2]]);
    assert.equal(callbacks, 1);
    assert.equal(res.end, original);
    cap.observeInput('chat', input('chat', 'overload-evidence', 'overload_' + variant));
  }
  assert.equal(runtime.inspect().captured, 3);
  const releases = Array.from({ length: 4 }, () => cap.acquireObservation());
  assert.equal(cap.acquireObservation(), null);
  const blocked = new EventEmitter();
  const untouched = (blocked.end = () => {});
  installApiEvidenceResponseObserver(blocked, 'chat', cap).close();
  assert.equal(blocked.end, untouched);
  releases.forEach((release) => {
    release();
    release();
  });
  const res = new EventEmitter();
  res.write = () => true;
  res.end = () => {};
  const observer = installApiEvidenceResponseObserver(res, 'chat', cap);
  res.emit('error', new Error('private'));
  observer.close();
  assert.equal(runtime.inspect().activeObservations, 0);
  const allReleases = [];
  for (let owner = 0; owner < 4; owner++) {
    const receipt = runtime.create(auth('quota-' + owner));
    const next = runtime.bind(auth('quota-' + owner), receipt.token);
    for (let index = 0; index < 4; index++) allReleases.push(next.acquireObservation());
  }
  assert.equal(cap.acquireObservation(), null);
  allReleases.forEach((release) => release());
  assert.equal(runtime.inspect().activeObservations, 0);
  for (const path of ['__proto__', 'constructor', 'toString', null, 1])
    assert.equal(apiEvidenceKind(path), null);
  runtime.close();
});

test('evidence bearer is redacted and never copied to replay headers; enabled policy must be boolean', () => {
  const headers = { 'x-hpm-evidence-token': 'hes_' + '1'.repeat(64), accept: 'application/json' };
  assert.equal(redactHeaders(headers)['x-hpm-evidence-token'], '[redacted]');
  assert.equal(Object.hasOwn(headersForReplay(headers), 'x-hpm-evidence-token'), false);
  assert.equal(validateAppSettings({ contextEvidenceEnabled: true }).valid, true);
  assert.equal(validateAppSettings({ contextEvidenceEnabled: 'true' }).valid, false);
});

test('only configured browser origins can preflight the explicit evidence header, and disabling evidence removes it', () => {
  for (const enabled of [true, false]) {
    const headers = {};
    const res = {
      setHeader: (key, value) => {
        headers[key] = value;
      },
      writeHead: (_status, value) => {
        Object.assign(headers, value);
      },
      end() {},
    };
    const config = {
      entryAuth: { allowedOrigins: ['https://fixture.example'] },
      appSettings: { contextEvidenceEnabled: enabled },
    };
    assert.equal(
      installEntryCorsGuard({ headers: { origin: 'https://fixture.example' } }, res, config, {}),
      true
    );
    assert.equal(headers['Access-Control-Allow-Headers'].includes('x-hpm-evidence-token'), enabled);
    res.writeHead(200, { 'Access-Control-Allow-Headers': '*' });
    assert.equal(headers['Access-Control-Allow-Headers'].includes('x-hpm-evidence-token'), enabled);
    assert.equal(headers['Access-Control-Allow-Headers'].includes('*'), false);
    assert.equal(
      installEntryCorsGuard({ headers: { origin: 'https://unapproved.example' } }, res, config, {}),
      false
    );
  }
});
