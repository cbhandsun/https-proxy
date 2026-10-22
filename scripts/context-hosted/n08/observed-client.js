'use strict';
const http = require('node:http');
const { exact } = require('../shared/boundary.js');
const fail = () => new Error('n08_observed_request_rejected');

// Fixed continuation request. The byte counter observes actual client data,
// including bytes received before settlement; it is never a scenario assertion.
function startObservedContinuation(input) {
  const options = exact(input, ['entryPort', 'entryKey', 'body']);
  if (
    !Number.isInteger(options.entryPort) ||
    options.entryPort < 1024 ||
    options.entryPort > 65535 ||
    typeof options.entryKey !== 'string' ||
    !/^[a-f0-9]{48}$/.test(options.entryKey) ||
    !Buffer.isBuffer(options.body) ||
    options.body.length < 2 ||
    options.body.length > 262144
  )
    throw fail();
  const body = Buffer.from(options.body);
  let observedBytes = 0,
    request,
    settled = false,
    settle;
  const result = new Promise((resolve) => {
    settle = resolve;
  });
  const finish = (response) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    settle(response ? { response } : { failed: true });
  };
  const timeout = setTimeout(() => {
    finish(null);
    request?.destroy();
  }, 15000);
  try {
    request = http.request(
      {
        host: '127.0.0.1',
        port: options.entryPort,
        method: 'POST',
        path: '/v1/responses',
        agent: false,
        headers: {
          authorization: 'Bearer ' + options.entryKey,
          'content-type': 'application/json',
          'content-length': body.length,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => {
          observedBytes += chunk.length;
          if (observedBytes > 262144) {
            finish(null);
            request.destroy();
          } else chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          const status = response.statusCode;
          if (
            !Number.isInteger(status) ||
            status < 100 ||
            status > 599 ||
            (status >= 300 && status < 400)
          )
            finish(null);
          else finish({ status, bytes: Buffer.concat(chunks) });
        });
        response.on('aborted', () => finish(null));
        response.on('error', () => finish(null));
      }
    );
    request.on('error', () => finish(null));
    request.end(body);
  } catch {
    finish(null);
    request?.destroy();
  }
  return Object.freeze({
    result,
    bytes: () => observedBytes,
    cancel() {
      finish(null);
      request?.destroy();
      return true;
    },
  });
}
module.exports = { startObservedContinuation };
