'use strict';

const http = require('node:http');
const fail = () => new Error('installed_client_loopback_failed');
async function assertEntryRefuses(owner, client, model) {
  const port = owner.identity.entryPort;
  if (
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !['codex', 'claude'].includes(client) ||
    !/^[a-z0-9-]{1,128}$/.test(model)
  )
    throw fail();
  for (const token of [null, 'hpm-synthetic-unauthorized'])
    await new Promise((resolve, reject) => {
      let complete = false;
      const finish = (ok) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        ok ? resolve() : reject(fail());
      };
      const body = Buffer.from(
        JSON.stringify(
          client === 'codex'
            ? { model, input: 'Unauthorized synthetic probe', stream: false }
            : {
                model,
                messages: [{ role: 'user', content: 'Unauthorized synthetic probe' }],
                max_tokens: 1,
                stream: false,
              }
        )
      );
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: client === 'codex' ? '/v1/responses' : '/v1/messages',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            ...(token ? { authorization: 'Bearer ' + token } : {}),
          },
        },
        (response) => {
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 4096) {
              finish(false);
              request.destroy();
            }
          });
          response.on('error', () => finish(false));
          response.on('aborted', () => finish(false));
          response.on('end', () => finish([401, 403].includes(response.statusCode)));
        }
      );
      const timer = setTimeout(() => {
        finish(false);
        request.destroy();
      }, 2000);
      request.on('error', () => finish(false));
      request.end(body);
    });
  return true;
}
async function createSyntheticSourceServer(text, onCall) {
  if (
    typeof text !== 'string' ||
    !text.startsWith('Synthetic original Unicode 中文🙂\r\n') ||
    Buffer.byteLength(text) > 32000 ||
    typeof onCall !== 'function'
  )
    throw fail();
  let calls = 0,
    failed = false;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const reject = () => {
      failed = true;
      response.destroy();
      request.destroy();
    };
    if (
      request.socket.remoteAddress !== '127.0.0.1' ||
      request.method !== 'POST' ||
      request.url !== '/synthetic-original' ||
      calls !== 0
    ) {
      reject();
      return;
    }
    let buffer = Buffer.alloc(0);
    request.on('data', (chunk) => {
      if (buffer.length + chunk.length > 2) reject();
      else buffer = Buffer.concat([buffer, chunk]);
    });
    request.on('error', () => {
      failed = true;
    });
    request.on('aborted', () => {
      failed = true;
    });
    request.on('end', () => {
      try {
        if (failed || !buffer.equals(Buffer.from('{}')) || calls !== 0 || onCall() !== undefined)
          throw fail();
        calls++;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(text);
      } catch {
        reject();
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(fail()));
    server.listen(0, '127.0.0.1', resolve);
  });
  let ended = false;
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/synthetic-original',
    inspect: () => ({ calls, failed, closed: ended }),
    async close() {
      if (ended) return true;
      ended = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      return true;
    },
  };
}
module.exports = { assertEntryRefuses, createSyntheticSourceServer };
