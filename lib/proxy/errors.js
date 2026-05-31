const GEMINI_RATE_LIMIT_COOLDOWNS = new Map();

function parseRetryDelaySeconds(value) {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*s/);
  if (!match) return null;
  return Math.max(1, Math.ceil(Number(match[1])));
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
        if (detail && detail.retryDelay) retryAfterSeconds = parseRetryDelaySeconds(detail.retryDelay);
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
  return headers && (headers['x-request-id'] || headers['request-id'] || headers['anthropic-request-id'] || headers['x-requestid']) || undefined;
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

function geminiCooldownKey(profileId, targetModel) {
  return String(profileId || 'default') + ':' + String(targetModel || 'gemini');
}

function getGeminiCooldown(profileId, targetModel) {
  const key = geminiCooldownKey(profileId, targetModel);
  const until = GEMINI_RATE_LIMIT_COOLDOWNS.get(key) || 0;
  if (until <= Date.now()) {
    GEMINI_RATE_LIMIT_COOLDOWNS.delete(key);
    return null;
  }
  return { key, retryAfterSeconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)) };
}

function setGeminiCooldown(profileId, targetModel, retryAfterSeconds) {
  if (!retryAfterSeconds) return null;
  const key = geminiCooldownKey(profileId, targetModel);
  const seconds = Math.min(Math.max(1, retryAfterSeconds), 120);
  GEMINI_RATE_LIMIT_COOLDOWNS.set(key, Date.now() + seconds * 1000);
  return { key, retryAfterSeconds: seconds };
}

module.exports = {
  parseRetryDelaySeconds,
  parseGeminiError,
  upstreamRequestId,
  normalizeUpstreamError,
  sendJsonError,
  sendUpstreamError,
  geminiErrorToClaude,
  geminiCooldownKey,
  getGeminiCooldown,
  setGeminiCooldown,
};
