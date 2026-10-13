'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  guardJsonObjectResponse,
  jsonObjectPassthroughRequest,
} = require('../lib/proxy/json-object-response-guard');
const source = { text: { format: { type: 'json_object' } } };
const chat = (content, finish_reason = 'stop') => ({
  choices: [{ index: 0, finish_reason, message: { content } }],
});
const response = (text, status = 'completed') => ({
  object: 'response',
  status,
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
});
const wire = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';
function fixture(kind, options = {}) {
  const upstream = new EventEmitter(),
    downstream = new EventEmitter();
  let body = '',
    status,
    completed = 0,
    ends = 0,
    pauses = 0,
    resumes = 0,
    destroyed = 0;
  const failures = [];
  upstream.destroy = () => {
    destroyed++;
    upstream.emit('close');
  };
  upstream.pause = () => {
    pauses++;
  };
  upstream.resume = () => {
    resumes++;
  };
  downstream.writeHead = (value) => {
    status = value;
    downstream.headersSent = true;
  };
  downstream.write = (value) => {
    body += String(value);
    return downstream.accepted !== false;
  };
  downstream.end = (value = '') => {
    body += String(value);
    ends++;
    downstream.writableEnded = true;
    downstream.emit('finish');
  };
  downstream.destroy = () => {
    downstream.destroyed = true;
    downstream.emit('close');
  };
  guardJsonObjectResponse({
    proxyRes: upstream,
    clientRes: downstream,
    clientReq: { method: 'POST' },
    headers: {},
    statusCode: 200,
    request: { kind, source },
    isStream: false,
    maxBytes: 8192,
    sendJsonError: (res, code, payload) => {
      res.writeHead(code);
      res.end(JSON.stringify(payload));
    },
    onComplete: () => {
      completed++;
    },
    onFailure: (code) => failures.push(code),
    ...options,
  });
  return {
    upstream,
    downstream,
    failures,
    result: () => ({ body, status, completed, ends, pauses, resumes, destroyed }),
  };
}
for (const kind of ['chat', 'responses']) {
  const build = kind === 'chat' ? chat : response;
  for (const value of ['{}', '{"unicode":"中文"}']) {
    const h = fixture(kind);
    const bytes = Buffer.from(JSON.stringify(build(value)));
    for (const byte of bytes) h.upstream.emit('data', Buffer.from([byte]));
    h.upstream.emit('end');
    assert.equal(h.result().status, 200);
    assert.equal(h.result().completed, 1);
    assert.equal(h.failures.length, 0);
    assert.deepEqual(JSON.parse(h.result().body), build(value));
  }
  for (const value of ['', '   ', 'SECRET', '[]', 'null', '{']) {
    const h = fixture(kind);
    h.upstream.emit('data', JSON.stringify(build(value)));
    h.upstream.emit('end');
    h.upstream.emit('error', new Error('SECRET'));
    assert.equal(h.result().status, 502);
    assert.equal(h.result().completed, 0);
    assert.equal(h.failures.length, 1);
    assert.equal(h.result().body.includes('SECRET'), false);
    assert.equal(h.result().ends, 1);
  }
  for (const event of ['error', 'aborted', 'close']) {
    const h = fixture(kind);
    h.upstream.emit(event, new Error('SECRET'));
    h.upstream.emit('end');
    assert.equal(h.result().status, 502);
    assert.equal(h.failures.length, 1);
  }
  const oversized = fixture(kind, { maxBytes: 16 });
  oversized.upstream.emit('data', Buffer.alloc(17));
  assert.deepEqual(oversized.failures, ['upstream_json_object_too_large']);
  const cancelled = fixture(kind);
  cancelled.downstream.emit('close');
  cancelled.upstream.emit('data', JSON.stringify(build('{}')));
  cancelled.upstream.emit('end');
  assert.equal(cancelled.result().completed, 0);
  assert.equal(cancelled.result().body, '');
  assert.equal(cancelled.result().destroyed, 1);
}
for (const kind of ['chat', 'responses']) {
  for (const text of ['{}', '   ']) {
    const h = fixture(kind, { isStream: true });
    const delta =
      kind === 'chat'
        ? { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
        : { type: 'response.output_text.delta', delta: text };
    const terminal =
      kind === 'chat'
        ? { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        : { type: 'response.completed', response: response(text) };
    h.upstream.emit('data', wire(delta));
    assert.ok(h.result().body.includes('data:'), 'Deltas must arrive before upstream end');
    const before = h.result().body;
    h.upstream.emit('data', wire(terminal) + 'data: [DONE]\n\n');
    assert.equal(h.result().body, before, 'Success marker must wait for validation');
    h.upstream.emit('end');
    assert.equal(h.result().completed, text === '{}' ? 1 : 0);
    assert.equal(h.failures.length, text === '{}' ? 0 : 1);
    if (text !== '{}') assert.equal(h.result().body.includes('upstream_invalid_json_object'), true);
    const after = h.result().body;
    h.upstream.emit('data', wire(delta));
    h.upstream.emit('end');
    assert.equal(h.result().body, after);
  }
  const collapsed = fixture(kind, { isStream: true, clientStreaming: false });
  collapsed.upstream.emit(
    'data',
    kind === 'chat'
      ? wire(chat('{}'))
      : wire({ type: 'response.completed', response: response('{}') })
  );
  collapsed.upstream.emit('end');
  assert.equal(collapsed.result().completed, 1);
  assert.equal(
    JSON.parse(collapsed.result().body).choices?.[0]?.message.content ??
      JSON.parse(collapsed.result().body).output[0].content[0].text,
    '{}'
  );
  const late = fixture(kind, { isStream: true });
  late.upstream.emit(
    'data',
    (kind === 'chat'
      ? wire(chat('{}'))
      : wire({ type: 'response.completed', response: response('{}') })) +
      'data: [DONE]\n\n' +
      wire({ content: 'SECRET' })
  );
  late.upstream.emit('end');
  assert.equal(late.result().completed, 0);
  assert.equal(late.result().body.includes('SECRET'), false);
}
const slow = fixture('chat', { isStream: true });
slow.downstream.accepted = false;
slow.upstream.emit('data', wire({ choices: [{ delta: { content: '{}' }, finish_reason: null }] }));
assert.equal(slow.result().pauses, 1);
slow.upstream.emit('data', wire({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
slow.upstream.emit('end');
assert.equal(slow.result().completed, 0);
slow.downstream.accepted = true;
slow.downstream.emit('drain');
assert.equal(slow.result().completed, 1);
assert.equal(slow.result().ends, 1);
for (const payload of [
  chat('{', 'length'),
  { choices: [{ finish_reason: 'stop', message: { refusal: 'declined' } }] },
  {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{}' } },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        finish_reason: 'function_call',
        message: { function_call: { name: 'probe', arguments: '{}' } },
      },
    ],
  },
]) {
  const h = fixture('chat');
  h.upstream.emit('data', JSON.stringify(payload));
  h.upstream.emit('end');
  assert.equal(h.result().completed, 1);
  assert.deepEqual(JSON.parse(h.result().body), payload);
}
for (const status of ['incomplete', 'failed']) {
  const h = fixture('responses', { isStream: true });
  const payload = response('{', status);
  h.upstream.emit('data', wire({ type: 'response.' + status, response: payload }));
  h.upstream.emit('end');
  assert.equal(h.result().body.includes('response.' + status), true);
  assert.equal(h.result().completed, status === 'failed' ? 0 : 1);
  assert.equal(h.failures.length, status === 'failed' ? 1 : 0);
}
for (const payload of [
  chat('{}', null),
  chat('{}', 'unknown'),
  {
    choices: [
      {
        finish_reason: 'function_call',
        message: { function_call: { name: 'probe', arguments: 'SECRET' } },
      },
    ],
  },
]) {
  const h = fixture('chat');
  h.upstream.emit('data', JSON.stringify(payload));
  h.upstream.emit('end');
  assert.equal(h.result().status, 502);
  assert.equal(h.result().body.includes('SECRET'), false);
}
for (const data of ['data: SECRET\n\n', 'data: null\n\n', 'data: [DONE]\n\n']) {
  const h = fixture('chat', { isStream: true });
  h.upstream.emit('data', data);
  h.upstream.emit('end');
  assert.equal(h.result().status, 502);
  assert.equal(h.result().completed, 0);
}
const compressed = fixture('chat', { headers: { 'content-encoding': 'gzip' } });
assert.deepEqual(compressed.failures, ['upstream_json_object_encoding']);
assert.equal(compressed.result().status, 502);
const overflow = fixture('chat', {
  isStream: true,
  protocolOptions: { maxConversionOutputBufferBytes: 1 },
});
overflow.upstream.emit(
  'data',
  wire({ choices: [{ delta: { content: '{}' }, finish_reason: null }] })
);
assert.equal(overflow.result().completed, 0);
assert.equal(overflow.result().destroyed, 1);
assert.equal(overflow.failures.length, 1);
assert.equal(
  jsonObjectPassthroughRequest(Buffer.from(JSON.stringify(source)), '/v1/responses').kind,
  'responses'
);
for (const input of [null, Buffer.from('SECRET'), Buffer.from('{}')])
  assert.equal(jsonObjectPassthroughRequest(input, '/v1/responses'), null);
assert.equal(
  jsonObjectPassthroughRequest(Buffer.from(JSON.stringify(source)), '/v1/messages'),
  null
);
assert.throws(() => guardJsonObjectResponse({ request: { kind: 'chat' }, maxBytes: 0 }), TypeError);
console.log('json-object-response-guard.test.js passed');
