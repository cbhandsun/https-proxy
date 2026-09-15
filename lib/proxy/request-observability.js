const { decodeBodyBuffer, pathForLogging } = require('./request-utils');

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

// Native byte scan: avoids allocating a decoded string for the overwhelming majority
// of bodies that carry no inline media.
const INLINE_MEDIA_BYTES_MARKER = Buffer.from(';base64,', 'ascii');

function bodyBufferCarriesInlineMedia(buffer) {
  return Buffer.isBuffer(buffer) && buffer.indexOf(INLINE_MEDIA_BYTES_MARKER) !== -1;
}

function createRequestObservability(dependencies = {}) {
  const {
    appendAuditTextBounded,
    captureRequestBody,
    createClaudeFilters,
    createDiagnostics,
    estimateTokens,
    getConfig,
    getReqId,
    isClaudeProfile,
    isGeminiProfile,
    isQuietLocalPollRequest,
    logRouteModelMapping,
    metricsInstance,
    parseBoundedInteger,
    populateAuditDataFromPreparedWithDeps,
    protocolOptions,
    sanitizeGeminiToolCall,
  } = dependencies;
  if (typeof getConfig !== 'function') {
    throw new TypeError('createRequestObservability requires getConfig');
  }
  const requestDurationHistogram =
    metricsInstance && typeof metricsInstance.histogram === 'function'
      ? metricsInstance.histogram('proxy_request_duration_seconds')
      : null;
  const proxyErrorsCounter =
    metricsInstance && typeof metricsInstance.counter === 'function'
      ? metricsInstance.counter('proxy_errors_total')
      : null;

  const { normalizeClaudeContent, isClaudeThinkingBlock, filterClaudeCompatibleBlocks } =
    createClaudeFilters({
      protocolOptions,
      makeSafeClaudeToolUseContentBlock: () => ({ type: 'text', text: '' }),
    });

  const diagnostics = createDiagnostics({
    getConfig,
    normalizeClaudeContent,
    sanitizeGeminiToolCall,
  });
  const { logProxyEvent: writeProxyEvent } = diagnostics;

  function shouldLogProxyEvent(kind, payload) {
    if (!payload) return true;
    if (kind !== 'request_start' && kind !== 'request_end') return true;
    const statusCode = Number(payload.statusCode || 0);
    if (statusCode >= 400) return true;
    return !isQuietLocalPollRequest(payload.method, payload.path);
  }

  function logProxyEvent(kind, payload) {
    // reqId is attached here rather than at each call site: route/proxy_error events
    // are emitted from socket-driven callbacks where AsyncLocalStorage context is
    // intact only because the pipeline re-enters it, and manual wiring proved easy to
    // miss. An explicit payload.reqId always wins.
    const withRequestId =
      payload && typeof payload === 'object'
        ? { ...payload, reqId: payload.reqId == null ? getReqId() : payload.reqId }
        : payload;
    const safePayload =
      withRequestId && typeof withRequestId === 'object' && typeof withRequestId.path === 'string'
        ? { ...withRequestId, path: pathForLogging(withRequestId.path) }
        : withRequestId;
    if (!shouldLogProxyEvent(kind, safePayload)) return false;
    writeProxyEvent(kind, safePayload);
    return true;
  }

  function logRequestEnd(method, path, startTime, statusCode, extra) {
    const elapsed = Date.now() - startTime;
    logProxyEvent('request_end', {
      reqId: getReqId(),
      method,
      path: pathForLogging(path),
      elapsed,
      statusCode,
      ...(extra || {}),
    });
    try {
      requestDurationHistogram?.observe(elapsed / 1000);
      if (statusCode && statusCode >= 500 && proxyErrorsCounter) {
        proxyErrorsCounter.inc(1, { type: extra?.type || 'unknown' });
      }
    } catch (error) {}
  }

  function installLocalManagementRequestEndLogger(clientRes, method, path, startTime) {
    if (!clientRes || clientRes.__localManagementRequestEndLogger) return;
    clientRes.__localManagementRequestEndLogger = true;
    clientRes.once('finish', () => {
      logRequestEnd(method, path, startTime, clientRes.statusCode || 200, {
        type: 'local_management',
      });
    });
  }

  const AUDIT_MAX_CAPTURE_BYTES = parseBoundedInteger(
    process.env.PROXY_AUDIT_MAX_CAPTURE_BYTES,
    256 * 1024,
    16 * 1024,
    4 * 1024 * 1024
  );
  const AUDIT_MAX_TEXT_CHARS = parseBoundedInteger(
    process.env.PROXY_AUDIT_MAX_TEXT_CHARS,
    120000,
    1024,
    1024 * 1024
  );
  const MAX_REQUEST_BODY_BYTES = parseBoundedInteger(
    process.env.PROXY_MAX_REQUEST_BODY_BYTES,
    64 * 1024 * 1024,
    1024 * 1024,
    256 * 1024 * 1024
  );
  const MAX_CONVERSION_RESPONSE_BYTES = parseBoundedInteger(
    process.env.PROXY_MAX_CONVERSION_RESPONSE_BYTES,
    64 * 1024 * 1024,
    1024 * 1024,
    256 * 1024 * 1024
  );

  function appendAuditText(current, addition) {
    return appendAuditTextBounded(current, addition, AUDIT_MAX_TEXT_CHARS);
  }

  function populateAuditDataFromPrepared(clientRes, prepared, requestBuffer) {
    return populateAuditDataFromPreparedWithDeps(clientRes, prepared, requestBuffer, {
      isGeminiProfile,
      isClaudeProfile,
    });
  }

  function logModelMapping(kind, method, upstreamPath, prepared, requestBuffer) {
    // captureRequestBody truncates for storage (default 120k chars). Estimating tokens
    // from the truncated text pins every oversized request at the same ceiling
    // (~30000), which hides exactly the requests that need diagnosing. Estimate from
    // the full decoded length instead and flag the value as a lower bound.
    const bodyBuffer = prepared.buffer || requestBuffer;
    const captured = captureRequestBody(bodyBuffer);
    // Inline media must not be billed as base64 characters. That only matters when
    // the body actually carries a data URL, so the extra JSON.parse stays off the
    // common path. A request that overflows the capture ceiling *and* embeds media is
    // exactly the incident shape, so paying one parse there is worth it.
    const structuredTokens = bodyBufferCarriesInlineMedia(bodyBuffer)
      ? parseJsonOrNull(decodeBodyBuffer(bodyBuffer))
      : null;
    // A successful structured estimate covers the whole body, so it is not a lower
    // bound even though the *stored* copy is still truncated.
    const estimatedContextTokens = structuredTokens
      ? estimateTokens(structuredTokens)
      : captured.truncated
        ? Math.ceil(captured.originalLength / 4)
        : estimateTokens(captured.body);
    const contextEstimateTruncated = !structuredTokens && captured.truncated;
    return logRouteModelMapping(
      kind,
      method,
      upstreamPath,
      { ...prepared, estimatedContextTokens, contextEstimateTruncated },
      logProxyEvent
    );
  }

  return {
    ...diagnostics,
    AUDIT_MAX_CAPTURE_BYTES,
    AUDIT_MAX_TEXT_CHARS,
    MAX_CONVERSION_RESPONSE_BYTES,
    MAX_REQUEST_BODY_BYTES,
    appendAuditText,
    filterClaudeCompatibleBlocks,
    installLocalManagementRequestEndLogger,
    isClaudeThinkingBlock,
    logModelMapping,
    logProxyEvent,
    logRequestEnd,
    normalizeClaudeContent,
    populateAuditDataFromPrepared,
  };
}

module.exports = { createRequestObservability };
