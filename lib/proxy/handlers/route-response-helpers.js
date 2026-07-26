'use strict';

const {
  applyGeminiCooldown,
  geminiRetryHeaders,
  geminiUpstreamErrorEvent,
  logGeminiDirectError,
} = require('./route-gemini-utils');
const { sendConversionError } = require('./route-error-utils');

function createRouteResponseHelpers(deps) {
  const {
    log,
    logProxyEvent,
    logRequestEnd,
    parseGeminiError,
    sendJsonError,
    sendUpstreamError,
    setGeminiCooldown,
    writeJsonResponse,
  } = deps;

  function proxyErrorContext(clientReq, upstreamPath, startTime, type, logType, extra) {
    return {
      method: clientReq.method,
      path: clientReq.url,
      upstreamPath,
      startTime,
      type,
      logType,
      logProxyEvent,
      logRequestEnd,
      extra,
    };
  }

  function boundedResponseContext(clientReq, startTime, type) {
    return {
      method: clientReq.method,
      startTime,
      tooLargeLogType: `${type}_response_too_large`,
      errorLogType: `${type}_response_error`,
    };
  }

  function handleConvertedJsonResponse(options) {
    const {
      proxyRes,
      clientReq,
      clientRes,
      upstreamPath,
      startTime,
      responseBody,
      upstreamProvider,
      upstreamErrorType,
      successType,
      successMeta,
      conversionLabel,
      conversionLogType,
      convert,
    } = options;
    const statusCode = proxyRes.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      sendUpstreamError(clientRes, statusCode, proxyRes.headers, responseBody, upstreamProvider);
      logRequestEnd(clientReq.method, upstreamPath, startTime, statusCode, {
        type: upstreamErrorType,
      });
      return;
    }
    try {
      const response = convert(responseBody);
      writeJsonResponse(clientRes, 200, response);
      const extraSuccessMeta =
        typeof successMeta === 'function' ? successMeta(response) : successMeta;
      logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
        type: successType,
        ...(extraSuccessMeta || {}),
      });
    } catch (err) {
      sendConversionError({
        clientReq,
        clientRes,
        upstreamPath,
        startTime,
        err,
        label: conversionLabel,
        logType: conversionLogType,
        sendJsonError,
        logRequestEnd,
      });
    }
  }

  function handleGeminiUpstreamError(options) {
    const {
      proxyRes,
      clientReq,
      clientRes,
      prepared,
      upstreamPath,
      startTime,
      responseBody,
      targetModel,
      requestEndType,
      logDirectError = false,
      eventExtra,
    } = options;
    const statusCode = proxyRes.statusCode;
    const geminiError = parseGeminiError(statusCode, responseBody);
    const retryAfter = geminiError.retryAfterSeconds;
    sendUpstreamError(
      clientRes,
      statusCode,
      geminiRetryHeaders(proxyRes.headers, statusCode, retryAfter),
      responseBody,
      'gemini'
    );
    const cooldownSeconds = applyGeminiCooldown({
      statusCode,
      retryAfterSeconds: retryAfter,
      profileId: prepared.profile && prepared.profile.id,
      targetModel,
      setGeminiCooldown,
    });
    if (logDirectError) {
      logGeminiDirectError({
        clientReq,
        upstreamPath,
        statusCode,
        targetModel,
        geminiError,
        cooldownSeconds,
        log,
      });
    }
    const extraEventFields =
      typeof eventExtra === 'function' ? eventExtra(geminiError) : eventExtra;
    logProxyEvent(
      'upstream_error',
      geminiUpstreamErrorEvent(clientReq, upstreamPath, statusCode, geminiError, extraEventFields)
    );
    logRequestEnd(clientReq.method, upstreamPath, startTime, statusCode, {
      type: requestEndType,
      errorType: geminiError.type,
      retryAfterSeconds: retryAfter,
    });
  }

  return {
    boundedResponseContext,
    handleConvertedJsonResponse,
    handleGeminiUpstreamError,
    proxyErrorContext,
  };
}

module.exports = { createRouteResponseHelpers };
