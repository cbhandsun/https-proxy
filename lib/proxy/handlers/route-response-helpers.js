'use strict';

const {
  applyGeminiCooldown,
  geminiRetryHeaders,
  geminiUpstreamErrorEvent,
  logGeminiDirectError,
} = require('./route-gemini-utils');
const { sendConversionError } = require('./route-error-utils');
const { upstreamErrorDetail } = require('./upstream-error-detail');
const {
  parseRetryAfterHeaderSeconds: defaultParseRetryAfterHeaderSeconds,
  setUpstreamCooldown: defaultSetUpstreamCooldown,
} = require('../errors');

const MAX_CONVERTED_COOLDOWN_SECONDS = 45;
const MAX_CONVERTED_RESET_COOLDOWN_SECONDS = 24 * 60 * 60;

function parseJsonObject(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

function parseUtcOffsetMinutes(text) {
  const match = String(text || '').match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 14 || minutes > 59) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (hours * 60 + minutes);
}

function parseResetTimeWithUtcOffset(message) {
  if (typeof message !== 'string' || !message) return null;
  const match = message.match(
    /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*UTC([+-]\d{1,2}(?::?\d{2})?)/i
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  const offsetMinutes = parseUtcOffsetMinutes(match[7]);
  if (offsetMinutes === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60 * 1000;
  const verify = new Date(utcMs + offsetMinutes * 60 * 1000);
  if (
    verify.getUTCFullYear() !== year ||
    verify.getUTCMonth() !== month - 1 ||
    verify.getUTCDate() !== day ||
    verify.getUTCHours() !== hour ||
    verify.getUTCMinutes() !== minute ||
    verify.getUTCSeconds() !== second
  ) {
    return null;
  }
  return utcMs;
}

function parseWorkBuddyResetCooldownSeconds(responseBody, nowMs = Date.now()) {
  const parsed = parseJsonObject(responseBody);
  if (!parsed || parsed.code !== 6004 || typeof parsed.msg !== 'string') return null;
  const resetMs = parseResetTimeWithUtcOffset(parsed.msg);
  const now = Number(nowMs);
  if (!Number.isFinite(resetMs) || !Number.isFinite(now)) return null;
  const seconds = Math.ceil((resetMs - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, MAX_CONVERTED_RESET_COOLDOWN_SECONDS);
}

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
        responseBody,
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
        // Previously only the status code was recorded, so a recurring upstream 400
        // could not be diagnosed without guessing at the time window. Keep a bounded,
        // redacted copy of the body plus its parsed message/status/code.
        ...upstreamErrorDetail(responseBody),
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

  function applyConvertedRateLimitCooldown({
    statusCode,
    headers,
    responseBody,
    rateLimitCooldown,
  }) {
    if (statusCode !== 429 || !rateLimitCooldown || typeof setUpstreamCooldown !== 'function') {
      return null;
    }
    const profileId = rateLimitCooldown.profileId;
    const targetModel = rateLimitCooldown.targetModel;
    const parsedRetryAfter =
      typeof parseRetryAfterHeaderSeconds === 'function'
        ? parseRetryAfterHeaderSeconds(headers && headers['retry-after'])
        : null;
    const resetCooldownSeconds = parseWorkBuddyResetCooldownSeconds(responseBody);
    const retryAfterSeconds =
      resetCooldownSeconds ||
      parsedRetryAfter ||
      rateLimitCooldown.fallbackSeconds ||
      MAX_CONVERTED_COOLDOWN_SECONDS;
    const cooldownSource = resetCooldownSeconds
      ? 'upstream_reset_time'
      : parsedRetryAfter
        ? 'upstream_retry_after'
        : 'local_fallback';
    const cooldownOptions = resetCooldownSeconds
      ? { maxSeconds: MAX_CONVERTED_RESET_COOLDOWN_SECONDS, source: cooldownSource }
      : { source: cooldownSource };
    const cooldown = setUpstreamCooldown(
      profileId,
      targetModel,
      retryAfterSeconds,
      cooldownOptions
    );
    if (!cooldown) return null;
    return {
      profileId,
      targetModel,
      retryAfterSeconds: cooldown.retryAfterSeconds,
      source: cooldownSource,
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
      geminiUpstreamErrorEvent(clientReq, upstreamPath, statusCode, geminiError, {
        ...upstreamErrorDetail(responseBody),
        ...(extraEventFields || {}),
      })
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

module.exports = {
  createRouteResponseHelpers,
  parseWorkBuddyResetCooldownSeconds,
  _test: {
    parseResetTimeWithUtcOffset,
    parseWorkBuddyResetCooldownSeconds,
  },
};
