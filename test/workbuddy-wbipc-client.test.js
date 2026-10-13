'use strict';

const assert = require('assert');

const { FakeWbipcSocket } = require('./helpers/workbuddy-wbipc-socket');

const { createWorkBuddyWbipcClient } = require('../lib/proxy/workbuddy-wbipc-client');

async function main() {
  const ticket = 'test-ticket-value-that-is-not-a-secret';
  const endpoint = '\\\\.\\pipe\\wbipc-test';
  let fetchParams = null;
  const client = createWorkBuddyWbipcClient({
    readEndpoint() {
      return { endpoint, ticket };
    },
    connect(target) {
      assert.strictEqual(target, endpoint);
      return new FakeWbipcSocket(ticket, endpoint, (params) => {
        fetchParams = params;
      });
    },
    timeoutMs: 1000,
  });

  const result = await client.request({
    method: 'POST',
    path: '/v2/chat/completions',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: Buffer.from('{"model":"demo"}'),
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(JSON.parse(result.body), { ok: true });
  assert.strictEqual(fetchParams.method, 'POST');
  assert.strictEqual(fetchParams.path, '/v2/chat/completions');
  assert.strictEqual(fetchParams.headers.authorization, undefined);
  assert.strictEqual(fetchParams.body_b64, Buffer.from('{"model":"demo"}').toString('base64'));

  const unavailable = await createWorkBuddyWbipcClient({
    autoStart: false,
    readEndpoint() {
      return null;
    },
  }).request({ method: 'POST', path: '/v2/chat/completions', body: '{}' });
  assert.deepStrictEqual(unavailable, { ok: false, status: 'not_available' });

  const oversized = await createWorkBuddyWbipcClient({
    readEndpoint: () => ({ endpoint, ticket }),
    connect() {
      const socket = new FakeWbipcSocket(ticket, endpoint, () => {});
      const send = socket.send.bind(socket);
      socket.send = (frame) => {
        if (frame.result?.body_b64)
          frame.result.body_b64 = Buffer.from('x'.repeat(1024 * 1024)).toString('base64');
        send(frame);
      };
      return socket;
    },
    timeoutMs: 1000,
  }).request({ method: 'POST', path: '/v2/chat/completions', body: '{}' });
  assert.strictEqual(oversized.ok, false, 'WBIPC client must reject an oversized complete result');
  assert.strictEqual(oversized.status, 'protocol_error');
  assert.ok(!oversized.error.includes('test-ticket'));
  console.log('[workbuddy-wbipc-client.test] ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
