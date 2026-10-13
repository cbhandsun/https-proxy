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
    for (const url of [undefined, null, '', 'invalid-private-marker', 'ftp://example.test']) {
      await assert.rejects(
        () => makeRequest(url),
        (error) => error.code === 'ERR_INVALID_URL' && !error.message.includes('private-marker')
      );
    }
    for (const event of ['timeout', 'aborted', 'close', 'error']) {
      http.request = (_options, callback) => {
        const req = new EventEmitter();
        req.write = () => {};
        req.destroy = () => {};
        req.end = () =>
          process.nextTick(() => {
            if (event === 'timeout') return req.emit('timeout');
            const res = new EventEmitter();
            callback(res);
            res.emit('data', Buffer.from('partial'));
            res.emit(
              event,
              Object.assign(new Error('Response transport failed'), { code: 'ECONNRESET' })
            );
          });
        return req;
      };
      await assert.rejects(
        () => makeRequest('http://example.test'),
        (error) =>
          error.code ===
          (event === 'timeout'
            ? 'ETIMEDOUT'
            : event === 'error'
              ? 'ECONNRESET'
              : 'ERR_RESPONSE_ABORTED')
      );
    }
  } finally {
    http.request = originalRequest;
  }

  const server = http.createServer((_request, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
    setImmediate(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      () => createHttpClient()('http://127.0.0.1:' + server.address().port, { timeout: 1000 }),
      (error) => ['ERR_RESPONSE_ABORTED', 'ECONNRESET'].includes(error.code)
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('[http-client.test] ok');
})();
