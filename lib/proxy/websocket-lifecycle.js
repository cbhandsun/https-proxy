'use strict';

// One upgrade owns both transport peers. Closing during asynchronous credential
// resolution or before the upstream handshake must also cancel pending work.
const MAX_PENDING_BYTES = 2 * 1024 * 1024;

function createWebSocketLifecycle(client, head = Buffer.alloc(0)) {
  let closed = Boolean(client.destroyed);
  let request = null;
  let upstream = null;
  let upgraded = false;
  const destroyed = new WeakSet();
  let pending = Buffer.alloc(0);
  let length = 0;

  function destroy(endpoint) {
    if (!endpoint || destroyed.has(endpoint)) return;
    destroyed.add(endpoint);
    if (!endpoint.destroyed) endpoint.destroy();
  }

  function close() {
    if (closed) return;
    closed = true;
    pending = Buffer.alloc(0);
    length = 0;
    client.removeListener('data', capture);
    destroy(request);
    destroy(upstream);
    destroy(client);
  }

  function watch(socket) {
    socket.once('close', close);
    socket.once('end', close);
    socket.on('error', close);
  }

  function capture(chunk) {
    if (closed) return;
    if (!Buffer.isBuffer(chunk) || chunk.length > MAX_PENDING_BYTES - length) {
      close();
      return;
    }
    const size = length + chunk.length;
    if (size > pending.length) {
      const next = Buffer.allocUnsafe(
        Math.min(MAX_PENDING_BYTES, Math.max(size, pending.length * 2, 4096))
      );
      pending.copy(next, 0, 0, length);
      pending = next;
    }
    chunk.copy(pending, length);
    length = size;
  }

  watch(client);
  capture(head);
  // Reading while the handshake is pending makes EOF observable. Capture every
  // byte, then restore it under pause before handing ownership to socket.pipe.
  if (!closed) {
    client.on('data', capture);
    client.resume();
  }
  return {
    available: () => !closed && !client.destroyed,
    upgraded: () => upgraded,
    close,
    attachRequest(value) {
      if (closed || client.destroyed || request) {
        destroy(value);
        return false;
      }
      request = value;
      return true;
    },
    attachSocket(value) {
      if (closed || client.destroyed || upstream) {
        destroy(value);
        return false;
      }
      upstream = value;
      upgraded = true;
      watch(upstream);
      client.pause();
      client.removeListener('data', capture);
      if (length) client.unshift(pending.subarray(0, length));
      pending = Buffer.alloc(0);
      length = 0;
      return true;
    },
  };
}

module.exports = { createWebSocketLifecycle };
