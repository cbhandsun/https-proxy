'use strict';

const http = require('node:http');
const fail = () => new Error('installed_websocket_auth_failed');

// Real Upgrade refusal, no token or response body enters a receipt. Completion
// requires both the bounded HTTP response and the owned transport's close.
function startInstalledWebSocketRefusal(port, model) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || model !== 'hpm-installed-codex')
    throw fail();
  let response, socket, cleanup;
  let ended = false,
    closed = false,
    failed = false,
    settled = false,
    code;
  let accept, refuse, finishRequest, finishSocket;
  const result = new Promise((resolve, reject) => {
    accept = resolve;
    refuse = reject;
  });
  void result.catch(() => {});
  const requestEnd = new Promise((resolve) => {
    finishRequest = resolve;
  });
  const socketEnd = new Promise((resolve) => {
    finishSocket = resolve;
  });
  const finish = () => {
    if (failed || settled) return;
    if (ended && closed) {
      if (code !== 401) return reject();
      settled = true;
      accept(true);
    }
  };
  function reject() {
    if (settled) return;
    failed = true;
    settled = true;
    refuse(fail());
    response?.destroy();
    request?.destroy();
    socket?.destroy();
  }
  const request = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/v1/responses',
      method: 'GET',
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.alloc(16).toString('base64'),
        authorization: 'Bearer hpm-synthetic-unauthorized',
        'x-codex-routing-hint': 'model=' + model,
      },
    },
    (incoming) => {
      response = incoming;
      code = incoming.statusCode;
      let bytes = 0;
      incoming.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) reject();
      });
      incoming.once('error', reject);
      incoming.once('aborted', reject);
      incoming.once('end', () => {
        ended = true;
        finish();
      });
    }
  );
  request.once('socket', (owned) => {
    socket = owned;
    socket.once('close', () => {
      closed = true;
      finishSocket();
      if (!ended) reject();
      else finish();
    });
  });
  request.once('upgrade', (_response, owned) => {
    owned.destroy();
    reject();
  });
  request.once('error', reject);
  request.once('close', () => {
    finishRequest();
  });
  request.end();
  return Object.freeze({
    result,
    close() {
      if (cleanup) return cleanup;
      if (!settled) reject();
      response?.destroy();
      request.destroy();
      socket?.destroy();
      cleanup = requestEnd.then(() => (socket ? socketEnd : undefined)).then(() => true);
      return cleanup;
    },
  });
}
module.exports = { startInstalledWebSocketRefusal };
