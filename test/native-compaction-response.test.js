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
    ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
    ...(options.beforePublishAsync ? { beforePublishAsync: options.beforePublishAsync } : {}),
    ...(options.afterFinishAsync ? { afterFinishAsync: options.afterFinishAsync } : {}),
    ...(options.publicationAllowed ? { publicationAllowed: options.publicationAllowed } : {}),
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

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
test('async prepare and finish gate exact publication, tolerate upstream close and ignore duplicate finish', async () => {
  const prepare = deferred(),
    finish = deferred();
  let finishCalls = 0;
  const f = fixture({
    beforePublishAsync: () => prepare.promise,
    afterFinishAsync: () => {
      finishCalls++;
      return finish.promise;
    },
  });
  f.proxyRes.emit('data', wire);
  f.proxyRes.emit('end');
  f.proxyRes.emit('close');
  assert.equal(f.result().status, undefined);
  prepare.resolve(true);
  await flush();
  assert.deepEqual(f.result().output, wire);
  assert.equal(f.result().completed, 0);
  f.clientRes.emit('close');
  f.clientRes.emit('finish');
  assert.equal(finishCalls, 1);
  finish.resolve(true);
  await flush();
  assert.equal(f.result().completed, 1);
  assert.deepEqual(f.failures, []);
});

test('async preparation cancellation prevents late headers and reports failure exactly once', async () => {
  const pending = deferred();
  const f = fixture({ beforePublishAsync: () => pending.promise });
  f.proxyRes.emit('data', wire);
  f.proxyRes.emit('end');
  f.clientRes.destroy();
  pending.resolve(true);
  await flush();
  assert.equal(f.result().status, undefined);
  assert.equal(f.result().output.length, 0);
  assert.equal(f.result().completed, 0);
  assert.deepEqual(f.failures, ['compaction_publication_failed']);
});

test('async callbacks reject non-ACK values, executable thenables and rejections without leaking data', async () => {
  let executed = 0;
  const hostile = {
    get then() {
      executed++;
      throw new Error('TOKEN_CONTENT');
    },
  };
  for (const callback of [
    () => true,
    () => hostile,
    () => Promise.resolve(false),
    () => Promise.resolve({ ok: true }),
    () => Promise.reject(new Error('TOKEN_CONTENT')),
    () => {
      throw new Error('TOKEN_CONTENT');
    },
  ]) {
    for (const phase of ['prepare', 'finish']) {
      const f = fixture(
        phase === 'prepare' ? { beforePublishAsync: callback } : { afterFinishAsync: callback }
      );
      f.proxyRes.emit('data', wire);
      f.proxyRes.emit('end');
      await flush();
      assert.equal(f.result().completed, 0);
      assert.deepEqual(f.failures, ['context_recovery_compaction_unavailable']);
      assert.equal(f.result().status, phase === 'prepare' ? 502 : 200);
      assert.doesNotMatch(f.result().output.toString(), /TOKEN_CONTENT/);
      if (phase === 'finish') assert.deepEqual(f.result().output, wire);
    }
  }
  assert.equal(executed, 0);
});

test('permission is rechecked after asynchronous callbacks immediately before publish and success report', async () => {
  for (const phase of ['prepare', 'finish']) {
    const pending = deferred();
    let allowed = true;
    const f = fixture({
      ...(phase === 'prepare'
        ? { beforePublishAsync: () => pending.promise }
        : { afterFinishAsync: () => pending.promise }),
      publicationAllowed: () => allowed,
    });
    f.proxyRes.emit('data', wire);
    f.proxyRes.emit('end');
    allowed = false;
    pending.resolve(true);
    await flush();
    assert.equal(f.result().completed, 0);
    assert.deepEqual(f.failures, ['context_recovery_compaction_unavailable']);
    assert.equal(f.result().status, phase === 'prepare' ? 502 : 200);
  }
});

test('asynchronous terminal reporting errors are consumed and cannot revoke completed publication', async () => {
  const diagnostics = [];
  const f = fixture({
    onComplete: () => Promise.reject(new Error('TOKEN_CONTENT')),
    diagnosticLog: { error: (...args) => diagnostics.push(args) },
  });
  f.proxyRes.emit('data', wire);
  f.proxyRes.emit('end');
  await flush();
  assert.deepEqual(f.result().output, wire);
  assert.deepEqual(f.failures, []);
  assert.equal(diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /TOKEN_CONTENT/);
});

test('async callback configuration rejects invalid values and native Promise accessors are never executed', async () => {
  for (const slot of ['beforePublishAsync', 'afterFinishAsync', 'publicationAllowed'])
    for (const value of [null, false, 0, '', {}, []])
      assert.throws(
        () => guardNativeCompactionResponse({ maxBytes: 1, [slot]: value }),
        /Invalid native compaction publication callback/
      );
  let executed = 0;
  const promise = Promise.resolve(true);
  Object.defineProperty(promise, 'then', {
    get() {
      executed++;
      throw new Error('TOKEN_CONTENT');
    },
  });
  const f = fixture({ beforePublishAsync: () => promise });
  f.proxyRes.emit('data', wire);
  f.proxyRes.emit('end');
  await flush();
  assert.deepEqual(f.result().output, wire);
  assert.equal(f.result().completed, 1);
  assert.equal(executed, 0);
});

test('native publication hook receives the complete canonical response and can block publication safely', () => {
  let observed;
  const accepted = fixture({
    beforePublish(value) {
      observed = value;
      return true;
    },
  });
  accepted.proxyRes.emit('data', wire);
  assert.equal(observed, undefined);
  accepted.proxyRes.emit('end');
  assert.deepEqual(observed, body);
  assert.deepEqual(accepted.result().output, wire);
  for (const beforePublish of [
    () => false,
    () => {
      throw new Error('TOKEN_CONTENT_MUST_NOT_LEAK');
    },
  ]) {
    const rejected = fixture({ beforePublish });
    rejected.proxyRes.emit('data', wire);
    rejected.proxyRes.emit('end');
    assert.equal(rejected.result().status, 502);
    assert.equal(rejected.result().completed, 0);
    assert.deepEqual(rejected.failures, ['context_recovery_compaction_unavailable']);
    assert.doesNotMatch(rejected.result().output.toString(), /TOKEN_CONTENT|native-fixture/);
  }
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
