'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWebSocketLifecycle } = require('../lib/proxy/websocket-lifecycle');

function endpoint() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroys = 0;
  socket.pause = () => {};
  socket.resume = () => {};
  socket.unshift = () => {};
  socket.destroy = () => {
    socket.destroys++;
    socket.destroyed = true;
    socket.emit('close');
  };
  return socket;
}

test('pending upgrade cancellation destroys the upstream request exactly once', () => {
  for (const event of ['close', 'end', 'error']) {
    const client = endpoint();
    const request = endpoint();
    const lifecycle = createWebSocketLifecycle(client);
    assert.equal(lifecycle.attachRequest(request), true);
    client.emit(event, new Error('synthetic private error'));
    assert.equal(lifecycle.available(), false);
    assert.equal(request.destroys, 1);
    lifecycle.close();
    assert.equal(request.destroys, 1);
    assert.equal(client.destroys, 1);
  }
});

test('late request and upgrade cannot resurrect a closed client', () => {
  const client = endpoint();
  const lifecycle = createWebSocketLifecycle(client);
  client.emit('close');
  const request = endpoint();
  const upstream = endpoint();
  assert.equal(lifecycle.attachRequest(request), false);
  assert.equal(lifecycle.attachSocket(upstream), false);
  assert.equal(request.destroys, 1);
  assert.equal(upstream.destroys, 1);
  assert.equal(lifecycle.upgraded(), false);
});

test('upgraded connection closes both sockets on either peer failure or EOF', () => {
  for (const peer of ['client', 'upstream']) {
    for (const event of ['close', 'end', 'error']) {
      const client = endpoint();
      const request = endpoint();
      const upstream = endpoint();
      const lifecycle = createWebSocketLifecycle(client);
      assert.equal(lifecycle.attachRequest(request), true);
      assert.equal(lifecycle.attachSocket(upstream), true);
      assert.equal(lifecycle.upgraded(), true);
      (peer === 'client' ? client : upstream).emit(event, new Error('synthetic'));
      assert.equal(lifecycle.available(), false);
      assert.equal(client.destroys, 1);
      assert.equal(upstream.destroys, 1);
      assert.equal(request.destroys, 1);
    }
  }
});

test('destroyed clients and duplicate attachments are rejected without replacing the owner', () => {
  const dead = endpoint();
  dead.destroyed = true;
  const unavailable = createWebSocketLifecycle(dead);
  assert.equal(unavailable.available(), false);
  const client = endpoint();
  const lifecycle = createWebSocketLifecycle(client);
  const first = endpoint();
  const second = endpoint();
  assert.equal(lifecycle.attachRequest(first), true);
  assert.equal(lifecycle.attachRequest(second), false);
  assert.equal(second.destroys, 1);
  lifecycle.close();
  assert.equal(first.destroys, 1);
});

test('handshake head and early chunks are restored in order without spare buffer bytes', () => {
  const client = endpoint();
  const head = Buffer.from([0, 255, 17]);
  const lifecycle = createWebSocketLifecycle(client, head);
  const chunks = [Buffer.alloc(0), Buffer.from('🙂'), Buffer.alloc(4096, 7)];
  for (const chunk of chunks) client.emit('data', chunk);
  assert.equal(client.listenerCount('data'), 1);
  let restored;
  client.unshift = (data) => {
    restored = data;
  };
  assert.equal(lifecycle.attachSocket(endpoint()), true);
  assert.deepEqual(restored, Buffer.concat([head, ...chunks]));
  assert.equal(client.listenerCount('data'), 0);
  lifecycle.close();
});

test('pending upgrade input is bounded and rejects invalid chunks before forwarding', () => {
  for (const invalid of ['private input', null, Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    const client = endpoint();
    const lifecycle = createWebSocketLifecycle(client);
    const request = endpoint();
    lifecycle.attachRequest(request);
    client.emit('data', invalid);
    assert.equal(lifecycle.available(), false);
    assert.equal(request.destroys, 1);
    assert.equal(client.listenerCount('data'), 0);
    assert.equal(lifecycle.attachSocket(endpoint()), false);
  }
  const client = endpoint();
  const lifecycle = createWebSocketLifecycle(client, Buffer.alloc(2 * 1024 * 1024));
  assert.equal(lifecycle.available(), true);
  client.emit('data', Buffer.from([1]));
  assert.equal(lifecycle.available(), false);
  const oversized = endpoint();
  assert.equal(
    createWebSocketLifecycle(oversized, Buffer.alloc(2 * 1024 * 1024 + 1)).available(),
    false
  );
});
