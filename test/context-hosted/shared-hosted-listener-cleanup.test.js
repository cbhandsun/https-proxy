'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const {
  closeOwnedListeners,
} = require('../../scripts/context-hosted/shared/hosted-listener-cleanup.js');

test('listener cleanup waits for socket close events after server close callbacks', async () => {
  const sockets = new Set();
  const socket = new EventEmitter();
  socket.destroy = () => {
    setImmediate(() => {
      sockets.delete(socket);
      socket.emit('close');
    });
  };
  sockets.add(socket);
  const listener = {
    listening: true,
    close(done) {
      this.listening = false;
      done();
    },
  };
  assert.equal(await closeOwnedListeners(sockets, [listener]), true);
  assert.equal(sockets.size, 0);
});

test(
  'listener cleanup observes real synthetic loopback socket closure',
  { timeout: 5000 },
  async () => {
    const sockets = new Set();
    let accepted;
    const connected = new Promise((resolve) => {
      accepted = resolve;
    });
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      accepted();
    });
    let client;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      client = net.connect({ host: '127.0.0.1', port: server.address().port });
      client.on('error', () => {});
      await connected;
      assert.equal(await closeOwnedListeners(sockets, [server]), true);
      assert.equal(sockets.size, 0);
    } finally {
      client?.destroy();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  }
);

test('empty and already stopped owned listener cleanup succeeds', async () => {
  assert.equal(await closeOwnedListeners(new Set(), []), true);
  assert.equal(await closeOwnedListeners(new Set(), [{ listening: false }]), true);
});

test('cleanup failure is sanitized and does not skip the other owned resources', async () => {
  let attempts = 0;
  const broken = new EventEmitter();
  broken.destroy = () => {
    attempts++;
    throw Error('PRIVATE_SOCKET_SENTINEL');
  };
  const healthy = new EventEmitter();
  const sockets = new Set([broken, healthy]);
  healthy.destroy = () => {
    attempts++;
    setImmediate(() => {
      sockets.delete(healthy);
      healthy.emit('close');
    });
  };
  const listener = {
    listening: true,
    close(done) {
      attempts++;
      this.listening = false;
      done();
    },
  };
  await assert.rejects(
    closeOwnedListeners(sockets, [listener]),
    /^Error: n08_owned_listener_cleanup_failed$/
  );
  assert.equal(attempts, 3);
  assert.equal(broken.listenerCount('close'), 0);
});

test('listener errors and incomplete socket ownership cleanup fail closed', async () => {
  await assert.rejects(
    closeOwnedListeners(new Set(), [
      {
        listening: true,
        close(done) {
          done(Error('PRIVATE_SOCKET_SENTINEL'));
        },
      },
    ]),
    /^Error: n08_owned_listener_cleanup_failed$/
  );
  const stale = new EventEmitter();
  stale.destroy = () => stale.emit('close');
  assert.equal(await closeOwnedListeners(new Set([stale]), []), false);
});
