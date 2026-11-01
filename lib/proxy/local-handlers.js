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

function createGeminiRateLimitSender(logRequestEnd) {
  if (typeof logRequestEnd !== 'function') throw new TypeError('logRequestEnd is required');
  return function (
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    targetModel,
    retryAfterSeconds,
    message,
    meta
  ) {
    return sendGeminiRateLimit(
      clientReq,
      clientRes,
      upstreamPath,
      startTime,
      targetModel,
      retryAfterSeconds,
      message,
      meta,
      logRequestEnd
    );
  };
}

function handleCountTokens(
  clientReq,
  clientRes,
  requestBuffer,
  estimateTokens,
  logRequestEnd,
  startTime,
  watermarkContext
) {
  let inputTokens;
  let parsedModel = '';
  try {
    const parsed = JSON.parse(requestBuffer.toString('utf8'));
    if (parsed && parsed.model) parsedModel = String(parsed.model);
    if (clientRes.__auditData && !clientRes.__auditData.originalModel && parsedModel) {
      clientRes.__auditData.originalModel = parsedModel;
      if (!clientRes.__auditData.protocol) clientRes.__auditData.protocol = 'claude';
    }
    inputTokens = Math.max(
      1,
      estimateTokens(parsed.messages) + estimateTokens(parsed.system) + estimateTokens(parsed.tools)
    );
  } catch (err) {
    inputTokens = 1;
  }

  const { scaleTokensForCompactionWatermark } = require('./context-watermark-scaler');
  const scaled = watermarkContext
    ? scaleTokensForCompactionWatermark(inputTokens, {
        clientModel: parsedModel,
        ...watermarkContext,
      })
    : { inputTokens, rawInputTokens: inputTokens, scaled: false };
  const reportedTokens = scaled.inputTokens;

  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(JSON.stringify({ input_tokens: reportedTokens }));
  safeLog.info(
    'ok ' +
      clientReq.method +
      ' ' +
      pathForLogging(clientReq.url) +
      '  -> 200 (local count_tokens, ' +
      reportedTokens +
      ' tokens)'
  );
  if (typeof logRequestEnd === 'function') {
    logRequestEnd(clientReq.method, clientReq.url, startTime || Date.now(), 200, {
      type: 'local_count_tokens',
      inputTokens: reportedTokens,
      ...(scaled.scaled
        ? {
            rawInputTokens: scaled.rawInputTokens,
            watermarkScaled: true,
            scaleFactor: scaled.scaleFactor,
          }
        : {}),
    });
  }
}

function handleResponsesInputTokens(
  clientReq,
  clientRes,
  requestBuffer,
  estimateTokens,
  logRequestEnd,
  startTime,
  watermarkContext
) {
  let inputTokens;
  let parsedModel = '';
  try {
    const parsed = JSON.parse(requestBuffer.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError();
    if (parsed.model != null && (typeof parsed.model !== 'string' || !parsed.model.trim()))
      throw new TypeError();
    if (typeof parsed.model === 'string') parsedModel = parsed.model.trim();
    if (parsed.input != null && typeof parsed.input !== 'string' && !Array.isArray(parsed.input))
      throw new TypeError();
    if (parsed.instructions != null && typeof parsed.instructions !== 'string')
      throw new TypeError();
    if (parsed.tools != null && !Array.isArray(parsed.tools)) throw new TypeError();
    inputTokens = Math.max(
      1,
      estimateTokens(parsed.input) +
        estimateTokens(parsed.instructions) +
        estimateTokens(parsed.tools)
    );
  } catch {
    clientRes.writeHead(400, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'access-control-allow-origin': '*',
    });
    clientRes.end(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: 'Input token count request is invalid',
        },
      })
    );
    if (typeof logRequestEnd === 'function') {
      logRequestEnd(clientReq.method, clientReq.url, startTime || Date.now(), 400, {
        type: 'local_responses_input_tokens_invalid',
      });
    }
    return;
  }
  const { scaleTokensForCompactionWatermark } = require('./context-watermark-scaler');
  const scaled = watermarkContext
    ? scaleTokensForCompactionWatermark(inputTokens, {
        clientModel: parsedModel,
        ...watermarkContext,
      })
    : { inputTokens, rawInputTokens: inputTokens, scaled: false };
  const reportedTokens = scaled.inputTokens;

  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'access-control-allow-origin': '*',
  });
  clientRes.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: reportedTokens }));
  if (typeof logRequestEnd === 'function') {
    logRequestEnd(clientReq.method, clientReq.url, startTime || Date.now(), 200, {
      type: 'local_responses_input_tokens',
      inputTokens: reportedTokens,
      exact: false,
      ...(scaled.scaled
        ? {
            rawInputTokens: scaled.rawInputTokens,
            watermarkScaled: true,
            scaleFactor: scaled.scaleFactor,
          }
        : {}),
    });
  }
}

function createLocalTokenHandlers(options = {}) {
  const estimator = options.estimateTokens;
  if (typeof estimator !== 'function') {
    throw new TypeError('createLocalTokenHandlers requires estimateTokens');
  }
  return {
    handleCountTokens(
      clientReq,
      clientRes,
      requestBuffer,
      logRequestEnd,
      startTime,
      watermarkContext
    ) {
      return handleCountTokens(
        clientReq,
        clientRes,
        requestBuffer,
        estimator,
        logRequestEnd,
        startTime,
        watermarkContext
      );
    },
    handleResponsesInputTokens(
      clientReq,
      clientRes,
      requestBuffer,
      logRequestEnd,
      startTime,
      watermarkContext
    ) {
      return handleResponsesInputTokens(
        clientReq,
        clientRes,
        requestBuffer,
        estimator,
        logRequestEnd,
        startTime,
        watermarkContext
      );
    },
  };
}

module.exports = {
  logFilteredToolBody,
  sendRateLimit,
  sendGeminiRateLimit,
  createGeminiRateLimitSender,
  handleCountTokens,
  handleResponsesInputTokens,
  createLocalTokenHandlers,
};
