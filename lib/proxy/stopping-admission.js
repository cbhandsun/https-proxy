'use strict';

// Stop only new business admission. An upgrade on a connection with an already
// admitted response must wait for that response before closing the socket.
function createStoppingAdmission({ isStopping, handleRequest, handleUpgrade }) {
  if (
    typeof isStopping !== 'function' ||
    typeof handleRequest !== 'function' ||
    (handleUpgrade !== undefined && typeof handleUpgrade !== 'function')
  )
    throw new TypeError('Invalid stopping admission composition');
  const connections = new WeakMap();
  function rejectUpgrade(socket) {
    if (!socket.destroyed && !socket.writableEnded)
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
      );
  }
  return Object.freeze({
    request(req, res, entry) {
      if (isStopping()) {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Connection: 'close',
        });
        res.end(JSON.stringify({ error: 'Server is stopping' }));
        return;
      }
      const socket = req.socket;
      let state = connections.get(socket);
      if (!state) {
        state = { active: 0, rejectedUpgrade: false };
        connections.set(socket, state);
      }
      state.active++;
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        res.removeListener('finish', release);
        res.removeListener('close', release);
        state.active--;
        if (state.active === 0) {
          connections.delete(socket);
          if (state.rejectedUpgrade) rejectUpgrade(socket);
        }
      };
      res.once('finish', release);
      res.once('close', release);
      try {
        return handleRequest(req, res, entry);
      } catch (error) {
        release();
        throw error;
      }
    },
    upgrade(req, socket, head, entry) {
      if (isStopping()) {
        const state = connections.get(socket);
        if (state?.active) state.rejectedUpgrade = true;
        else rejectUpgrade(socket);
        return;
      }
      return handleUpgrade(req, socket, head, entry);
    },
  });
}

module.exports = { createStoppingAdmission };
