'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createClearClient } = require('../../scripts/context-hosted/n09-ipc/clear-client.js');
const options = () => ({ port: 23456, token: 'x'.repeat(32) });
function sender({
  status = 200,
  body = '{"ok":true,"scope":"proxy_context_recovery"}',
  contentType = 'application/json',
  fail,
  capture = () => {},
} = {}) {
  return (requestOptions, receive) => {
    capture(requestOptions);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (input) => {
      assert.equal(input, '{"confirm":true}');
      queueMicrotask(() => {
        if (fail === 'request') {
          req.emit('error', new Error('private'));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = { 'content-type': contentType };
        res.destroy = () => {};
        receive(res);
        if (status !== 200 || contentType !== 'application/json') return;
        if (fail === 'aborted') {
          res.emit('aborted');
          return;
        }
        res.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body));
        res.emit('end');
      });
    };
    return req;
  };
}
test('clear uses only fixed loopback route, body and synthetic token closure', async () => {
  let captured;
  const clear = createClearClient(
    options(),
    sender({
      capture: (value) => {
        captured = value;
      },
    })
  );
  assert.deepEqual(await clear(), {
    kind: 'host-clear-completed',
    durableBoundary: 'await-clearAsync',
  });
  assert.equal(captured.hostname, '127.0.0.1');
  assert.equal(captured.path, '/v1/local/context-recovery/clear');
  assert.equal(captured.agent, false);
});
for (const value of [
  null,
  [],
  {},
  { ...options(), port: 443 },
  { ...options(), port: 65536 },
  { ...options(), token: '' },
  { ...options(), token: 'x'.repeat(257) },
  { ...options(), url: 'https://external' },
])
  test('reject invalid/empty/oversized client config ' + JSON.stringify(value), () => {
    assert.throws(() => createClearClient(value), /n09_clear_ack_failed/);
  });
test('client config getters cannot execute', () => {
  let executed = false;
  const value = options();
  Object.defineProperty(value, 'token', {
    get() {
      executed = true;
      return 'x'.repeat(32);
    },
  });
  assert.throws(() => createClearClient(value), /n09_clear_ack_failed/);
  assert.equal(executed, false);
});
for (const input of [
  { status: 302 },
  { status: 409 },
  { status: 503 },
  { body: '' },
  { body: '{}' },
  { body: '{"ok":true,"scope":"proxy_context_recovery","extra":true}' },
  { body: '{"ok":false,"scope":"proxy_context_recovery"}' },
  { body: 'x'.repeat(1025) },
  { body: Buffer.from([0xc3, 0x28]) },
  { contentType: 'text/plain' },
  { fail: 'request' },
  { fail: 'aborted' },
])
  test('reject nonterminal/unsafe HTTP clear response ' + JSON.stringify(input), async () => {
    const clear = createClearClient(options(), sender(input));
    await assert.rejects(clear(), /^Error: n09_clear_ack_failed$/);
  });
test('deadline rejects a never-completing response without retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sends = 0;
  const clear = createClearClient(options(), () => {
    sends++;
    const req = new EventEmitter();
    req.end = () => {};
    req.destroy = () => {};
    return req;
  });
  const pending = clear();
  t.mock.timers.tick(5000);
  await assert.rejects(pending, /n09_clear_ack_failed/);
  assert.equal(sends, 1);
});
