'use strict';
const http = require('node:http');
const { exact } = require('../shared/boundary.js');
const fail = () => new Error('n08_observed_request_rejected');

// Fixed continuation request. The byte counter observes actual client data,
// including bytes received before settlement; it is never a scenario assertion.
function startObserved(input, transportCancellation) {
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
    termination = 'pending',
    request,
    settled = false,
    settle,
    cancelRequested = false;
  const result = new Promise((resolve) => {
    settle = resolve;
  });
  const finish = (response, reason = 'transport-error') => {
    if (settled) return;
    settled = true;
    termination = response ? 'response' : reason;
    clearTimeout(timeout);
    settle(response ? { response } : { failed: true });
  };
  const transportFailure = () => {
    if (!transportCancellation || !cancelRequested) finish(null);
  };
  const timeout = setTimeout(() => {
    finish(null, 'timeout');
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
        response.on('aborted', transportFailure);
        response.on('error', transportFailure);
      }
    );
    request.on('error', transportFailure);
    request.on('close', () => {
      if (transportCancellation && cancelRequested && !settled)
        finish(
          null,
          request.destroyed === true && request.socket?.destroyed === true
            ? 'cancelled-transport'
            : 'setup-error'
        );
    });
    request.end(body);
  } catch {
    finish(null, 'setup-error');
    request?.destroy();
  }
  return Object.freeze({
    result,
    bytes: () => observedBytes,
    termination: () => termination,
    cancel() {
      if (transportCancellation) {
        cancelRequested = true;
        request?.destroy();
      } else {
        finish(null, 'cancelled');
        request?.destroy();
      }
      return true;
    },
  });
}
const startObservedContinuation = (input) => startObserved(input, false);
const startCancellationObservedContinuation = (input) => startObserved(input, true);
module.exports = { startObservedContinuation, startCancellationObservedContinuation };
