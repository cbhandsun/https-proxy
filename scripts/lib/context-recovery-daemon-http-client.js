'use strict';

const http = require('node:http');
const { own, callable, dataSnapshot } = require('./context-recovery-daemon-http-boundary');

const ROUTES = new Set(['GET /v1/local/health', 'GET /v1/local/config', 'POST /v1/local/config']);
const MAX_BYTES = 256 * 1024;

// The token stays in this closure. Only fixed loopback routes are reachable;
// redirects, inherited proxies and arbitrary URL/headers are unsupported.
function createDaemonManagementHttpClient(options, httpRequest = http.request) {
  const port = own(options, 'port', 'invalid_http_client');
  const token = own(options, 'token', 'invalid_http_client');
  if (
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof token !== 'string' ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(token) ||
    !callable(httpRequest)
  )
    throw new Error('invalid_http_client');
  return async (input) => {
    input = dataSnapshot(input, 'invalid_http_request');
    const method = own(input, 'method', 'invalid_http_request');
    const route = own(input, 'route', 'invalid_http_request');
    if (
      typeof method !== 'string' ||
      typeof route !== 'string' ||
      !ROUTES.has(`${method} ${route}`)
    )
      throw new Error('invalid_http_request');
    let body;
    try {
      body = method === 'POST' ? JSON.stringify(input.body) : '';
    } catch {
      throw new Error('invalid_http_request');
    }
    if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BYTES)
      throw new Error('invalid_http_request');
    return new Promise((resolve, reject) => {
      let finished = false;
      let request;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (result) resolve(result);
        else reject(new Error('daemon_http_request_failed'));
      };
      const timer = setTimeout(() => {
        finish(null);
        request?.destroy();
      }, 2000);
      try {
        request = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: route,
            method,
            agent: false,
            headers: {
              'x-mgmt-token': token,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks = [];
            let size = 0;
            response.on('error', () => finish(null));
            response.on('aborted', () => finish(null));
            response.on('data', (chunk) => {
              if (finished) return;
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += buffer.length;
              if (size > MAX_BYTES) {
                finish(null);
                request?.destroy();
              } else chunks.push(buffer);
            });
            response.on('end', () => {
              if (finished) return;
              try {
                const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!value || typeof value !== 'object' || Array.isArray(value))
                  return finish(null);
                finish({ status: response.statusCode, body: value });
              } catch {
                finish(null);
              }
            });
          }
        );
        request.on('error', () => finish(null));
        request.end(body);
      } catch {
        finish(null);
        request?.destroy();
      }
    });
  };
}

module.exports = { createDaemonManagementHttpClient };
