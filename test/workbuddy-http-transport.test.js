'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorkBuddyWbipcClient } = require('../lib/proxy/workbuddy-wbipc-client');
const { normalizeWorkBuddyChatSse } = require('../lib/proxy/workbuddy-chat-stream-contract');
const {
  createWorkBuddyHttpTransport,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} = require('../lib/proxy/workbuddy-http-transport');
const prepared = { authProvider: 'workbuddy', workbuddyAuth: { accessTokenEncrypted: true } };
const body = { model: 'other', messages: [{ role: 'user', content: 'hello' }], stream: true };
const success = {
  ok: true,
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: 'data: [DONE]\n\n',
};
function fixture(result, input = body, requestOptions = {}, plannerOptions = {}) {
  const calls = [];
  const transport = createWorkBuddyHttpTransport(prepared, '', {
    client: {
      async request(params, options) {
        calls.push({ params, options });
        if (result instanceof Error) throw result;
        if (Array.isArray(result)) return result[Math.min(calls.length - 1, result.length - 1)];
        return result;
      },
    },
    plannerOptions,
  });
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method: 'POST',
        path: '/v2/chat/completions',
        headers: { authorization: 'SECRET', cookie: 'SECRET' },
        ...requestOptions,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text, calls, res, req })
        );
      }
    );
    req.on('error', reject);
    req.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
async function main() {
  const pendingWire =
    'event: chunk\r\ndata: {"choices":[{"finish_reason":"","delta":{"content":"hi"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const normalized = normalizeWorkBuddyChatSse(pendingWire);
  assert.ok(normalized.includes('"finish_reason":null'));
  assert.ok(normalized.includes('event: chunk'));
  assert.ok(normalized.includes('data: [DONE]'));
  for (const legacy of [{}, { name: '', arguments: '' }]) {
    const frame =
      'data: ' + JSON.stringify({ choices: [{ delta: { function_call: legacy } }] }) + '\n\n';
    assert.ok(!normalizeWorkBuddyChatSse(frame).includes('function_call'));
  }
  for (const legacy of [
    { name: 'real', arguments: '' },
    { name: '', arguments: '{}' },
    { extra: '' },
    [],
    null,
  ]) {
    const frame =
      'data: ' + JSON.stringify({ choices: [{ delta: { function_call: legacy } }] }) + '\n\n';
    assert.equal(normalizeWorkBuddyChatSse(frame), frame);
  }
  assert.equal(
    normalizeWorkBuddyChatSse('data: {"choices":[{"finish_reason":"stop"}]}\n\n'),
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
  );
  assert.equal(normalizeWorkBuddyChatSse(''), '');
  assert.equal(normalizeWorkBuddyChatSse(': comment\n\n'), ': comment\n\n');
  for (const frame of ['data: SECRET\n\n', 'data: []\n\n', 'data: null\n\n'])
    assert.throws(() => normalizeWorkBuddyChatSse(frame), /Invalid WorkBuddy Chat stream frame/);
  for (const source of [
    undefined,
    {},
    { profile: { protocol: 'openai' }, workbuddyAuth: { accessTokenEncrypted: true } },
    { authProvider: 'workbuddy' },
  ])
    assert.equal(createWorkBuddyHttpTransport(source, ''), null);
  assert.equal(createWorkBuddyHttpTransport(prepared, 'plaintext-fixture'), null);
  const normal = await fixture(success);
  assert.equal(normal.status, 200);
  assert.equal(normal.text, success.body);
  assert.equal(normal.res.complete, true);
  assert.deepEqual(normal.calls[0].params.headers, {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  });
  assert.deepEqual(JSON.parse(normal.calls[0].params.body), body);
  assert.equal(normal.calls[0].options.signal.aborted, false);
  normal.req.destroy();
  assert.equal(normal.calls[0].options.signal.aborted, true);
  const json = await fixture(
    {
      ...success,
      body: '{}',
      headers: {
        'content-type': 'application/json',
        authorization: 'SECRET',
        cookie: 'SECRET',
        'retry-after': '12',
      },
    },
    { ...body, stream: false }
  );
  assert.equal(json.calls[0].params.headers.accept, 'application/json');
  assert.equal(json.headers['retry-after'], '12');
  assert.ok(!JSON.stringify(json.headers).includes('SECRET'));
  for (const input of ['SECRET', '[]', 'null', '"SECRET"', 'x'.repeat(MAX_REQUEST_BYTES + 1)]) {
    const result = await fixture(success, input);
    assert.ok([400, 413].includes(result.status));
    assert.equal(result.calls.length, 0);
    assert.ok(!result.text.includes('SECRET'));
  }
  for (const path of [
    'https://SECRET',
    '//SECRET',
    '/v2/../chat/completions',
    '/v2/chat/completions?token=SECRET',
    '/v2/chat/completions#SECRET',
    '/v2/other',
  ]) {
    const result = await fixture(success, body, { path });
    assert.equal(result.status, 400);
    assert.equal(result.calls.length, 0);
  }
  const wrongMethod = await fixture(success, body, { method: 'GET' });
  assert.equal(wrongMethod.status, 400);
  for (const invalid of [
    {},
    { messages: 'SECRET' },
    { messages: [null] },
    { messages: [{}] },
    { ...body, stream: 'SECRET' },
  ]) {
    const result = await fixture(success, invalid);
    assert.equal(result.status, 400);
    assert.equal(result.calls.length, 0);
  }
  const smallOversize = await fixture({ ok: false, status: 'E_PAYLOAD_TOO_LARGE' });
  assert.equal(smallOversize.status, 413);
  assert.equal(smallOversize.calls.length, 1);
  const huge = {
    ...body,
    messages: [{ role: 'assistant', content: 'x'.repeat(700000) }, ...body.messages],
  };
  const retried = await fixture(
    [{ ok: false, status: 'E_PAYLOAD_TOO_LARGE' }, success],
    huge,
    {},
    {
      preflightBodyBytes: 2 * 1024 * 1024,
      targetBodyBytes: 1024 * 1024,
      operationalInputTokens: 1024 * 1024,
    }
  );
  assert.equal(retried.status, 200);
  assert.equal(retried.calls.length, 2);
  assert.ok(retried.calls[1].params.body.length < retried.calls[0].params.body.length);
  const stillLarge = await fixture(
    [
      { ok: false, status: 'E_PAYLOAD_TOO_LARGE' },
      { ok: false, status: 'E_PAYLOAD_TOO_LARGE' },
    ],
    huge,
    {},
    {
      preflightBodyBytes: 2 * 1024 * 1024,
      targetBodyBytes: 1024 * 1024,
      operationalInputTokens: 1024 * 1024,
    }
  );
  assert.equal(stillLarge.status, 413);
  assert.equal(stillLarge.calls.length, 2);
  for (const [result, expectedStatus] of [
    [null, 401],
    [{ ok: false, status: 'not_available', error: 'SECRET' }, 503],
    [{ ok: false, status: 'method_unavailable' }, 503],
    [{ ok: false, status: 'host_start_failed' }, 503],
    [{ ok: false, status: 'host_recovery_timeout' }, 503],
    [{ ok: false, status: 'host_recovery_cooldown' }, 503],
    [new Error('SECRET'), 502],
  ]) {
    const failed = await fixture(result);
    assert.equal(failed.status, expectedStatus);
    assert.ok(!failed.text.includes('SECRET'));
  }
  for (const result of [
    { ...success, status: 199 },
    { ...success, status: 600 },
    { ...success, status: '200' },
    { ...success, body: {} },
    { ...success, body: 'x'.repeat(MAX_RESPONSE_BYTES + 1) },
  ]) {
    const failed = await fixture(result);
    assert.equal(failed.status, 502);
  }
  const upstreamError = await fixture({ ...success, status: 429, body: '{"error":"fixture"}' });
  const emptyFrame =
    'data: ' +
    JSON.stringify({ choices: [{ finish_reason: '', delta: { content: '' } }] }) +
    '\n\n';
  const oversizedNormalization =
    'data: ' +
    JSON.stringify({
      choices: [
        {
          finish_reason: '',
          delta: { content: 'x'.repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(emptyFrame)) },
        },
      ],
    }) +
    '\n\n';
  assert.equal(Buffer.byteLength(oversizedNormalization), MAX_RESPONSE_BYTES);
  assert.equal((await fixture({ ...success, body: oversizedNormalization })).status, 502);
  assert.equal((await fixture({ ...success, body: 'data: SECRET\n\n' })).status, 502);
  assert.equal(upstreamError.status, 429);
  assert.equal(upstreamError.text, '{"error":"fixture"}');
  const badHeaders = await fixture({
    ...success,
    headers: { 'content-type': 'text/event-stream\r\nSECRET', 'retry-after': 'SECRET' },
  });
  assert.ok(!JSON.stringify(badHeaders.headers).includes('SECRET'));

  let signal, release;
  const stalled = createWorkBuddyHttpTransport(prepared, '', {
    client: {
      request(_params, options) {
        signal = options.signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  let delivered = false;
  const req = stalled.request({ method: 'POST', path: '/v2/chat/completions' }, () => {
    delivered = true;
  });
  req.end(JSON.stringify(body));
  await new Promise((resolve) => setImmediate(resolve));
  req.destroy();
  assert.equal(signal.aborted, true);
  const aborted = new globalThis.AbortController();
  aborted.abort();
  let connects = 0;
  let socket;
  const client = createWorkBuddyWbipcClient({
    readEndpoint: () => ({ endpoint: 'fixture', ticket: 'fixture' }),
    connect() {
      connects++;
      socket = new EventEmitter();
      socket.write = () => true;
      socket.destroy = () => {
        socket.destroyed = true;
        socket.emit('close');
      };
      return socket;
    },
  });
  assert.deepEqual(await client.request({}, { signal: aborted.signal }), {
    ok: false,
    status: 'cancelled',
  });
  assert.equal(connects, 0);
  const during = new globalThis.AbortController();
  const pending = client.request({ path: '/v2/chat/completions' }, { signal: during.signal });
  during.abort();
  assert.deepEqual(await pending, { ok: false, status: 'cancelled' });
  assert.equal(socket.destroyed, true);
  release(success);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, false);
  const timeout = await new Promise((resolve, reject) => {
    const req = stalled.request(
      { method: 'POST', path: '/v2/chat/completions', timeout: 10 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
    setTimeout(() => {
      if (release) release(success);
    }, 30);
  });
  assert.equal(timeout, 504);
  assert.equal(signal.aborted, true);
  process.stdout.write('workbuddy-http-transport.test.js passed\n');
}
main().catch((error) => {
  process.stderr.write(String(error.stack) + '\n');
  process.exitCode = 1;
});
