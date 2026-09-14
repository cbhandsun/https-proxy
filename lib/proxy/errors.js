const UPSTREAM_RATE_LIMIT_COOLDOWNS = new Map();
const MAX_UPSTREAM_RETRY_AFTER_SECONDS = 120;

function clampRetryAfterSeconds(value, maxSeconds = MAX_UPSTREAM_RETRY_AFTER_SECONDS) {
  const parsed = Math.ceil(Number(value));
  const max = Number.isFinite(Number(maxSeconds))
    ? Math.max(1, Math.trunc(Number(maxSeconds)))
    : MAX_UPSTREAM_RETRY_AFTER_SECONDS;
  return Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), max) : max;
}

function parseRetryDelaySeconds(value) {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*s/);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) return null;
  return clampRetryAfterSeconds(seconds);
}

function parseRetryAfterHeaderSeconds(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = Array.isArray(value) ? String(value[0] || '').trim() : String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return clampRetryAfterSeconds(Number(text));

  const parsedDate = Date.parse(text);
  const nowMs = Number(now);
  if (Number.isFinite(parsedDate) && Number.isFinite(nowMs)) {
    return clampRetryAfterSeconds((parsedDate - nowMs) / 1000);
  }

  return parseRetryDelaySeconds(text);
}

function parseGeminiError(statusCode, body) {
  let message = body;
  let type = statusCode === 429 ? 'rate_limit_error' : 'api_error';
  let status = null;
  let retryAfterSeconds = null;
  let quotaMetric = null;
  let quotaId = null;

  try {
    const parsed = JSON.parse(body);
    const error = parsed && parsed.error;
    if (error) {
      message = error.message || body;
      status = error.status || null;
      if (status === 'RESOURCE_EXHAUSTED') type = 'rate_limit_error';
      const details = Array.isArray(error.details) ? error.details : [];
      for (const detail of details) {
        if (detail && detail.retryDelay)
          retryAfterSeconds = parseRetryDelaySeconds(detail.retryDelay);
        const violations = detail && detail.violations;
        if (Array.isArray(violations) && violations[0]) {
          quotaMetric = violations[0].quotaMetric || quotaMetric;
          quotaId = violations[0].quotaId || quotaId;
        }
      }
    }
  } catch (err) {}

  if (retryAfterSeconds === null) retryAfterSeconds = parseRetryDelaySeconds(message);
  return { type, message, status, retryAfterSeconds, quotaMetric, quotaId };
}

function upstreamRequestId(headers) {
  return (
    (headers &&
      (headers['x-request-id'] ||
        headers['request-id'] ||
        headers['anthropic-request-id'] ||
        headers['x-requestid'])) ||
    undefined
  );
}

function normalizeUpstreamError(statusCode, headers, body, upstream) {
  let type = statusCode === 429 ? 'rate_limit_error' : 'api_error';
  let message = String(body || 'Upstream request failed');
  let code;
  try {
    const parsed = JSON.parse(body);
    const error = parsed && parsed.error ? parsed.error : parsed;
    if (error && typeof error === 'object') {
      type = error.type || error.code || type;
      message = error.message || error.error || message;
      code = error.code || error.status || undefined;
    }
  } catch (err) {}
  return {
    error: {
      type,
      message,
      code,
      status: statusCode,
      upstream,
      request_id: upstreamRequestId(headers),
      retry_after: headers && headers['retry-after'] ? String(headers['retry-after']) : undefined,
    },
  };
}

function sendJsonError(clientRes, statusCode, error, extraHeaders) {
  const body = JSON.stringify(error);
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    ...(extraHeaders || {}),
  });
  clientRes.end(body);
}

function sendUpstreamError(clientRes, statusCode, headers, body, upstream) {
  const normalized = normalizeUpstreamError(statusCode, headers, body, upstream);
  const extraHeaders = {};
  if (normalized.error.retry_after) extraHeaders['Retry-After'] = normalized.error.retry_after;
  sendJsonError(clientRes, statusCode, normalized, extraHeaders);
  return normalized;
}

function geminiErrorToClaude(statusCode, body) {
  const error = parseGeminiError(statusCode, body);
  return JSON.stringify({ error: { type: error.type, message: error.message } });
}

function upstreamCooldownKey(profileId, targetModel, defaultModel = 'upstream') {
  return String(profileId || 'default') + ':' + String(targetModel || defaultModel);
}

function getCooldownByKey(key, now = Date.now()) {
  const until = UPSTREAM_RATE_LIMIT_COOLDOWNS.get(key) || 0;
  if (until <= now) {
    UPSTREAM_RATE_LIMIT_COOLDOWNS.delete(key);
    return null;
  }
  return { key, retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)) };
}

function setCooldownByKey(key, retryAfterSeconds, now = Date.now()) {
  if (!retryAfterSeconds) return null;
  const seconds = clampRetryAfterSeconds(retryAfterSeconds);
  UPSTREAM_RATE_LIMIT_COOLDOWNS.set(key, now + seconds * 1000);
  return { key, retryAfterSeconds: seconds };
}

function getUpstreamCooldown(profileId, targetModel) {
  return getCooldownByKey(upstreamCooldownKey(profileId, targetModel));
}

function setUpstreamCooldown(profileId, targetModel, retryAfterSeconds) {
  return setCooldownByKey(upstreamCooldownKey(profileId, targetModel), retryAfterSeconds);
}

function geminiCooldownKey(profileId, targetModel) {
  return upstreamCooldownKey(profileId, targetModel, 'gemini');
}

function getGeminiCooldown(profileId, targetModel) {
  return getCooldownByKey(geminiCooldownKey(profileId, targetModel));
}

function setGeminiCooldown(profileId, targetModel, retryAfterSeconds) {
  return setCooldownByKey(geminiCooldownKey(profileId, targetModel), retryAfterSeconds);
}

module.exports = {
  clampRetryAfterSeconds,
  parseRetryDelaySeconds,
  parseRetryAfterHeaderSeconds,
  parseGeminiError,
  upstreamRequestId,
  normalizeUpstreamError,
  sendJsonError,
  sendUpstreamError,
  geminiErrorToClaude,
  upstreamCooldownKey,
  getUpstreamCooldown,
  setUpstreamCooldown,
  geminiCooldownKey,
  getGeminiCooldown,
  setGeminiCooldown,
};
