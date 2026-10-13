'use strict';

const { terminateClientAfterUpstreamFailure } = require('./failure-terminal');
const { safeErrorCode } = require('./upstream-stream-guard');

function sendConversionError({
  clientReq,
  clientRes,
  upstreamPath,
  startTime,
  err,
  label,
  logType,
  sendJsonError,
  logRequestEnd,
}) {
  // Local history validation failures have no socket error code. Preserve only
  // this fixed diagnostic; never serialize exception messages or caller codes.
  const localCode =
    err && typeof err === 'object' ? Object.getOwnPropertyDescriptor(err, 'code')?.value : null;
  const errorCode = localCode === 'invalid_context_history' ? localCode : safeErrorCode(err);
  const message = label + ' conversion failed' + (errorCode ? ' (' + errorCode + ')' : '');
  if (clientRes && clientRes.headersSent !== true) {
    sendJsonError(clientRes, 502, {
      error: {
        type: 'api_error',
        message,
      },
    });
  } else {
    // A converted stream can fail after the response started; the client still needs
    // a terminal signal, otherwise it waits forever on an open connection.
    terminateClientAfterUpstreamFailure(clientRes, {
      stream: true,
      payload: { error: { type: 'api_error', message } },
    });
  }
  logRequestEnd(clientReq.method, upstreamPath, startTime, 502, {
    type: logType,
    errorType: 'conversion_failed',
    errorCode,
  });
}

module.exports = {
  sendConversionError,
};
