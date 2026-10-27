'use strict';

const { types } = require('node:util');
const { WebSocketServer } = require('ws');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');
const { exact } = require('../context-hosted/shared/boundary');
const { createInstalledClientListener } = require('../context-hosted/shared/hosted-listener');
const fail = () => new Error('installed_websocket_listener_failed');
const callable = (value) => typeof value === 'function' && !types.isProxy(value);
function method(owner, name) {
  for (
    let current = owner, depth = 0;
    current && depth < 8;
    depth++, current = Object.getPrototypeOf(current)
  ) {
    if (types.isProxy(current)) throw fail();
    const field = Object.getOwnPropertyDescriptor(current, name);
    if (field) {
      if (!Object.hasOwn(field, 'value') || !callable(field.value)) throw fail();
      return Function.prototype.bind.call(field.value, owner);
    }
  }
  throw fail();
}

// Installed-fixture capability only. The synchronous gate authenticates the
// synthetic upstream before any 101 response. Neither headers nor frames leave
// this owner, and this transport alone never grants daemon qualification.
function attachInstalledWebSocketListener(server, prepare) {
  if (
    !server ||
    types.isProxy(server) ||
    !callable(prepare) ||
    types.isAsyncFunction(prepare) ||
    types.isGeneratorFunction(prepare)
  )
    throw fail();
  const on = method(server, 'on'),
    removeListener = method(server, 'removeListener');
  const upstream = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  let accepted = 0,
    rejected = 0,
    failed = false,
    closing = false,
    completion;
  const peers = new Set();
  const handlers = new Set();
  function upgrade(request, socket, head) {
    let handler;
    try {
      if (
        closing ||
        failed ||
        accepted >= 8 ||
        peers.size >= 4 ||
        request.method !== 'GET' ||
        request.url !== '/v1/responses' ||
        socket.remoteAddress !== '127.0.0.1' ||
        socket.servername !== 'api.openai.com' ||
        !Buffer.isBuffer(head) ||
        head.length > 4096 ||
        typeof request.headers.authorization !== 'string' ||
        !/^Bearer hpm-upstream-[a-f0-9]{32}$/.test(request.headers.authorization)
      )
        throw fail();
      handler = prepare({ path: request.url, authorization: request.headers.authorization });
      if (!callable(handler) || types.isGeneratorFunction(handler)) {
        if (nativeReaderPromise(handler))
          void Promise.prototype.then.call(
            handler,
            () => {},
            () => {}
          );
        throw fail();
      }
      upstream.handleUpgrade(request, socket, head, (peer) => {
        accepted++;
        peers.add(peer);
        peer.once('close', () => peers.delete(peer));
        const reject = () => {
          failed = true;
          peer.terminate();
        };
        peer.on('error', reject);
        // Enroll before invoking the capability: it may request close while
        // still synchronously returning its own asynchronous completion.
        let finish;
        const owned = new Promise((resolve) => {
          finish = resolve;
        });
        handlers.add(owned);
        const done = () => {
          handlers.delete(owned);
          finish();
        };
        try {
          const pending = handler(peer);
          if (pending !== undefined) {
            if (!nativeReaderPromise(pending)) throw fail();
            void Promise.prototype.then.call(pending, done, () => {
              reject();
              done();
            });
          } else done();
        } catch {
          reject();
          done();
        }
      });
    } catch {
      rejected = Math.min(9, rejected + 1);
      failed = true;
      socket.destroy();
    }
  }
  upstream.on('wsClientError', (_error, socket) => {
    rejected = Math.min(9, rejected + 1);
    failed = true;
    socket.destroy();
  });
  on('upgrade', upgrade);
  return Object.freeze({
    inspect: () => Object.freeze({ accepted, rejected, active: peers.size, failed }),
    close() {
      if (completion) return completion;
      closing = true;
      removeListener('upgrade', upgrade);
      // Wait for actual close events, including every pending async handler's
      // owned peer. The existing outer Job remains the cleanup deadline.
      const closed = new Promise((resolve) => {
        for (const peer of peers) peer.terminate();
        upstream.close((error) => resolve(!error && peers.size === 0));
      });
      completion = Promise.all([closed, ...handlers]).then(
        ([done]) => done && !failed && peers.size === 0
      );
      return completion;
    },
  });
}

// Keep ws outside the core-only N08/N09 closure. Only the installed fixture
// selects this composition; its original TLS/path/firewall lease stays intact.
async function createInstalledWebSocketListener(input) {
  const options = exact(input, [
    'networkRoot',
    'ownedNode',
    'negativeAddress',
    'onBusinessRequest',
    'prepareUpgrade',
  ]);
  if (
    !callable(options.prepareUpgrade) ||
    types.isAsyncFunction(options.prepareUpgrade) ||
    types.isGeneratorFunction(options.prepareUpgrade)
  )
    throw fail();
  const { prepareUpgrade, ...listener } = options;
  return createInstalledClientListener(listener, (server) =>
    attachInstalledWebSocketListener(server, prepareUpgrade)
  );
}

module.exports = { attachInstalledWebSocketListener, createInstalledWebSocketListener };
