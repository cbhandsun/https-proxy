'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { startInstalledWebSocketRefusal } = require('../scripts/lib/nsis-installed-websocket-auth');

async function fixture(t, mode) {
  const sockets = new Set();
  const server = http.createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_request, socket) => {
    if (mode === 'early') {
      socket.destroy();
      return;
    }
    if (mode === 'upgrade') {
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
      );
      return;
    }
    const status = mode === 'wrong' ? 503 : 401;
    if (mode === 'held') {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx'
      );
      return;
    }
    const body = mode === 'oversized' ? 'x'.repeat(4097) : 'fixed-synthetic-denial';
    socket.end(
      'HTTP/1.1 ' +
        status +
        ' Denied\r\nConnection: close\r\nContent-Length: ' +
        body.length +
        '\r\n\r\n' +
        body
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const probe = startInstalledWebSocketRefusal(server.address().port, 'hpm-installed-codex');
  t.after(async () => {
    await probe.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return probe;
}

test('real bounded 401 and actual transport closure are both required for Upgrade refusal', async (t) => {
  const probe = await fixture(t, 'normal');
  assert.equal(await probe.result, true);
  assert.equal(await probe.close(), true);
  assert.equal(probe.close(), probe.close());
});
test('503, a 101, disconnect and excess denial bytes cannot stand in for authentication', async (t) => {
  for (const mode of ['wrong', 'upgrade', 'early', 'oversized']) {
    const probe = await fixture(t, mode);
    await assert.rejects(probe.result, { message: 'installed_websocket_auth_failed' });
    await probe.close();
  }
});
test('forced cleanup of a held denial response cannot create a positive refusal receipt', async (t) => {
  const probe = await fixture(t, 'held');
  let complete = false;
  void probe.result.then(
    () => {
      complete = true;
    },
    () => {}
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(complete, false);
  await probe.close();
  await assert.rejects(probe.result, { message: 'installed_websocket_auth_failed' });
});
test('empty, illegal and extreme destinations cannot open a network resource', () => {
  for (const port of [null, 0, 1023, 65536, NaN, Infinity, '3000', new Proxy({}, {})])
    assert.throws(() => startInstalledWebSocketRefusal(port, 'hpm-installed-codex'));
  for (const model of [null, '', 'gpt-real', 'x'.repeat(1000000), new Proxy({}, {})])
    assert.throws(() => startInstalledWebSocketRefusal(3000, model));
});
