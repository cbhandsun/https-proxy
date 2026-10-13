'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  guardNativeCompactionResponse,
} = require('../lib/proxy/handlers/native-compaction-response');

const body = {
  id: 'native',
  object: 'response.compaction',
  created_at: 1,
  output: [
    { type: 'message', role: 'user', content: '保留🙂', extra: 42 },
    { type: 'compaction', encrypted_content: 'native-fixture' },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  unknown: { intact: true },
};
const wire = Buffer.from(JSON.stringify(body, null, 2));
function fixture(options = {}) {
  const proxyRes = new EventEmitter();
  const clientRes = new EventEmitter();
  proxyRes.headers = options.upstreamHeaders || { 'content-type': 'application/json' };
  let status,
    headers,
    output = Buffer.alloc(0),
    completed = 0,
    destroyed = 0;
  const failures = [];
  proxyRes.destroy = () => {
    destroyed++;
    proxyRes.emit('close');
  };
  clientRes.writeHead = (code, value) => {
    if (options.throwHeaders) throw new Error('TOKEN_CONTENT_MUST_NOT_LEAK');
    status = code;
    headers = value;
    clientRes.headersSent = true;
  };
  clientRes.end = (value) => {
    if (options.throwEnd) throw new Error('TOKEN_CONTENT_MUST_NOT_LEAK');
    output = Buffer.from(value);
    if (options.disconnectOnEnd) {
      clientRes.destroyed = true;
      clientRes.emit('close');
      return;
    }
    clientRes.writableEnded = true;
    if (!options.deferFinish) clientRes.emit('finish');
  };
  clientRes.destroy = () => {
    clientRes.destroyed = true;
    clientRes.emit('close');
  };
  guardNativeCompactionResponse({
    proxyRes,
    clientRes,
    headers: { 'transfer-encoding': 'chunked', 'content-encoding': 'identity' },
    statusCode: 200,
    maxBytes: options.maxBytes ?? 8192,
    sendJsonError: (res, code, payload) => {
      res.writeHead(code);
      res.end(JSON.stringify(payload));
    },
    onComplete:
      options.onComplete ||
      (() => {
        completed++;
      }),
    onFailure: (code) => failures.push(code),
    ...(options.diagnosticLog ? { diagnosticLog: options.diagnosticLog } : {}),
  });
  return {
    proxyRes,
    clientRes,
    failures,
    result: () => ({ status, headers, output, completed, destroyed }),
  };
}

test('native response holds every byte until complete, preserves exact wire and finishes once', () => {
  const f = fixture();
  for (const byte of wire) f.proxyRes.emit('data', Buffer.from([byte]));
  assert.equal(f.result().status, undefined);
  f.proxyRes.emit('end');
  assert.deepEqual(f.result().output, wire);
  assert.equal(f.result().headers['content-length'], wire.length);
  assert.equal(f.result().headers['transfer-encoding'], undefined);
  assert.equal(f.result().headers['content-encoding'], undefined);
  assert.equal(f.result().completed, 1);
  f.proxyRes.emit('end');
  f.proxyRes.emit('error', new Error('TOKEN_CONTENT_MUST_NOT_LEAK'));
  assert.equal(f.result().completed, 1);
  assert.deepEqual(f.failures, []);
});

test('publication completes only on downstream finish, not upstream end or disconnect', () => {
  const f = fixture({ deferFinish: true });
  f.proxyRes.emit('data', wire);
  f.proxyRes.emit('end');
  f.proxyRes.emit('close');
  f.proxyRes.emit('data', Buffer.alloc(9000));
  f.proxyRes.emit('end');
  assert.deepEqual(f.result().output, wire);
  assert.equal(f.result().completed, 0);
  assert.deepEqual(f.failures, []);
  f.clientRes.emit('finish');
  assert.equal(f.result().completed, 1);
  const lost = fixture({ disconnectOnEnd: true });
  lost.proxyRes.emit('data', wire);
  lost.proxyRes.emit('end');
  assert.equal(lost.result().completed, 0);
});

test('malformed, empty, truncated and oversized upstream state never publishes partial success or raw content', () => {
  for (const value of [
    '',
    'TOKEN_CONTENT_MUST_NOT_LEAK',
    JSON.stringify({ ...body, output: [] }),
    wire.subarray(0, wire.length - 1),
  ]) {
    const f = fixture();
    f.proxyRes.emit('data', value);
    f.proxyRes.emit('end');
    assert.equal(f.result().status, 502);
    assert.equal(f.result().completed, 0);
    assert.equal(f.result().output.includes('TOKEN_CONTENT_MUST_NOT_LEAK'), false);
    assert.deepEqual(f.failures, ['upstream_invalid_compaction']);
  }
  const f = fixture({ maxBytes: 16 });
  f.proxyRes.emit('data', Buffer.alloc(17));
  f.proxyRes.emit('end');
  assert.equal(f.result().status, 502);
  assert.deepEqual(f.failures, ['upstream_compaction_too_large']);
});

test('upstream aborts, client cancellation and invalid response encoding release collection safely', () => {
  for (const event of ['error', 'aborted', 'close']) {
    const f = fixture();
    f.proxyRes.emit('data', wire.subarray(0, 20));
    f.proxyRes.emit(event, new Error('TOKEN_CONTENT_MUST_NOT_LEAK'));
    f.proxyRes.emit('end');
    assert.equal(f.result().status, 502);
    assert.equal(f.result().completed, 0);
    assert.deepEqual(f.failures, ['upstream_compaction_aborted']);
  }
  const canceled = fixture();
  canceled.clientRes.emit('close');
  canceled.proxyRes.emit('data', wire);
  canceled.proxyRes.emit('end');
  assert.equal(canceled.result().output.length, 0);
  assert.equal(canceled.result().completed, 0);
  assert.equal(canceled.result().destroyed, 1);
  for (const upstreamHeaders of [
    { 'content-type': 'text/event-stream' },
    { 'content-encoding': 'gzip' },
  ]) {
    const f = fixture({ upstreamHeaders });
    assert.equal(f.result().status, 502);
    assert.deepEqual(f.failures, ['upstream_invalid_compaction']);
  }
});

test('header/write exceptions cannot log or report successful publication', () => {
  for (const options of [{ throwHeaders: true }, { throwEnd: true }]) {
    const f = fixture(options);
    f.proxyRes.emit('data', wire);
    f.proxyRes.emit('end');
    assert.equal(f.result().completed, 0);
    assert.deepEqual(f.failures, ['compaction_publication_failed']);
    assert.equal(f.result().output.includes('TOKEN_CONTENT_MUST_NOT_LEAK'), false);
  }
});

test('invalid UTF-8 is rejected, and terminal logger failure cannot revoke published state', () => {
  const invalid = Buffer.from(wire);
  invalid[invalid.indexOf(Buffer.from('🙂'))] = 255;
  const f = fixture();
  f.proxyRes.emit('data', invalid);
  f.proxyRes.emit('end');
  assert.equal(f.result().status, 502);
  assert.deepEqual(f.failures, ['upstream_invalid_compaction']);
  const diagnostics = [];
  const published = fixture({
    onComplete: () => {
      throw new Error('TOKEN_CONTENT_MUST_NOT_LEAK');
    },
    diagnosticLog: { error: (...args) => diagnostics.push(args) },
  });
  published.proxyRes.emit('data', wire);
  assert.doesNotThrow(() => published.proxyRes.emit('end'));
  assert.deepEqual(published.result().output, wire);
  assert.deepEqual(published.failures, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes('TOKEN_CONTENT_MUST_NOT_LEAK'), false);
  assert.throws(() => fixture({ maxBytes: 0 }), /Invalid native compaction response limit/);
});
