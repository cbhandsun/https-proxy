'use strict';
const http = require('node:http');
const fail = () => new Error('n09_clear_ack_failed');

// Separate fixed client. The existing daemon management allowlist is unchanged.
function createClearClient(input, send = http.request) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(fields).sort().join(',') !== 'port,token' ||
    !Object.hasOwn(fields.port, 'value') ||
    !Object.hasOwn(fields.token, 'value') ||
    typeof send !== 'function'
  )
    throw fail();
  const port = fields.port.value;
  const token = fields.token.value;
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof token !== 'string' ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(token)
  )
    throw fail();
  return () =>
    new Promise((resolve, reject) => {
      let settled = false;
      let request;
      let response;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok)
          resolve(
            Object.freeze({ kind: 'host-clear-completed', durableBoundary: 'await-clearAsync' })
          );
        else {
          request?.destroy();
          response?.destroy();
          reject(fail());
        }
      };
      const timer = setTimeout(() => finish(false), 5000);
      try {
        const body = '{"confirm":true}';
        request = Reflect.apply(send, undefined, [
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/local/context-recovery/clear',
            agent: false,
            headers: {
              'x-mgmt-token': token,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
          },
          (incoming) => {
            response = incoming;
            if (
              incoming.statusCode !== 200 ||
              !/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type'] || '')
            ) {
              finish(false);
              return;
            }
            const chunks = [];
            let bytes = 0;
            incoming.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > 1024) {
                finish(false);
                return;
              }
              chunks.push(chunk);
            });
            incoming.once('error', () => finish(false));
            incoming.once('aborted', () => finish(false));
            incoming.once('end', () => {
              try {
                const wire = Buffer.concat(chunks);
                const text = new TextDecoder('utf-8', { fatal: true }).decode(wire);
                const value = JSON.parse(text);
                finish(
                  value !== null &&
                    Object.keys(value).sort().join(',') === 'ok,scope' &&
                    value.ok === true &&
                    value.scope === 'proxy_context_recovery'
                );
              } catch {
                finish(false);
              }
            });
          },
        ]);
        request.once('error', () => finish(false));
        request.end(body);
      } catch {
        finish(false);
      }
    });
}
module.exports = { createClearClient };
