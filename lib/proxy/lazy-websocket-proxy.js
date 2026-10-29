'use strict';

const { createLogger } = require('./logger');
const log = createLogger('websocket');

// Keep the shared lifecycle and live configuration getters at the composition
// root; defer only the WebSocket implementation graph until an upgrade arrives.
function createLazyWebSocketProxy(dependencies, options = {}) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
    throw new TypeError('Invalid WebSocket dependencies');
  const loadModule = options.loadModule ?? (() => require('./websocket-proxy'));
  if (typeof loadModule !== 'function') throw new TypeError('Invalid WebSocket module loader');
  let handler;
  let initializing = false;
  function resolve() {
    if (handler) return handler;
    if (initializing) throw new Error('Recursive WebSocket initialization');
    initializing = true;
    try {
      const loaded = loadModule();
      if (typeof loaded?.createWebSocketProxy !== 'function')
        throw new TypeError('Invalid WebSocket module');
      const created = loaded.createWebSocketProxy(dependencies);
      if (typeof created !== 'function') throw new TypeError('Invalid WebSocket handler');
      handler = created;
      return handler;
    } finally {
      initializing = false;
    }
  }
  return function handleUpgrade(request, socket, ...args) {
    let selected;
    try {
      selected = resolve();
    } catch {
      log.error('websocket_initialization_failed');
      try {
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
        );
      } catch {
        socket.destroy();
      }
      return;
    }
    return Reflect.apply(selected, this, [request, socket, ...args]);
  };
}

module.exports = { createLazyWebSocketProxy };
