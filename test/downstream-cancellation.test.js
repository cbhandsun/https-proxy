'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { createDownstreamCancellation } = require('../lib/proxy/handlers/downstream-cancellation');

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function run() {
  assert.throws(() => createDownstreamCancellation(), /requires request, response, and callback/);

  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    res.once('close', () => upstream.emit('upstream-client-closed'));
  });
  const upstreamPort = await listen(upstream);
  const proxy = http.createServer((clientReq, clientRes) => {
    const outgoing = http.request(
      { host: '127.0.0.1', port: upstreamPort, path: '/', method: 'GET' },
      (proxyRes) => proxyRes.pipe(clientRes)
    );
    outgoing.on('error', () => {});
    const cancellation = createDownstreamCancellation({
      clientReq,
      clientRes,
      onCancel: () => proxy.emit('cancelled'),
    });
    cancellation.setActive(outgoing);
    outgoing.end();
  });
  const proxyPort = await listen(proxy);
  try {
    const cancelled = new Promise((resolve) => proxy.once('cancelled', resolve));
    const upstreamClosed = new Promise((resolve) =>
      upstream.once('upstream-client-closed', resolve)
    );
    await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: proxyPort }, (response) => {
        response.once('data', () => {
          response.destroy();
          resolve();
        });
      });
      request.once('error', reject);
    });
    await Promise.race([
      Promise.all([cancelled, upstreamClosed]),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('upstream was not cancelled')), 1000)
      ),
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
  }

  const request = new EventEmitter();
  const response = new EventEmitter();
  let cancellations = 0;
  let destroyed = 0;
  const guard = createDownstreamCancellation({
    clientReq: request,
    clientRes: response,
    onCancel: () => cancellations++,
  });
  guard.setActive({ destroy: () => destroyed++ });
  response.writableFinished = true;
  response.emit('close');
  assert.equal(guard.isCancelled(), false);
  assert.equal(cancellations, 0);
  assert.equal(destroyed, 0);

  const lateRequest = new EventEmitter();
  const lateResponse = new EventEmitter();
  const lateGuard = createDownstreamCancellation({
    clientReq: lateRequest,
    clientRes: lateResponse,
    onCancel: () => cancellations++,
  });
  lateRequest.emit('aborted');
  lateResponse.emit('close');
  lateGuard.setActive({ destroy: () => destroyed++ });
  assert.equal(lateGuard.isCancelled(), true);
  assert.equal(cancellations, 1);
  assert.equal(destroyed, 1);

  const alreadyClosedRequest = new EventEmitter();
  const alreadyClosedResponse = new EventEmitter();
  alreadyClosedResponse.destroyed = true;
  const alreadyClosedGuard = createDownstreamCancellation({
    clientReq: alreadyClosedRequest,
    clientRes: alreadyClosedResponse,
    onCancel: () => cancellations++,
  });
  alreadyClosedGuard.setActive({ destroy: () => destroyed++ });
  assert.equal(alreadyClosedGuard.isCancelled(), true);
  assert.equal(cancellations, 2);
  assert.equal(destroyed, 2);
  console.log('[downstream-cancellation.test] ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
