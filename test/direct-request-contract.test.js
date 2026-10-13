'use strict';
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const {
  createDirectRequestObserver,
  deferDirectResponse,
} = require('../lib/proxy/direct-request-contract');

async function complete(body, maxBytes = 4096) {
  const capture = createDirectRequestObserver(maxBytes);
  const output = [];
  capture.observer.on('data', (chunk) => {
    output.push(Buffer.from(chunk));
  });
  const finished = once(capture.observer, 'finish');
  const bytes = Buffer.from(JSON.stringify(body));
  for (const byte of bytes) capture.observer.write(Buffer.from([byte]));
  assert.deepEqual(
    Buffer.concat(output),
    bytes,
    'Upload bytes must pass before metadata completion'
  );
  assert.equal(capture.metadata(), undefined);
  capture.observer.end();
  await finished;
  return { capture, output };
}
function upstream() {
  const res = new EventEmitter();
  res.pause = () => {
    res.paused = true;
  };
  res.resume = () => {
    res.resumed = true;
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit('close');
  };
  return res;
}
async function main() {
  assert.throws(() => createDirectRequestObserver(0), TypeError);
  const plain = await complete({
    model: 'fixture',
    messages: [{ content: '中文SECRET' }],
    stream: false,
  });
  assert.deepEqual(plain.capture.metadata(), { request: null, stream: false });
  const formatted = await complete({
    model: 'fixture',
    messages: [{ content: 'SECRET' }],
    stream: true,
    response_format: { type: 'json_object' },
    tools: [{ type: 'function', function: { name: 'probe' } }],
  });
  assert.equal(formatted.capture.metadata().request.kind, 'chat');
  assert.equal(formatted.capture.metadata().stream, true);
  assert.equal(JSON.stringify(formatted.capture.metadata()).includes('SECRET'), false);
  const early = createDirectRequestObserver(4096);
  early.observer.resume();
  const res = upstream();
  const successes = [],
    failures = [];
  deferDirectResponse({
    capture: early,
    proxyRes: res,
    onReady: (metadata) => successes.push(metadata),
    onFailure: (error) => failures.push(error),
  });
  assert.equal(res.paused, true);
  assert.equal(successes.length, 0);
  early.observer.end('{"stream":true,"response_format":{"type":"json_object"}}');
  await once(early.observer, 'finish');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 0);
  assert.equal(res.resumed, true);
  for (const event of ['error', 'close', 'aborted']) assert.equal(res.listenerCount(event), 0);
  const immediate = upstream();
  deferDirectResponse({
    capture: early,
    proxyRes: immediate,
    onReady: () => successes.push(true),
    onFailure: () => failures.push(true),
  });
  assert.equal(successes.length, 2);
  const stoppedResponse = upstream();
  stoppedResponse.destroy();
  deferDirectResponse({
    capture: early,
    proxyRes: stoppedResponse,
    onReady: () => assert.fail('Destroyed response became ready'),
    onFailure: (error) => failures.push(error),
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].statusCode, 502);
  for (const value of [
    '',
    'SECRET',
    'null',
    '[]',
    '{"stream":"SECRET"}',
    '{"response_format":"SECRET"}',
    '{"response_format":[]}',
    '{"response_format":{"type":"json_object","extra":"SECRET"}}',
    '{"response_format":{"type":"text"},"text":{"format":{"type":"json_object"}}}',
  ]) {
    const capture = createDirectRequestObserver(4096);
    capture.observer.resume();
    const res = upstream();
    const failures = [];
    deferDirectResponse({
      capture,
      proxyRes: res,
      onReady: () => assert.fail('Invalid body became ready'),
      onFailure: (error) => failures.push(error),
    });
    const failed = once(capture.observer, 'error');
    capture.observer.end(value);
    const [error] = await failed;
    assert.equal(error.code, 'invalid_request_error');
    assert.equal(error.message.includes('SECRET'), false);
    assert.equal(failures.length, 1);
    assert.equal(res.destroyed, true);
  }
  const limited = createDirectRequestObserver(4);
  limited.observer.resume();
  const over = once(limited.observer, 'error');
  limited.observer.end('12345');
  assert.equal((await over)[0].statusCode, 413);
  for (const event of ['error', 'close', 'aborted']) {
    const capture = createDirectRequestObserver(4096);
    capture.observer.resume();
    const res = upstream();
    const failures = [];
    deferDirectResponse({
      capture,
      proxyRes: res,
      onReady: () => assert.fail('Aborted upstream became ready'),
      onFailure: (error) => failures.push(error),
    });
    res.emit(event, new Error('SECRET'));
    capture.observer.end('{}');
    await once(capture.observer, 'finish');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].statusCode, 502);
    assert.equal(failures[0].message.includes('SECRET'), false);
    assert.equal(res.destroyed, true);
  }
  const cancelled = createDirectRequestObserver(4096);
  const resCancelled = upstream();
  let failed = 0;
  deferDirectResponse({
    capture: cancelled,
    proxyRes: resCancelled,
    onReady: () => assert.fail('Cancelled upload became ready'),
    onFailure: () => {
      failed++;
    },
  });
  const closed = once(cancelled.observer, 'close');
  cancelled.observer.destroy();
  await closed;
  assert.equal(failed, 1);
  console.log('direct-request-contract.test.js passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
