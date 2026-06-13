'use strict';

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
  sendJsonError(clientRes, 502, {
    error: {
      type: 'api_error',
      message,
    },
  });
  logRequestEnd(clientReq.method, upstreamPath, startTime, 502, {
    type: logType,
    errorType: 'conversion_failed',
    error: err && err.message ? err.message : String(err),
  });
}

module.exports = {
  sendConversionError,
};
