'use strict';

const http = require('node:http');

function createProxyFixtureHealthProbe(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw new TypeError('Invalid fixture health probe input');
  const values = {};
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      !['port', 'pid', 'entryPort', 'token', 'request'].includes(key) ||
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable
    )
      throw new TypeError('Invalid fixture health probe input');
    values[key] = descriptor.value;
  }
  const { port, pid, entryPort, token, request = http.request } = values;
  if (
    ![port, entryPort].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= 65535
    ) ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    typeof token !== 'string' ||
    !token ||
    token.length > 4096 ||
    [...token].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    typeof request !== 'function'
  )
    throw new TypeError('Invalid fixture health probe input');

  return function probe(signal) {
    if (!(signal instanceof globalThis.AbortSignal))
      return Promise.reject(new TypeError('Invalid fixture health probe signal'));
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      let settled = false;
      let req;
      const cancelled = () => finish(false);
      function finish(ready) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancelled);
        req?.destroy();
        resolve(ready === true);
      }
      signal.addEventListener('abort', cancelled, { once: true });
      try {
        req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: '/v1/local/health',
            headers: { 'x-mgmt-token': token },
            signal,
          },
          (res) => {
            const chunks = [];
            let bytes = 0;
            res.on('error', () => finish(false));
            if (res.statusCode !== 200) {
              finish(false);
              return;
            }
            res.on('data', (chunk) => {
              if (settled) return;
              if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
                finish(false);
                return;
              }
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > 4096) {
                finish(false);
                return;
              }
              chunks.push(buffer);
            });
            res.on('end', () => {
              if (settled) return;
              let health;
              try {
                health = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
              } catch {
                finish(false);
                return;
              }
              finish(
                health?.ok === true &&
                  health.appId === 'https-proxy-manager' &&
                  health.status === 'running' &&
                  health.pid === pid &&
                  health.ports?.management === port &&
                  Array.isArray(health.ports.entries) &&
                  health.ports.entries.some(
                    (entry) =>
                      entry?.listenPort === entryPort &&
                      entry.protocol === 'openai-responses' &&
                      entry.tls === false
                  )
              );
            });
            res.on('aborted', () => finish(false));
          }
        );
        req.on('error', () => finish(false));
        req.setTimeout(500, () => {
          finish(false);
        });
        req.end();
      } catch {
        settled = true;
        signal.removeEventListener('abort', cancelled);
        req?.destroy();
        reject(new Error('Fixture health probe failed'));
      }
    });
  };
}

module.exports = { createProxyFixtureHealthProbe };
