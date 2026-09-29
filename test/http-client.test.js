const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const { AbortController } = globalThis;

const { createHttpClient } = require('../lib/proxy/http-client');

(async () => {
  const originalRequest = http.request;
  let capturedOptions = null;
  http.request = (options, callback) => {
    capturedOptions = options;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = (err) => {
      if (err) process.nextTick(() => req.emit('error', err));
    };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      callback(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from('ok'));
        res.emit('end');
      });
    };
    return req;
  };

  try {
    const makeRequest = createHttpClient();
    let response = await makeRequest('http://example.test:1234/path?q=1', {
      timeout: 'Infinity',
    });
    assert.strictEqual(response.body, 'ok');
    assert.strictEqual(capturedOptions.port, 1234);
    assert.strictEqual(capturedOptions.timeout, 10000);

    const controller = new AbortController();
    await makeRequest('http://example.test/path', { signal: controller.signal });
    assert.strictEqual(capturedOptions.signal, controller.signal);

    response = await makeRequest('http://example.test/path', {
      timeout: 0,
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(capturedOptions.port, 80);
    assert.strictEqual(capturedOptions.timeout, 100);

    await assert.rejects(
      () => makeRequest('http://example.test/path', { maxResponseBytes: 1 }),
      /Response body too large/
    );
  } finally {
    http.request = originalRequest;
  }

  console.log('[http-client.test] ok');
})();
