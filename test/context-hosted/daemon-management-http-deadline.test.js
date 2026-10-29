'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createDaemonManagementHttpClient,
} = require('../../scripts/lib/context-recovery-daemon-http-client.js');
const {
  nativeHttpFailureCode,
} = require('../../scripts/lib/context-recovery-daemon-http-failure.js');

test('native HTTP failure codes reject hooks, proxies, unknown and forged diagnostic codes', () => {
  let traps = 0;
  const getter = {
    get code() {
      traps++;
      throw new Error('PRIVATE');
    },
  };
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error('PRIVATE');
      },
    }
  );
  for (const input of [
    null,
    undefined,
    '',
    0,
    [],
    {},
    getter,
    proxy,
    { code: 'PRIVATE' },
    { code: 'HPM_DAEMON_HTTP_CONNECTION_REFUSED' },
    Object.create({ code: 'ECONNREFUSED' }),
  ])
    assert.equal(nativeHttpFailureCode(input), undefined);
  assert.equal(traps, 0);
});

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

test('management HTTP failure categories preserve only fixed native codes and bounded reply stages', async () => {
  for (const [mode, expected] of [
    ['ECONNREFUSED', 'CONNECTION_REFUSED'],
    ['ECONNRESET', 'CONNECTION_RESET'],
    ['aborted', 'ABORTED'],
    ['invalid', 'INVALID_REPLY'],
    ['limit', 'REPLY_LIMIT'],
  ]) {
    const client = createDaemonManagementHttpClient(
      { port: 12345, token: '1'.repeat(48) },
      (_options, accept) => {
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = () =>
          queueMicrotask(() => {
            if (mode.startsWith('ECONN')) {
              request.emit(
                'error',
                Object.assign(new Error('PRIVATE'), { code: mode, secret: 'PRIVATE' })
              );
              return;
            }
            const response = new EventEmitter();
            response.statusCode = 200;
            accept(response);
            if (mode === 'aborted') response.emit('aborted');
            if (mode === 'limit') response.emit('data', Buffer.alloc(300000));
            if (mode === 'invalid') {
              response.emit('data', '{PRIVATE');
              response.emit('end');
            }
          });
        return request;
      }
    );
    await assert.rejects(client({ method: 'GET', route: '/v1/local/health' }), (error) => {
      assert.equal(error.message, 'daemon_http_request_failed');
      assert.equal(error.code, 'HPM_DAEMON_HTTP_' + expected);
      assert.deepEqual(Object.keys(error), ['code']);
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
});
