'use strict';

const { parseBoundedInteger, parsePortOrDefault } = require('../management-utils');

function normalizeGeminiStreamBufferMax(value) {
  return parseBoundedInteger(value, 1024 * 1024, 1, 4 * 1024 * 1024);
}

function appendGeminiStreamBuffer(state, chunkText, maxChars) {
  const safeMaxChars = normalizeGeminiStreamBufferMax(maxChars);
  state.buffer = (state.buffer || '') + chunkText;
  if (state.buffer.length > safeMaxChars) {
    state.buffer = '';
    throw new Error('Gemini SSE event too large; max ' + safeMaxChars + ' chars');
  }
}

function processGeminiStreamChunk({
  sink,
  state,
  chunkText,
  maxChars,
  processGeminiSseEvent,
  targetModel,
  unwrapEvent = (event) => event,
}) {
  appendGeminiStreamBuffer(state, chunkText, maxChars);
  const events = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = events.pop();
  for (const event of events) {
    processGeminiSseEvent(sink, unwrapEvent(event), state, targetModel);
  }
}

function finishGeminiClaudeStream({
  sink,
  state,
  targetModel,
  unwrapEvent = (event) => event,
  processGeminiSseEvent,
  flushPendingGeminiToolCall,
  writeClaudeSseEvent,
  geminiClaudeStopReason,
}) {
  if (state.buffer && state.buffer.trim()) {
    processGeminiSseEvent(sink, unwrapEvent(state.buffer), state, targetModel);
  }
  flushPendingGeminiToolCall(sink, state, state.tools);
  if (state.thinkingOpen) {
    writeClaudeSseEvent(sink, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.thinkingIndex,
    });
    state.thinkingOpen = false;
  }
  if (state.textOpen) {
    writeClaudeSseEvent(sink, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.textIndex,
    });
  }
  writeClaudeSseEvent(sink, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: geminiClaudeStopReason(state), stop_sequence: null },
    usage: state.usage,
  });
  writeClaudeSseEvent(sink, 'message_stop', { type: 'message_stop' });
}

function geminiStreamFailurePayload(err) {
  return {
    error: {
      type: 'upstream_response_too_large',
      message: err && err.message ? err.message : 'Gemini stream response is too large',
    },
  };
}

function failGeminiStream({
  clientReq,
  clientRes,
  proxyRes,
  upstreamPath,
  startTime,
  err,
  sendJsonError,
  logRequestEnd,
}) {
  if (proxyRes && typeof proxyRes.destroy === 'function') proxyRes.destroy();
  const payload = geminiStreamFailurePayload(err);
  if (!clientRes.headersSent) {
    sendJsonError(clientRes, 502, payload);
  } else {
    try {
      clientRes.write(': proxy-error ' + JSON.stringify(payload.error) + '\n\n');
    } catch (e) {}
    clientRes.end();
  }
  logRequestEnd(clientReq.method, upstreamPath, startTime, 502, {
    type: 'gemini_stream_response_too_large',
    error: err && err.message,
  });
}

function geminiCooldownMessage(retryAfterSeconds) {
  return 'Gemini rate limit cooldown active. Please retry in ' + retryAfterSeconds + 's.';
}

function sendGeminiLocalCooldown({
  clientReq,
  clientRes,
  upstreamPath,
  startTime,
  targetModel,
  cooldown,
  log,
  sendGeminiRateLimit,
}) {
  if (!cooldown) return false;
  log.warn(
    'gemini rate limited ' +
      clientReq.method +
      ' ' +
      upstreamPath +
      ' -> 429 retry_after=' +
      cooldown.retryAfterSeconds +
      's source=local_cooldown target=' +
      targetModel
  );
  sendGeminiRateLimit(
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    targetModel,
    cooldown.retryAfterSeconds,
    geminiCooldownMessage(cooldown.retryAfterSeconds),
    { source: 'local_cooldown' }
  );
  return true;
}

function geminiRetryHeaders(upstreamHeaders, statusCode, retryAfterSeconds) {
  const headers = { ...(upstreamHeaders || {}) };
  if (statusCode === 429 && retryAfterSeconds) {
    headers['retry-after'] = String(retryAfterSeconds);
  }
  return headers;
}

function applyGeminiCooldown({
  statusCode,
  retryAfterSeconds,
  profileId,
  targetModel,
  setGeminiCooldown,
  fallbackSeconds = 45,
}) {
  if (statusCode !== 429) return null;
  const seconds = retryAfterSeconds || fallbackSeconds;
  setGeminiCooldown(profileId, targetModel, seconds);
  return seconds;
}

function geminiUpstreamErrorEvent(clientReq, upstreamPath, statusCode, geminiError, extra = {}) {
  return {
    method: clientReq.method,
    path: upstreamPath,
    code: statusCode,
    type: 'gemini',
    errorType: geminiError.type,
    status: geminiError.status,
    retryAfterSeconds: geminiError.retryAfterSeconds,
    ...extra,
  };
}

function logGeminiDirectError({
  clientReq,
  upstreamPath,
  statusCode,
  targetModel,
  geminiError,
  cooldownSeconds,
  log,
}) {
  if (statusCode === 429) {
    log.warn(
      'gemini rate limited ' +
        clientReq.method +
        ' ' +
        upstreamPath +
        ' -> 429 retry_after=' +
        cooldownSeconds +
        's metric=' +
        (geminiError.quotaId || geminiError.quotaMetric || '-') +
        ' target=' +
        targetModel
    );
    return;
  }
  log.warn(
    'gemini error ' +
      clientReq.method +
      ' ' +
      upstreamPath +
      ' -> ' +
      statusCode +
      ' message=' +
      String(geminiError.message || '')
        .replace(/\s+/g, ' ')
        .slice(0, 500)
  );
}

function buildGeminiProxyRequestOptions({
  target,
  useCodeAssist,
  codeAssist,
  path,
  headers,
  env = process.env,
  timeout = 600000,
}) {
  const upstreamTarget = target || {};
  const protocol = upstreamTarget.protocol || 'https:';
  const targetFallbackPort = parsePortOrDefault(
    upstreamTarget.port,
    protocol === 'https:' ? 443 : 80
  );
  const codeAssistTarget = codeAssist && codeAssist.target ? codeAssist.target : null;
  const hostname =
    useCodeAssist && codeAssistTarget
      ? codeAssistTarget.hostname
      : env.TARGET || upstreamTarget.hostname;
  const port = parsePortOrDefault(
    useCodeAssist && codeAssistTarget
      ? codeAssistTarget.port || 443
      : env.TARGET_PORT || upstreamTarget.port,
    useCodeAssist ? 443 : targetFallbackPort
  );
  return {
    hostname,
    port,
    path,
    method: 'POST',
    headers,
    timeout,
  };
}

module.exports = {
  applyGeminiCooldown,
  appendGeminiStreamBuffer,
  buildGeminiProxyRequestOptions,
  failGeminiStream,
  finishGeminiClaudeStream,
  geminiCooldownMessage,
  geminiRetryHeaders,
  geminiStreamFailurePayload,
  geminiUpstreamErrorEvent,
  logGeminiDirectError,
  normalizeGeminiStreamBufferMax,
  processGeminiStreamChunk,
  sendGeminiLocalCooldown,
};
