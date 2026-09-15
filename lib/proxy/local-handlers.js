const { createLogger } = require('./logger');
const { pathForLogging } = require('./request-utils');

const safeLog = createLogger('local-handlers');

function logFilteredToolBody(kind, original, filtered) {
  if (original === filtered) return;
  safeLog.warn('!! filtered invalid tool_use in ' + kind + ' response');
}

function sendRateLimit(
  clientReq,
  clientRes,
  upstreamPath,
  startTime,
  targetModel,
  retryAfterSeconds,
  message,
  meta,
  logRequestEnd,
  options = {}
) {
  const parsed = Math.ceil(Number(retryAfterSeconds || 1));
  const maxRetryAfterSeconds =
    options && Object.prototype.hasOwnProperty.call(options, 'maxRetryAfterSeconds')
      ? options.maxRetryAfterSeconds
      : 120;
  const maxRetryAfter = Number.isFinite(Number(maxRetryAfterSeconds))
    ? Math.max(1, Math.trunc(Number(maxRetryAfterSeconds)))
    : 120;
  const retryAfter = Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), maxRetryAfter) : 120;
  const logType = options.type || 'upstream_rate_limit';
  clientRes.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(retryAfter),
    'access-control-allow-origin': '*',
  });
  clientRes.end(JSON.stringify({ error: { type: 'rate_limit_error', message } }));
  logRequestEnd(clientReq.method, upstreamPath, startTime, 429, {
    type: logType,
    targetModel,
    retryAfterSeconds: retryAfter,
    ...(meta || {}),
  });
}

function sendGeminiRateLimit(
  clientReq,
  clientRes,
  upstreamPath,
  startTime,
  targetModel,
  retryAfterSeconds,
  message,
  meta,
  logRequestEnd
) {
  return sendRateLimit(
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    targetModel,
    retryAfterSeconds,
    message,
    meta,
    logRequestEnd,
    { type: 'gemini_rate_limit' }
  );
}

function handleCountTokens(
  clientReq,
  clientRes,
  requestBuffer,
  estimateTokens,
  logRequestEnd,
  startTime
) {
  let inputTokens;
  try {
    const parsed = JSON.parse(requestBuffer.toString('utf8'));
    if (clientRes.__auditData && !clientRes.__auditData.originalModel && parsed && parsed.model) {
      clientRes.__auditData.originalModel = String(parsed.model);
      if (!clientRes.__auditData.protocol) clientRes.__auditData.protocol = 'claude';
    }
    inputTokens = Math.max(
      1,
      estimateTokens(parsed.messages) + estimateTokens(parsed.system) + estimateTokens(parsed.tools)
    );
  } catch (err) {
    inputTokens = 1;
  }

  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(JSON.stringify({ input_tokens: inputTokens }));
  safeLog.info(
    'ok ' +
      clientReq.method +
      ' ' +
      pathForLogging(clientReq.url) +
      '  -> 200 (local count_tokens, ' +
      inputTokens +
      ' tokens)'
  );
  if (typeof logRequestEnd === 'function') {
    logRequestEnd(clientReq.method, clientReq.url, startTime || Date.now(), 200, {
      type: 'local_count_tokens',
      inputTokens,
    });
  }
}

module.exports = {
  logFilteredToolBody,
  sendRateLimit,
  sendGeminiRateLimit,
  handleCountTokens,
};
