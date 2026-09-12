const { pathForLogging } = require('./request-utils');

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
    const safePayload =
      payload && typeof payload === 'object' && typeof payload.path === 'string'
        ? { ...payload, path: pathForLogging(payload.path) }
        : payload;
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
    const estimatedContextTokens = estimateTokens(
      captureRequestBody(prepared.buffer || requestBuffer).body
    );
    return logRouteModelMapping(
      kind,
      method,
      upstreamPath,
      { ...prepared, estimatedContextTokens },
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
