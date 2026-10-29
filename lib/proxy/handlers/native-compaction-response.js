'use strict';

const { TextDecoder } = require('node:util');

const {
  assertNativeCompactionResponse,
  MAX_NATIVE_COMPACTION_BYTES,
} = require('../native-responses-compaction');
const { createLogger } = require('../logger');
const diagnosticLogger = createLogger('native-compaction-response');
const { nativeReaderPromise } = require('../context-recovery-reader-result');

async function confirmPublication(handler, value) {
  const pending = handler(value);
  if (!nativeReaderPromise(pending)) throw new Error('Compaction publication rejected');
  if ((await pending) !== true) throw new Error('Compaction publication rejected');
}

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
  beforePublish = () => true,
  beforePublishAsync,
  afterFinishAsync,
  publicationAllowed = () => true,
  diagnosticLog = diagnosticLogger,
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Invalid native compaction response limit');
  if (
    [beforePublishAsync, afterFinishAsync].some(
      (callback) => callback !== undefined && typeof callback !== 'function'
    ) ||
    typeof publicationAllowed !== 'function'
  )
    throw new TypeError('Invalid native compaction publication callback');
  const limit = Math.min(maxBytes, MAX_NATIVE_COMPACTION_BYTES);
  const chunks = [];
  let bytes = 0;
  let settled = false;
  let publishing = false;
  let upstreamEnded = false;
  let transportFinished = false;
  function report(handler, code) {
    function reportFailure() {
      diagnosticLog.error(
        { code: 'native_compaction_terminal_log_failed' },
        'Native compaction terminal logging failed'
      );
    }
    try {
      const result = handler(code);
      if (nativeReaderPromise(result)) Promise.prototype.then.call(result, () => {}, reportFailure);
    } catch {
      reportFailure();
    }
  }
  function fail(code) {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    let reportedCode = code;
    try {
      if (clientRes.headersSent) {
        clientRes.destroy();
      } else if (!clientRes.destroyed && !clientRes.writableEnded) {
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
    if (settled || !publishing || transportFinished) return;
    transportFinished = true;
    if (afterFinishAsync) {
      void (async () => {
        try {
          await confirmPublication(afterFinishAsync);
          if (settled) return;
          if (publicationAllowed() !== true) throw new Error('Compaction publication rejected');
          settled = true;
          report(onComplete);
        } catch {
          fail('context_recovery_compaction_unavailable');
        }
      })();
    } else {
      settled = true;
      report(onComplete);
    }
  });
  clientRes.once('close', () => {
    if (settled || transportFinished) return;
    settled = true;
    chunks.length = 0;
    proxyRes.destroy();
    report(onFailure, 'compaction_publication_failed');
  });
  clientRes.once('error', () => fail('compaction_publication_failed'));
  proxyRes.on('data', (chunk) => {
    if (settled || upstreamEnded) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) return fail('upstream_compaction_too_large');
    chunks.push(buffer);
  });
  proxyRes.once('end', () => {
    if (settled || upstreamEnded) return;
    upstreamEnded = true;
    const wire = Buffer.concat(chunks);
    chunks.length = 0;
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wire));
      assertNativeCompactionResponse(body, limit);
    } catch {
      fail('upstream_invalid_compaction');
      return;
    }
    if (clientRes.destroyed || clientRes.writableEnded) {
      settled = true;
      return;
    }
    function publish() {
      if (settled) return;
      try {
        if (publicationAllowed() !== true) throw new Error('Compaction publication rejected');
      } catch {
        fail('context_recovery_compaction_unavailable');
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
    }
    if (beforePublishAsync) {
      void (async () => {
        try {
          await confirmPublication(beforePublishAsync, body);
          publish();
        } catch {
          fail('context_recovery_compaction_unavailable');
        }
      })();
    } else {
      try {
        if (beforePublish(body) !== true) throw new Error('Compaction publication rejected');
        publish();
      } catch {
        fail('context_recovery_compaction_unavailable');
      }
    }
  });
  proxyRes.once('error', () => {
    if (!upstreamEnded) fail('upstream_compaction_aborted');
  });
  proxyRes.once('aborted', () => {
    if (!upstreamEnded) fail('upstream_compaction_aborted');
  });
  proxyRes.once('close', () => {
    if (!upstreamEnded) fail('upstream_compaction_aborted');
  });
  const type = proxyRes.headers['content-type'];
  if (
    (proxyRes.headers['content-encoding'] && proxyRes.headers['content-encoding'] !== 'identity') ||
    (typeof type === 'string' && !/^application\/json(?:\s*;|$)/i.test(type))
  )
    fail('upstream_invalid_compaction');
}

module.exports = { guardNativeCompactionResponse };
