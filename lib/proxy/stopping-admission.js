'use strict';

// Stop new business admission and own accepted upgrade transports until close.
// Never close a shared connection ahead of its already admitted HTTP responses.
function createStoppingAdmission({ isStopping, handleRequest, handleUpgrade }) {
  if (
    typeof isStopping !== 'function' ||
    typeof handleRequest !== 'function' ||
    (handleUpgrade !== undefined && typeof handleUpgrade !== 'function')
  )
    throw new TypeError('Invalid stopping admission composition');
  const connections = new WeakMap();
  const upgrades = new Map();
  let upgradesClosing = false;
  let upgradeCompletion;
  function observeUpgrade(socket) {
    if (socket.destroyed || upgrades.has(socket)) return () => {};
    if (
      typeof socket.once !== 'function' ||
      typeof socket.removeListener !== 'function' ||
      typeof socket.destroy !== 'function'
    )
      throw new TypeError('Invalid upgrade transport');
    const record = {};
    function remove() {
      upgrades.delete(socket);
      socket.removeListener('close', released);
      const state = connections.get(socket);
      if (state && state.upgradeDrain === record.close) state.upgradeDrain = undefined;
    }
    function released() {
      remove();
      record.closed = true;
      if (!record.destroying) record.finish?.(true);
    }
    record.remove = remove;
    upgrades.set(socket, record);
    socket.once('close', released);
    return remove;
  }
  function closeUpgrades() {
    if (upgradeCompletion) return upgradeCompletion;
    upgradesClosing = true;
    let resolve;
    upgradeCompletion = new Promise((done) => {
      resolve = done;
    });
    const drains = [...upgrades].map(
      ([socket, record]) =>
        new Promise((done) => {
          let settled = false;
          record.finish = (success) => {
            if (settled) return;
            settled = true;
            record.finish = undefined;
            record.remove();
            done(success);
          };
          record.close = () => {
            if (settled) return;
            record.destroying = true;
            try {
              if (typeof socket.destroySoon === 'function') socket.destroySoon();
              else socket.destroy();
              record.destroying = false;
              if (record.closed) record.finish?.(true);
            } catch {
              record.destroying = false;
              record.finish?.(false);
            }
          };
          const state = connections.get(socket);
          if (state?.active) state.upgradeDrain = record.close;
          else record.close();
        })
    );
    void Promise.all(drains).then((results) => resolve(results.every((value) => value === true)));
    return upgradeCompletion;
  }
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
          const drain = state.upgradeDrain;
          state.upgradeDrain = undefined;
          if (drain) drain();
          else if (state.rejectedUpgrade) rejectUpgrade(socket);
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
    closeUpgrades,
    upgrade(req, socket, head, entry) {
      if (upgradesClosing || isStopping()) {
        const state = connections.get(socket);
        if (state?.active) state.rejectedUpgrade = true;
        else rejectUpgrade(socket);
        return;
      }
      const remove = observeUpgrade(socket);
      try {
        return handleUpgrade(req, socket, head, entry);
      } catch (error) {
        remove();
        throw error;
      }
    },
  });
}

module.exports = { createStoppingAdmission };
