'use strict';

const { terminateClientAfterUpstreamFailure } = require('./failure-terminal');

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
  const message = label + ' conversion failed: ' + (err && err.message ? err.message : err);
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
    error: err && err.message ? err.message : String(err),
  });
}

module.exports = {
  sendConversionError,
};
