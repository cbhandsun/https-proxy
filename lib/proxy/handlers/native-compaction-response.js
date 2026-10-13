'use strict';

const { TextDecoder } = require('node:util');

const {
  assertNativeCompactionResponse,
  MAX_NATIVE_COMPACTION_BYTES,
} = require('../native-responses-compaction');
const { createLogger } = require('../logger');
const diagnosticLogger = createLogger('native-compaction-response');

// No headers or partial checkpoint escape before the entire native canonical
// window has arrived and passed validation. Cancellation is owned by the
// calling transport; this collector releases its bounded buffers on every exit.
function guardNativeCompactionResponse({
  proxyRes,
  clientRes,
  headers,
  statusCode,
  maxBytes,
  sendJsonError,
  onComplete = () => {},
  onFailure = () => {},
  diagnosticLog = diagnosticLogger,
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Invalid native compaction response limit');
  const limit = Math.min(maxBytes, MAX_NATIVE_COMPACTION_BYTES);
  const chunks = [];
  let bytes = 0;
  let settled = false;
  let publishing = false;
  function report(handler, code) {
    try {
      handler(code);
    } catch {
      diagnosticLog.error(
        { code: 'native_compaction_terminal_log_failed' },
        'Native compaction terminal logging failed'
      );
    }
  }
  function fail(code) {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    let reportedCode = code;
    try {
      if (!clientRes.destroyed && !clientRes.writableEnded) {
        sendJsonError(clientRes, 502, {
          error: {
            type: 'upstream_error',
            code,
            message:
              'Native compaction did not return a complete valid context window; retain the original context.',
          },
        });
      }
    } catch {
      clientRes.destroy();
      reportedCode = 'compaction_publication_failed';
    }
    proxyRes.destroy();
    report(onFailure, reportedCode);
  }
  clientRes.once('finish', () => {
    if (settled || !publishing) return;
    settled = true;
    report(onComplete);
  });
  clientRes.once('close', () => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    proxyRes.destroy();
    if (publishing) report(onFailure, 'compaction_publication_failed');
  });
  proxyRes.on('data', (chunk) => {
    if (settled || publishing) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) return fail('upstream_compaction_too_large');
    chunks.push(buffer);
  });
  proxyRes.once('end', () => {
    if (settled || publishing) return;
    const wire = Buffer.concat(chunks);
    chunks.length = 0;
    try {
      assertNativeCompactionResponse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wire)),
        limit
      );
    } catch {
      fail('upstream_invalid_compaction');
      return;
    }
    if (clientRes.destroyed || clientRes.writableEnded) {
      settled = true;
      return;
    }
    const safeHeaders = {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'content-length': wire.length,
    };
    delete safeHeaders['transfer-encoding'];
    delete safeHeaders['content-encoding'];
    publishing = true;
    try {
      clientRes.writeHead(statusCode, safeHeaders);
      clientRes.end(wire);
    } catch {
      settled = true;
      clientRes.destroy();
      proxyRes.destroy();
      report(onFailure, 'compaction_publication_failed');
      return;
    }
  });
  proxyRes.once('error', () => {
    if (!publishing) fail('upstream_compaction_aborted');
  });
  proxyRes.once('aborted', () => {
    if (!publishing) fail('upstream_compaction_aborted');
  });
  proxyRes.once('close', () => {
    if (!publishing) fail('upstream_compaction_aborted');
  });
  const type = proxyRes.headers['content-type'];
  if (
    (proxyRes.headers['content-encoding'] && proxyRes.headers['content-encoding'] !== 'identity') ||
    (typeof type === 'string' && !/^application\/json(?:\s*;|$)/i.test(type))
  )
    fail('upstream_invalid_compaction');
}

module.exports = { guardNativeCompactionResponse };
