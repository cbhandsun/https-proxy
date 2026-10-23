'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createDaemonManagementHttpClient,
} = require('../../scripts/lib/context-recovery-daemon-http-client.js');

test('management request retains two second deadline and fixed failure code without child error data', async () => {
  let destroyed = 0;
  let writes = 0;
  const client = createDaemonManagementHttpClient({ port: 12345, token: '1'.repeat(48) }, () => {
    const request = new EventEmitter();
    request.end = () => {
      writes++;
    };
    request.destroy = () => {
      destroyed++;
      request.emit('error', new Error('PRIVATE_DEADLINE_SENTINEL'));
    };
    return request;
  });
  await assert.rejects(client({ method: 'POST', route: '/v1/local/config', body: {} }), {
    message: 'daemon_http_request_failed',
    code: 'HPM_DAEMON_HTTP_DEADLINE',
  });
  assert.equal(destroyed, 1);
  assert.equal(writes, 1);
});

test('management transport errors cannot forge deadline or disclose raw error fields', async () => {
  const client = createDaemonManagementHttpClient({ port: 12345, token: '1'.repeat(48) }, () => {
    const request = new EventEmitter();
    request.end = () =>
      queueMicrotask(() =>
        request.emit(
          'error',
          Object.assign(new Error('PRIVATE_TRANSPORT_SENTINEL'), {
            code: 'HPM_DAEMON_HTTP_DEADLINE',
          })
        )
      );
    request.destroy = () => {};
    return request;
  });
  await assert.rejects(client({ method: 'GET', route: '/v1/local/health' }), (error) => {
    assert.equal(error.message, 'daemon_http_request_failed');
    assert.equal(Object.hasOwn(error, 'code'), false);
    return true;
  });
});
