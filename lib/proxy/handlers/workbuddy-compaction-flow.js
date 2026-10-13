'use strict';

const {
  produceWorkBuddyCompaction,
  compactionResponseEvents,
} = require('../workbuddy-compaction-bridge');
const { createWbipcCancellation } = require('./workbuddy-responses-flow');
const { terminateClientAfterUpstreamFailure } = require('./failure-terminal');
const { createLogger } = require('../logger');
const diagnosticLog = createLogger('workbuddy-compaction-flow');

const CLIENT_ERRORS = new Set(['empty_compaction_input', 'invalid_local_compaction']);
const SAFE_ERRORS = new Set([
  ...CLIENT_ERRORS,
  'compaction_source_too_large',
  'compaction_upstream_failure',
  'incomplete_compaction_summary',
  'invalid_compaction_summary',
  'compaction_cancelled',
  'compaction_summary_unavailable',
  'compaction_usage_unavailable',
  'local_compaction_quota',
  'local_compaction_closed',
  'local_compaction_clock_invalid',
  'invalid_context_call_lineage',
  'invalid_compaction_evidence',
  'compaction_evidence_unavailable',
]);

function handleWorkBuddyCompactionTrigger(options) {
  const {
    clientReq,
    clientRes,
    sendJsonError,
    writeJsonResponse,
    logRequestEnd,
    upstreamPath,
    startTime,
    binding,
    store,
    CORS_HEADERS,
    maxResponseBytes,
  } = options;
  const finish = (status, errorCode) => {
    try {
      logRequestEnd(clientReq.method, upstreamPath, startTime, status, {
        type: 'workbuddy_local_compaction',
        ...(errorCode ? { errorCode } : {}),
      });
    } catch (_error) {
      // Logging is outside the state-publication transaction. Report the failure
      // independently without raw error text or undoing an already sent token.
      (options.diagnosticLog || diagnosticLog).error(
        { code: 'compaction_terminal_log_failed', status },
        'Local compaction terminal logging failed'
      );
    }
  };
  const cancellation = createWbipcCancellation({
    clientReq,
    clientRes,
    onCancel: (code) => finish(code === 'client_disconnected' ? 499 : 502, code),
  });
  let token;
  let discardEvidence;
  return Promise.resolve()
    .then(async () => {
      if (cancellation.isCanceled()) return;
      const produced = await produceWorkBuddyCompaction({
        ...options,
        signal: cancellation.signal,
      });
      token = produced.token;
      discardEvidence = produced.discardEvidence;
      if (cancellation.isCanceled()) {
        store.discard(token, binding);
        discardEvidence?.();
        return;
      }
      const wire =
        options.body.stream === true
          ? compactionResponseEvents(produced.response)
          : JSON.stringify(produced.response);
      if (
        !Number.isSafeInteger(maxResponseBytes) ||
        maxResponseBytes < 1 ||
        Buffer.byteLength(wire) > maxResponseBytes
      ) {
        const error = new TypeError('Compaction response exceeds configured limit');
        error.code = 'compaction_summary_unavailable';
        throw error;
      }
      // One bounded end() hands buffering/backpressure to the HTTP transport;
      // no unbounded incremental ciphertext writes or optimistic completion.
      if (options.body.stream === true) {
        clientRes.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        clientRes.end(wire);
      } else writeJsonResponse(clientRes, 200, produced.response);
      if (cancellation.isCanceled()) {
        store.discard(token, binding);
        discardEvidence?.();
        return;
      }
      cancellation.complete();
      finish(200);
    })
    .catch((error) => {
      if (token) store.discard(token, binding);
      discardEvidence?.();
      if (cancellation.isCanceled()) return;
      cancellation.complete();
      const code = SAFE_ERRORS.has(error?.code) ? error.code : 'compaction_processing_failed';
      const status =
        code === 'compaction_source_too_large' ? 413 : CLIENT_ERRORS.has(code) ? 400 : 502;
      const payload = {
        error: {
          type: status < 500 ? 'invalid_request_error' : 'api_error',
          code,
          message:
            'Local compaction did not complete; retain the original context and retry or reduce the input.',
        },
      };
      if (clientRes.headersSent)
        terminateClientAfterUpstreamFailure(clientRes, { stream: true, payload });
      else sendJsonError(clientRes, status, payload);
      finish(status, code);
    })
    .finally(() => cancellation.complete());
}

module.exports = { handleWorkBuddyCompactionTrigger };
