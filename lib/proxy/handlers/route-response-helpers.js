'use strict';

const {
  applyGeminiCooldown,
  geminiRetryHeaders,
  geminiUpstreamErrorEvent,
  logGeminiDirectError,
} = require('./route-gemini-utils');
const { sendConversionError } = require('./route-error-utils');
const {
  parseRetryAfterHeaderSeconds: defaultParseRetryAfterHeaderSeconds,
  setUpstreamCooldown: defaultSetUpstreamCooldown,
} = require('../errors');

const MAX_CONVERTED_COOLDOWN_SECONDS = 45;

function createRouteResponseHelpers(deps) {
  const {
    log,
    logProxyEvent,
    logRequestEnd,
    parseGeminiError,
    parseRetryAfterHeaderSeconds = defaultParseRetryAfterHeaderSeconds,
    sendJsonError,
    sendUpstreamError,
    setGeminiCooldown,
    setUpstreamCooldown = defaultSetUpstreamCooldown,
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
      rateLimitCooldown,
    } = options;
    const statusCode = proxyRes.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      const cooldownMeta = applyConvertedRateLimitCooldown({
        statusCode,
        headers: proxyRes.headers,
        rateLimitCooldown,
      });
      const upstreamHeaders = cooldownMeta
        ? { ...(proxyRes.headers || {}), 'retry-after': String(cooldownMeta.retryAfterSeconds) }
        : proxyRes.headers;
      sendUpstreamError(clientRes, statusCode, upstreamHeaders, responseBody, upstreamProvider);
      if (cooldownMeta) {
        logProxyEvent('upstream_rate_limit', {
          method: clientReq.method,
          path: upstreamPath,
          code: statusCode,
          type: upstreamProvider,
          profileId: cooldownMeta.profileId,
          targetModel: cooldownMeta.targetModel,
          retryAfterSeconds: cooldownMeta.retryAfterSeconds,
          source: cooldownMeta.source,
        });
      }
      logRequestEnd(clientReq.method, upstreamPath, startTime, statusCode, {
        type: upstreamErrorType,
        ...(cooldownMeta
          ? {
              retryAfterSeconds: cooldownMeta.retryAfterSeconds,
              cooldownSource: cooldownMeta.source,
            }
          : {}),
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

  function applyConvertedRateLimitCooldown({ statusCode, headers, rateLimitCooldown }) {
    if (statusCode !== 429 || !rateLimitCooldown || typeof setUpstreamCooldown !== 'function') {
      return null;
    }
    const profileId = rateLimitCooldown.profileId;
    const targetModel = rateLimitCooldown.targetModel;
    const parsedRetryAfter =
      typeof parseRetryAfterHeaderSeconds === 'function'
        ? parseRetryAfterHeaderSeconds(headers && headers['retry-after'])
        : null;
    const retryAfterSeconds =
      parsedRetryAfter || rateLimitCooldown.fallbackSeconds || MAX_CONVERTED_COOLDOWN_SECONDS;
    const cooldown = setUpstreamCooldown(profileId, targetModel, retryAfterSeconds);
    if (!cooldown) return null;
    return {
      profileId,
      targetModel,
      retryAfterSeconds: cooldown.retryAfterSeconds,
      source: parsedRetryAfter ? 'upstream_retry_after' : 'local_fallback',
    };
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
