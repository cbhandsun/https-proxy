const http = require('http');
const https = require('https');
const { normalizeNativeCodexEntryPath } = require('./entry-routing');
const { installEntryCorsGuard: defaultInstallEntryCorsGuard } = require('./entry-auth');
const {
  getUpstreamCooldown: defaultGetUpstreamCooldown,
  parseRetryAfterHeaderSeconds: defaultParseRetryAfterHeaderSeconds,
  setUpstreamCooldown: defaultSetUpstreamCooldown,
} = require('./errors');
const { createLogger, enterRequest } = require('./logger');
const { antigravityCredentialFailure } = require('./antigravity-credentials');
const { inspectContentLength: inspectContentLengthDefault } = require('./request-utils');
const {
  createRequestTiming,
  installClientResponseTiming,
  observeUpstreamResponse,
  snapshotRequestTiming,
} = require('./request-timing');
const {
  applyChatStreamingPolicy,
  applyResponseStreamingPolicy,
  isChatStreamingForced,
  isResponseStreamingEnabled,
  jsonRequestStreamingPreference,
} = require('./performance-policy');
const { isDirectStreamingEligible } = require('./direct-request-streaming');
const { createDirectRequestObserver, deferDirectResponse } = require('./direct-request-contract');
const { collapseForcedStreamResponse } = require('./forced-stream-collector');
const { bindClaudeFilteredStream } = require('./handlers/claude-filtered-stream');
const {
  jsonObjectPassthroughRequest,
  guardJsonObjectResponse,
} = require('./json-object-response-guard');
const {
  normalizeCodexResponsesRequest,
  isCodexStreamResponse,
  hasCodexCompactionState,
} = require('./codex-responses-contract');
const {
  applyProviderContextHeaders,
  normalizeProviderContextRequest,
} = require('./provider-context-request');
const {
  isNativeOpenAIResponsesTarget,
  isOpenAIInputTokensPath,
} = require('./openai-context-management');
const {
  isAnthropicTokenCountPath,
  isNativeAnthropicMessagesTarget,
} = require('./anthropic-context-management');
const { isNativeGeminiDeveloperTarget } = require('./gemini-context-management');
const { setUtf8StreamEncoding } = require('./utf8-stream');
const {
  isResponsesCompactionPath,
  normalizeNativeResponsesCompactionRequest,
} = require('./native-responses-compaction');
const { guardNativeCompactionResponse } = require('./handlers/native-compaction-response');
const {
  normalizeWorkBuddyStandaloneCompactionRequest,
} = require('./workbuddy-standalone-compaction');
const {
  isPublicEntryHealthPath: defaultIsPublicEntryHealthPath,
  sendPublicEntryHealth: defaultSendPublicEntryHealth,
} = require('./entry-routing');

const { sanitizeWorkBuddyChatBody } = require('./workbuddy-official');
const { preflightWorkBuddyRequest } = require('./workbuddy-request-contract');
const { preflightDeepSeekRequest } = require('./deepseek-request-contract');
const { createWorkBuddyHttpTransport } = require('./workbuddy-http-transport');
const { captureAuditBody } = require('./conversation-audit-utils');
const { rejectContextOverflow } = require('./context-budget-manager');
const {
  sendConvertedLocalCooldown,
  shouldApplyConvertedRateLimitCooldown,
} = require('./handlers/converted-rate-limit');
const { terminateClientAfterUpstreamFailure } = require('./handlers/failure-terminal');
const { parseWorkBuddyResetCooldownSeconds } = require('./handlers/route-response-helpers');
const { createUpstreamTerminalState } = require('./handlers/upstream-terminal-state');
const { createDownstreamCancellation } = require('./handlers/downstream-cancellation');
const { observeUpstreamRequestConnection } = require('./handlers/upstream-connection-observer');
const { createUpstreamTerminalFrameWatcher } = require('./handlers/upstream-terminal-frame');
const { resolveUpstreamTimeout } = require('./handlers/upstream-timeout');
const {
  createUpstreamStreamGuard,
  clientAcceptsEventStream,
  collectUpstreamRequestFailureDiagnostics,
} = require('./handlers/upstream-stream-guard');
const {
  attachPreparedDiagnostics,
  updateClientDiagnostics,
} = require('./handlers/client-diagnostics');
// 握手阶段被重置时请求体尚未发出，据此判定重放是否安全。
const { readPreTransmissionContext } = require('./upstream-retry');
const { CONTEXT_TARGET_HEADER, inspectClientContextTarget } = require('./client-context-target');
const {
  createContextApiEvidenceRuntime,
  EVIDENCE_TOKEN_HEADER,
} = require('./context-api-evidence-runtime');
const { createContextApiEvidenceHttp, evidenceToken } = require('./context-api-evidence-http');
const { apiEvidenceKind } = require('./context-api-evidence-protocol');
const { installApiEvidenceResponseObserver } = require('./context-api-evidence-observer');

const safeLog = createLogger('core-request-handler');
const MAX_PASSTHROUGH_RATE_LIMIT_BODY_BYTES = 64 * 1024;
const PASSTHROUGH_RATE_LIMIT_FALLBACK_SECONDS = 45;
const MAX_PASSTHROUGH_RESET_COOLDOWN_SECONDS = 24 * 60 * 60;

function passthroughCooldownTargetModel(prepared) {
  const rewriteTo = String((prepared && prepared.rewriteTo) || '').trim();
  if (rewriteTo && rewriteTo !== '-') return rewriteTo;
  const model = String((prepared && prepared.model) || '').trim();
  return model.replace(/^(workbuddy|codebuddy)\//i, '');
}

function applyPassthroughRateLimitCooldown(options) {
  const {
    statusCode,
    headers,
    responseBody,
    prepared,
    parseRetryAfterHeaderSeconds = defaultParseRetryAfterHeaderSeconds,
    setUpstreamCooldown = defaultSetUpstreamCooldown,
  } = options || {};
  if (
    statusCode !== 429 ||
    !shouldApplyConvertedRateLimitCooldown(prepared) ||
    typeof setUpstreamCooldown !== 'function'
  ) {
    return null;
  }
  const profileId = prepared && prepared.profile && prepared.profile.id;
  const targetModel = passthroughCooldownTargetModel(prepared);
  if (!profileId || !targetModel) return null;
  const retryAfter =
    typeof parseRetryAfterHeaderSeconds === 'function'
      ? parseRetryAfterHeaderSeconds(headers && headers['retry-after'])
      : null;
  const resetCooldownSeconds = parseWorkBuddyResetCooldownSeconds(responseBody);
  const retryAfterSeconds =
    resetCooldownSeconds || retryAfter || PASSTHROUGH_RATE_LIMIT_FALLBACK_SECONDS;
  const source = resetCooldownSeconds
    ? 'upstream_reset_time'
    : retryAfter
      ? 'upstream_retry_after'
      : 'local_fallback';
  const cooldown = setUpstreamCooldown(profileId, targetModel, retryAfterSeconds, {
    source,
    ...(resetCooldownSeconds ? { maxSeconds: MAX_PASSTHROUGH_RESET_COOLDOWN_SECONDS } : {}),
  });
  if (!cooldown) return null;
  return {
    profileId,
    targetModel,
    retryAfterSeconds: cooldown.retryAfterSeconds,
    source,
  };
}

function sendPassthroughLocalCooldown(
  clientReq,
  clientRes,
  prepared,
  upstreamPath,
  startTime,
  deps
) {
  const targetModel = passthroughCooldownTargetModel(prepared);
  if (!targetModel) return false;
  return sendConvertedLocalCooldown(
    clientReq,
    clientRes,
    prepared,
    upstreamPath,
    startTime,
    targetModel,
    deps
  );
}

/**
 * Finish a passthrough forward as soon as the upstream sends its terminal SSE frame.
 *
 * Official Responses upstreams routinely send response.completed and then hold the
 * socket open. Waiting for socket close made a complete answer sit until
 * profile.timeoutMs and then fail with 502 + event: error (recorded in production as
 * >290s records whose audit already carried provider usage). The watcher only runs on
 * bodies already classified as streams, and only the first observer may settle.
 *
 * onComplete owns the ordering: it must settle the stream guard and terminal record
 * before the upstream socket is torn down, otherwise the guard's incomplete-close
 * check would report a failure for a request that already succeeded.
 */
function attachTerminalFrameCompletion({ proxyRes, isStream, onComplete }) {
  if (!isStream || !proxyRes || typeof proxyRes.on !== 'function') return null;
  return createUpstreamTerminalFrameWatcher({
    onTerminal: (marker) => {
      onComplete(marker);
    },
  });
}

function createCoreRequestHandler(dependencies = {}) {
  const {
    AUDIT_MAX_CAPTURE_BYTES,
    AUDIT_MAX_TEXT_CHARS,
    MAX_CONVERSION_RESPONSE_BYTES = 16 * 1024 * 1024,
    MAX_REQUEST_BODY_BYTES,
    appendAuditRecord,
    applyCliSessionModelOverride,
    applyManagedAuthHeaders,
    authorizeManagementRequest,
    authorizeEntryRequest,
    installEntryCorsGuard = defaultInstallEntryCorsGuard,
    buildOutgoingHeaders,
    captureRequestBody,
    collectLimitedRequestBody,
    createConversationAuditData,
    decryptKey,
    dispatchLocalManagementRoute,
    entryLabel,
    estimateCost,
    estimateUsageForRecord,
    extractUsageFromJsonPayload,
    flushClaudeSseFilter,
    forceChatEntry,
    forceClaudeEntry,
    forceResponsesEntry,
    getClaudeDesktopTraeProcessStyle,
    getClientIp,
    getProfiles,
    getUpstreamCooldown = defaultGetUpstreamCooldown,
    handleClaudeMessagesToOpenAIChat,
    handleClaudeMessagesToOpenAIResponses,
    handleCountTokens,
    handleGeminiResponsesInputTokens,
    handleResponsesInputTokens,
    handleGeminiMessages,
    handleLocalModelsRequest,
    handleOpenAIChatToClaudeMessages,
    handleOpenAIChatToGeminiMessages,
    handleOpenAIImageJobControl,
    handleOpenAIImageJobCreate,
    handleOpenAIImagesToGemini,
    handleOpenAIImagesToOpenAIOfficialResponses,
    handleOpenAIChatToOpenAIResponses,
    handleOpenAIResponsesToClaudeMessages,
    handleOpenAIResponsesToGeminiMessages,
    handleOpenAIResponsesToOpenAIChat,
    handleTianxiOfficialResponses,
    handleTraeOfficialChatCompletion,
    handleTraeOfficialClaudeMessages,
    handleTraeOfficialResponses,
    installConversationAuditResponseCapture,
    recordAuditUpstreamFailure,
    installLocalManagementRequestEndLogger,
    installManagementCorsGuard,
    inspectContentLength = inspectContentLengthDefault,
    isAllowedEntryPath,
    isAuthorizedClaudeDesktopRequest,
    isClaudeDesktop3pRequest,
    isClaudeDesktopRequest,
    isClaudeMessagesPath,
    isClaudeProfile,
    isConversationRequestPath,
    isEntryHealthPath,
    isPublicEntryHealthPath = defaultIsPublicEntryHealthPath,
    isGeminiProfile,
    isLocalManagementPath,
    isOpenAIChatCompletionsPath,
    isOpenAIImageJobsCollectionPath,
    isOpenAIImagesGenerationsPath,
    isOpenAIProfile,
    isOpenAIResponsesPath,
    isPublicLocalManagementPath,
    isQuietLocalPollRequest,
    loadConfig,
    log,
    logModelMapping,
    logProxyEvent,
    logRequestEnd,
    logUsage,
    managementHandlers,
    mcpHub,
    mergeUsage,
    metricsInstance,
    modelsFormatForEntry,
    noteUpstreamProfileUsed = () => {},
    parseModelsRequestPath,
    parseOpenAIImageJobId,
    parsePortOrDefault,
    parseRetryAfterHeaderSeconds = defaultParseRetryAfterHeaderSeconds,
    parseTargetUrl,
    populateAuditDataFromPrepared,
    prepareRequestBufferWithResolver,
    processClaudeSseChunk,
    profileMatchesEntryKey,
    redactHeaders,
    resolveClaudeDesktopRoute,
    resolveCliSession,
    resolveOfficialCredentials,
    resolveProfileProtocolVersion,
    resolveRoute,
    resolveUpstreamRecovery,
    routesForEntry,
    sampleRequestToolResults,
    sampleResponseChunk,
    sendEntryHealth,
    sendPublicEntryHealth = defaultSendPublicEntryHealth,
    sendEntryPathError,
    sendJsonError,
    sendRequestTooLarge,
    sendUnauthorizedClaudeDesktop,
    setUpstreamCooldown = defaultSetUpstreamCooldown,
    shouldConvertClaudeMessagesToOpenAI,
    shouldConvertResponsesToOpenAIChat,
    stripClaudeDesktopPrefix,
    stripEntryAuthHeaders,
    usageFromSsePayload,
    getRuntimeState,
  } = dependencies;
  if (typeof getRuntimeState !== 'function') {
    throw new TypeError('createCoreRequestHandler requires getRuntimeState');
  }
  const firstClientByteHistogram =
    metricsInstance && typeof metricsInstance.histogram === 'function'
      ? metricsInstance.histogram(
          'proxy_time_to_first_byte_seconds',
          'Time to first response byte in seconds'
        )
      : null;
  const firstVisibleTextHistogram =
    metricsInstance && typeof metricsInstance.histogram === 'function'
      ? metricsInstance.histogram(
          'proxy_time_to_first_visible_text_seconds',
          'Time to first visible streamed text in seconds'
        )
      : null;
  const guardUpstreamStream = createUpstreamStreamGuard({ logProxyEvent, logRequestEnd });
  const apiEvidence = createContextApiEvidenceRuntime();
  const apiEvidenceHttp = createContextApiEvidenceHttp(apiEvidence);

  function handleRequestInner(clientReq, clientRes, entry) {
    const {
      ACTIVE_PROFILE,
      CLAUDE_DESKTOP_ROUTES,
      CLI_SESSIONS,
      CONFIG,
      MANAGEMENT_TOKEN,
      MODEL_ROUTES,
      PROFILES,
      globalHttpAgent,
      globalHttpsAgent,
    } = getRuntimeState();
    apiEvidence.configure(CONFIG.appSettings?.contextEvidenceEnabled === true);
    const startTime = Date.now();
    // Official Codex/Responses upstreams answer with chunked encoding and no
    // content-type header, so neither clientRes.getHeader('content-type') nor the
    // upstream response can tell us that the client is reading SSE. The client's own
    // accept intent is authoritative, and without it a truncated stream would end with
    // a body indistinguishable from a clean completion.
    const clientWantsEventStream = /\btext\/event-stream\b/i.test(
      String(clientReq.headers.accept || '')
    );
    clientRes.__requestTiming = createRequestTiming(startTime);
    installClientResponseTiming(clientRes, clientRes.__requestTiming);
    clientRes.once('finish', function () {
      const timings = snapshotRequestTiming(clientRes.__requestTiming);
      if (!timings) return;
      try {
        if (timings.firstClientByteMs != null && firstClientByteHistogram) {
          firstClientByteHistogram.observe(timings.firstClientByteMs / 1000);
        }
        if (timings.firstVisibleTextMs != null && firstVisibleTextHistogram) {
          firstVisibleTextHistogram.observe(timings.firstVisibleTextMs / 1000);
        }
      } catch (_error) {}
    });
    const clientIp = getClientIp(clientReq);
    const urlPath = clientReq.url;
    const method = clientReq.method;
    const desktopRequest = isClaudeDesktopRequest(entry, urlPath);
    const effectiveUrlPath = normalizeNativeCodexEntryPath(
      entry,
      method,
      desktopRequest ? stripClaudeDesktopPrefix(urlPath) : urlPath
    );
    const effectiveUrlPathname = effectiveUrlPath.split('?')[0];
    const logPath = effectiveUrlPathname;
    const localManagementRequest = isLocalManagementPath(effectiveUrlPathname);
    // 指标埋点:每个非本地管理请求递增
    const isApiRequest = isConversationRequestPath(method, effectiveUrlPath);
    if (!localManagementRequest) {
      metricsInstance.counter('proxy_requests_total').inc();
    }
    const auditEnabled =
      isApiRequest &&
      process.env.PROXY_DISABLE_CONVERSATION_AUDIT !== '1' &&
      !(CONFIG.appSettings && CONFIG.appSettings.conversationAuditEnabled === false);

    if (auditEnabled) {
      const auditCaptureContent =
        CONFIG.appSettings && CONFIG.appSettings.conversationAuditCaptureContent === true;
      const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
      clientRes.__auditId = requestId;
      clientRes.__auditData = createConversationAuditData({
        id: requestId,
        startTime: Date.now(),
        method,
        path: logPath,
        clientIp,
        entryPort: entry && entry.listenPort,
        entryProtocol: entryLabel(entry),
        requestHeaders: clientReq.headers,
        redactHeaders,
        captureContent: auditCaptureContent,
      });

      installConversationAuditResponseCapture(clientRes, {
        maxCaptureBytes: AUDIT_MAX_CAPTURE_BYTES,
        maxTextChars: AUDIT_MAX_TEXT_CHARS,
        redactHeaders,
        mergeUsage,
        usageFromSsePayload,
        extractUsageFromJsonPayload,
        estimateUsageForRecord,
        logUsage,
        estimateCost,
        appendAuditRecord,
        config: CONFIG,
        log,
        captureContent: auditCaptureContent,
        // The audit capture normally learns "this is a stream" from the response
        // content-type. Official Codex/Responses upstreams answer with
        // transfer-encoding: chunked and no content-type, so the client's own accept
        // intent is the only reliable signal available before the first chunk.
        expectStream: /\btext\/event-stream\b/i.test(String(clientReq.headers.accept || '')),
      });
    }

    const { cliSession } = resolveCliSession(clientReq.headers, CLI_SESSIONS);
    if (cliSession) applyManagedAuthHeaders(clientReq.headers);

    const localPollRequest = isQuietLocalPollRequest(method, effectiveUrlPathname);
    if (!localPollRequest) {
      log.info('-> ' + method + ' ' + logPath + '  [' + clientIp + '] entry=' + entryLabel(entry));
      logProxyEvent('request_start', {
        reqId: clientReq.reqId,
        method,
        path: logPath,
        clientIp,
        entryProtocol: entryLabel(entry),
        entryPort: entry && entry.listenPort,
        claudeDesktop: desktopRequest,
      });
    }

    if (localManagementRequest && !installManagementCorsGuard(clientReq, clientRes)) {
      logRequestEnd(method, logPath, startTime, 403, { type: 'management_origin' });
      return;
    }
    if (
      !localManagementRequest &&
      typeof installEntryCorsGuard === 'function' &&
      !installEntryCorsGuard(clientReq, clientRes, CONFIG)
    ) {
      logRequestEnd(method, logPath, startTime, 403, { type: 'entry_origin' });
      return;
    }

    // CORS preflight
    if (method === 'OPTIONS') {
      clientRes.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      });
      clientRes.end();
      return;
    }

    // Local Admin APIs
    if (localManagementRequest && !isPublicLocalManagementPath(effectiveUrlPathname)) {
      installLocalManagementRequestEndLogger(clientRes, method, logPath, startTime);

      if (!authorizeManagementRequest(clientReq, MANAGEMENT_TOKEN)) {
        safeLog.warn(
          `[mgmt] Unauthorized management request from ${clientIp}: ${method} ${logPath}`
        );
        clientRes.writeHead(401, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Unauthorized management access' }));
        logRequestEnd(method, logPath, startTime, 401, { type: 'management_unauthorized' });
        return;
      }
    }
    if (
      dispatchLocalManagementRoute({
        method,
        pathname: effectiveUrlPathname,
        req: clientReq,
        res: clientRes,
        handlers: managementHandlers,
      })
    ) {
      return;
    }

    // Forward request - pass path as-is (SDK already includes /v1 from base_url)
    // Normalize path: tools may or may not include /v1 prefix
    if (
      (method === 'GET' || method === 'HEAD') &&
      (effectiveUrlPathname === '/favicon.ico' || effectiveUrlPathname === '/v1/favicon.ico')
    ) {
      clientRes.writeHead(204, {
        'Cache-Control': 'public, max-age=86400',
        'access-control-allow-origin': '*',
      });
      clientRes.end();
      return;
    }

    const clientPath =
      effectiveUrlPath.indexOf('/v1') === 0 ? effectiveUrlPath : '/v1' + effectiveUrlPath;
    if (
      typeof isPublicEntryHealthPath === 'function' &&
      typeof sendPublicEntryHealth === 'function' &&
      isPublicEntryHealthPath(method, clientPath)
    ) {
      sendPublicEntryHealth(clientRes, entry, method);
      logRequestEnd(method, logPath, startTime, 200, {
        type: 'public_entry_health',
        entryProtocol: entryLabel(entry),
      });
      return;
    }
    const entryAuth = authorizeEntryRequest(clientReq, entry, CONFIG);
    if (!entryAuth.ok) {
      sendJsonError(clientRes, 401, {
        error: {
          type: 'authentication_error',
          message: 'Invalid or missing proxy entry API key.',
        },
      });
      logRequestEnd(method, logPath, startTime, 401, { type: 'entry_auth' });
      return;
    }
    clientReq.entryAuth = entryAuth;
    if (
      desktopRequest &&
      !isAuthorizedClaudeDesktopRequest(CONFIG, clientReq.headers, decryptKey)
    ) {
      sendUnauthorizedClaudeDesktop(clientRes);
      logRequestEnd(method, logPath, startTime, 401, { type: 'claude_desktop_auth' });
      return;
    }
    if (
      apiEvidenceHttp.handle(
        clientReq,
        clientRes,
        clientPath,
        entryAuth,
        CONFIG.appSettings?.contextEvidenceEnabled === true
      )
    )
      return;
    if (isEntryHealthPath(entry, method, clientPath)) {
      sendEntryHealth(clientRes, entry, method, clientPath);
      logRequestEnd(method, logPath, startTime, 200, {
        type: 'entry_health',
        entryProtocol: entryLabel(entry),
      });
      return;
    }
    if (!isAllowedEntryPath(entry, method, clientPath)) {
      sendEntryPathError(clientRes, entry, method, clientPath);
      logRequestEnd(method, logPath, startTime, 404, {
        type: 'entry_path_mismatch',
        entryProtocol: entryLabel(entry),
      });
      return;
    }

    const imageJobId = parseOpenAIImageJobId(clientPath);
    if (forceChatEntry(entry) && imageJobId && (method === 'GET' || method === 'DELETE')) {
      handleOpenAIImageJobControl(clientReq, clientRes, imageJobId, startTime);
      return;
    }

    const modelRequest = parseModelsRequestPath(effectiveUrlPath);
    if ((method === 'GET' || method === 'HEAD') && modelRequest) {
      const entryRoutes = routesForEntry(entry, desktopRequest, {
        modelRoutes: MODEL_ROUTES,
        claudeDesktopRoutes: CLAUDE_DESKTOP_ROUTES,
      }).filter(
        (route) =>
          !entryAuth.enabled || profileMatchesEntryKey(entryAuth, { id: route && route.profileId })
      );
      const modelsResult = handleLocalModelsRequest(
        clientReq,
        clientRes,
        modelRequest,
        entryRoutes,
        desktopRequest || forceClaudeEntry(entry) ? 'claude' : modelsFormatForEntry(entry),
        desktopRequest || forceClaudeEntry(entry) ? 'claude' : entry && entry.protocol
      );
      logRequestEnd(method, logPath, startTime, modelsResult && modelsResult.status, {
        type: 'local_models',
        format: modelsResult && modelsResult.format,
        modelCount: modelsResult && modelsResult.modelCount,
      });
      return;
    }
    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders['host'];
    delete fwdHeaders[CONTEXT_TARGET_HEADER];
    delete fwdHeaders[EVIDENCE_TOKEN_HEADER];
    const evidenceKind = method === 'POST' ? apiEvidenceKind(clientPath) : null;
    const suppliedEvidenceToken = evidenceToken(clientReq.headers);
    const evidenceCapability =
      suppliedEvidenceToken === undefined || !evidenceKind
        ? null
        : apiEvidence.bind(entryAuth, suppliedEvidenceToken);
    if (evidenceKind && suppliedEvidenceToken !== undefined && !evidenceCapability) {
      sendJsonError(clientRes, 403, {
        error: {
          type: 'permission_denied',
          code: 'evidence_session_unavailable',
          message: 'The explicit evidence connection is unavailable.',
        },
      });
      logRequestEnd(method, logPath, startTime, 403, { type: 'evidence_session_unavailable' });
      return;
    }
    if (evidenceCapability)
      installApiEvidenceResponseObserver(clientRes, evidenceKind, evidenceCapability);
    if (entryAuth.enabled) stripEntryAuthHeaders(fwdHeaders);
    const pinnedContextRequest = Object.hasOwn(clientReq.headers, CONTEXT_TARGET_HEADER);
    if (pinnedContextRequest && !(method === 'POST' && isOpenAIResponsesPath(clientPath))) {
      sendJsonError(clientRes, 409, {
        error: {
          type: 'invalid_request_error',
          code: 'context_target_mismatch',
          message: 'Pinned context recovery requires the Responses endpoint.',
        },
      });
      logRequestEnd(method, logPath, startTime, 409, { type: 'context_target_mismatch' });
      return;
    }

    const contentLength = inspectContentLength(clientReq.headers, MAX_REQUEST_BODY_BYTES);
    if (contentLength.present && !contentLength.valid) {
      sendJsonError(clientRes, 400, {
        type: 'invalid_request_error',
        message: 'Invalid Content-Length header',
      });
      clientRes.once('finish', () => clientReq.socket?.destroy?.());
      logRequestEnd(method, logPath, startTime, 400, {
        type: 'invalid_content_length',
      });
      return;
    }
    if (contentLength.exceeds) {
      logProxyEvent('request_too_large', {
        method,
        path: logPath,
        bytes: contentLength.value,
        limit: MAX_REQUEST_BODY_BYTES,
      });
      sendRequestTooLarge(clientReq, clientRes, MAX_REQUEST_BODY_BYTES);
      clientRes.once('finish', () => clientReq.socket?.destroy?.());
      logRequestEnd(method, logPath, startTime, 413, {
        type: 'request_too_large',
        bytes: contentLength.value,
        limit: MAX_REQUEST_BODY_BYTES,
      });
      return;
    }

    const directEntryPath = isOpenAIChatCompletionsPath(clientPath) ? 'chat' : '';
    const directStreamingEligible =
      !pinnedContextRequest &&
      isDirectStreamingEligible({
        appSettings: CONFIG.appSettings,
        auditEnabled,
        cliSession,
        contentLength,
        entryAuth: {
          enabled: entryAuth.enabled,
          profileAllowed: profileMatchesEntryKey(entryAuth, ACTIVE_PROFILE),
        },
        entryPath: directEntryPath,
        modelRoutes: MODEL_ROUTES,
        profile: ACTIVE_PROFILE,
        requestEncoding: clientReq.headers['content-encoding'],
      });
    if (directStreamingEligible) {
      // Direct streaming bypasses doForward(), so it needs its own terminal record:
      // without one, a timeout or socket error leaves a request_start with no matching
      // request_end, and a late upstream 'end' could log a 200 after a failure.
      const directTerminalState = createUpstreamTerminalState({
        logRequestEnd,
        // Keep the conversation audit record in agreement with the events log: the
        // audit writer samples clientRes.statusCode, which stays 200 once the upstream
        // sent headers, so a late timeout would otherwise be audited as a success.
        recordFailure: (detail) => recordAuditUpstreamFailure(clientRes, detail),
      });
      const directProfile = {
        ...ACTIVE_PROFILE,
        apiKey: decryptKey(ACTIVE_PROFILE.apiKey || ''),
      };
      const target = parseTargetUrl(directProfile.targetUrl);
      const apiKey = process.env.API_KEY || directProfile.apiKey || null;
      const outgoingHeaders = buildOutgoingHeaders(fwdHeaders, {
        requestProtocol: 'openai',
        authMode: apiKey ? 'api-key' : undefined,
        apiKey,
        routed: false,
      });
      outgoingHeaders['accept-encoding'] = 'identity';
      const directCapture = createDirectRequestObserver(
        MAX_REQUEST_BODY_BYTES,
        evidenceCapability
          ? (body) => evidenceCapability.observeInput(evidenceKind, body)
          : undefined
      );
      const failDirectRequest = (error) => {
        if (directTerminalState.isSettled()) return;
        const statusCode = [400, 413].includes(error?.statusCode) ? error.statusCode : 502;
        const code =
          statusCode === 413
            ? 'request_too_large'
            : statusCode === 400
              ? 'invalid_request_error'
              : 'upstream_request_error';
        directTerminalState.fail({
          method,
          path: logPath,
          startTime,
          statusCode,
          type: 'direct_request_error',
          errorType: code,
          failureKind: code,
        });
        if (statusCode === 413) clientRes.once('finish', () => clientReq.socket?.destroy?.());
        if (!clientRes.headersSent)
          sendJsonError(clientRes, statusCode, {
            error: { type: code, message: 'Direct request could not be processed safely' },
          });
        else
          terminateClientAfterUpstreamFailure(clientRes, {
            stream: true,
            payload: {
              error: { type: code, message: 'Direct request could not be completed safely' },
            },
          });
        clientReq.unpipe?.(directCapture.observer);
        directCapture.observer.destroy();
        proxyReq.destroy();
      };
      const transport = target.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(
        {
          hostname: process.env.TARGET || target.hostname,
          port: parsePortOrDefault(
            process.env.TARGET_PORT || target.port,
            target.protocol === 'https:' ? 443 : 80
          ),
          path: target.path + clientPath.replace(/^\/v1/, ''),
          method,
          headers: outgoingHeaders,
          timeout: resolveUpstreamTimeout(directProfile),
          agent: target.protocol === 'https:' ? globalHttpsAgent : globalHttpAgent,
        },
        (proxyRes) => {
          if (directCancellation.isCancelled()) {
            proxyRes.destroy();
            return;
          }
          observeUpstreamResponse(clientRes, proxyRes);
          deferDirectResponse({
            capture: directCapture,
            proxyRes,
            onFailure: failDirectRequest,
            onReady: (metadata) => {
              const statusCode = proxyRes.statusCode || 502;
              if (metadata.request && statusCode >= 200 && statusCode < 300) {
                guardJsonObjectResponse({
                  proxyRes,
                  clientRes,
                  clientReq,
                  headers: proxyRes.headers,
                  statusCode,
                  request: metadata.request,
                  isStream: String(proxyRes.headers['content-type']).includes('text/event-stream'),
                  clientStreaming: metadata.stream,
                  maxBytes: MAX_CONVERSION_RESPONSE_BYTES,
                  sendJsonError,
                  onComplete: () => {
                    if (!directTerminalState.markComplete()) return;
                    logRequestEnd(method, logPath, startTime, statusCode, {
                      type: 'direct_json_object_validated',
                    });
                  },
                  onFailure: (code) =>
                    directTerminalState.fail({
                      method,
                      path: logPath,
                      startTime,
                      statusCode: code === 'client_disconnected' ? 499 : 502,
                      type: 'direct_json_object_output_error',
                      errorType: code,
                      failureKind: code,
                    }),
                });
                return;
              }
              clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
              const streamGuard = guardUpstreamStream(proxyRes, {
                clientRes,
                label: 'Upstream',
                logType: 'openai_direct_stream_aborted',
                method,
                upstreamPath: logPath,
                startTime,
                stream: clientWantsEventStream || clientAcceptsEventStream(clientRes),
                reportFailure: ({ message, reason, code, diagnostics }) =>
                  directTerminalState.fail({
                    method,
                    path: logPath,
                    startTime,
                    statusCode: 502,
                    type: 'openai_direct_stream_aborted',
                    errorType: 'upstream_stream_aborted',
                    failureKind: 'upstream_stream_aborted',
                    error: message,
                    extra: { reason, code, ...(diagnostics || {}) },
                  }),
              });
              proxyRes.on('end', () => {
                streamGuard.markComplete();
                if (!directTerminalState.markComplete()) return;
                logRequestEnd(method, logPath, startTime, proxyRes.statusCode || 502, {
                  type: 'openai_direct_stream',
                });
              });
              proxyRes.pipe(clientRes);
              // Same terminal-frame contract as the routed path: a completed answer must
              // not be held hostage by an upstream that keeps the socket open.
              const directTerminalWatcher = attachTerminalFrameCompletion({
                proxyRes,
                isStream: clientWantsEventStream || clientAcceptsEventStream(clientRes),
                onComplete: () => {
                  if (!directTerminalState.markComplete()) return;
                  streamGuard.markComplete();
                  if (!clientRes.writableEnded) {
                    try {
                      clientRes.end();
                    } catch (err) {}
                  }
                  logRequestEnd(method, logPath, startTime, proxyRes.statusCode || 502, {
                    type: 'openai_direct_stream_terminal',
                  });
                  try {
                    if (typeof proxyRes.unpipe === 'function') proxyRes.unpipe(clientRes);
                    if (typeof proxyRes.destroy === 'function') proxyRes.destroy();
                  } catch (err) {}
                },
              });
              if (directTerminalWatcher) {
                // Registered after pipe() so the terminal frame reaches the client first.
                proxyRes.on('data', (chunk) => directTerminalWatcher.push(chunk));
              }
            },
          });
        }
      );
      const directCancellation = createDownstreamCancellation({
        clientReq,
        clientRes,
        onCancel: () => {
          directCapture.observer.destroy();
          directTerminalState.fail({
            method,
            path: logPath,
            startTime,
            statusCode: 499,
            type: 'client_disconnected',
            errorType: 'client_disconnected',
            failureKind: 'client_disconnected',
          });
        },
      });
      directCancellation.setActive(proxyReq);
      proxyReq.once('timeout', () =>
        proxyReq.destroy(new Error('Gateway Timeout (Upstream request timed out)'))
      );
      proxyReq.once('error', () => {
        if (directCancellation.isCancelled()) return;
        failDirectRequest();
      });
      directCapture.observer.once('error', failDirectRequest);
      clientReq.pipe(directCapture.observer).pipe(proxyReq);
      return;
    }

    collectLimitedRequestBody(clientReq, {
      limit: MAX_REQUEST_BODY_BYTES,
      onTooLarge({ bytes, limit }) {
        enterRequest({ reqId: clientReq.reqId });
        logProxyEvent('request_too_large', {
          method,
          path: logPath,
          bytes,
          limit,
        });
        if (!clientRes.headersSent) {
          sendRequestTooLarge(clientReq, clientRes, limit);
          clientRes.once('finish', () => clientReq.socket?.destroy?.());
          logRequestEnd(method, logPath, startTime, 413, {
            type: 'request_too_large',
            bytes,
            limit,
          });
        }
      },
      onComplete({ tooLarge, buffer: requestBuffer }) {
        if (tooLarge) {
          return;
        }
        // This callback is driven by the incoming socket, so it runs outside the
        // withRequest() scope established in openai-proxy.js. Re-enter that scope or
        // every downstream route/proxy_error/request_end event loses reqId.
        enterRequest({ reqId: clientReq.reqId });
        if (clientRes.__auditData) {
          const captured = captureAuditBody(
            clientRes.__auditData,
            requestBuffer,
            clientReq.headers['content-encoding'],
            captureRequestBody
          );
          clientRes.__auditData.request = {
            ...clientRes.__auditData.request,
            body: captured.body,
            truncated: captured.truncated,
            originalLength: captured.originalLength,
          };
        }
        const desktop3pRequest = isClaudeDesktop3pRequest(clientReq.headers);
        const shouldUseDesktopRoutes = desktopRequest || desktop3pRequest;
        const initialPrepared = prepareRequestBufferWithResolver(
          requestBuffer,
          clientReq.headers['content-encoding'],
          shouldUseDesktopRoutes ? resolveClaudeDesktopRoute : resolveRoute
        );
        const nativeAnthropicTokenCount =
          method === 'POST' &&
          isAnthropicTokenCountPath(clientPath) &&
          initialPrepared.profile?.protocol === 'claude' &&
          isNativeAnthropicMessagesTarget(initialPrepared.profile);
        if (
          method === 'POST' &&
          isAnthropicTokenCountPath(clientPath) &&
          !nativeAnthropicTokenCount
        ) {
          populateAuditDataFromPrepared(clientRes, initialPrepared, requestBuffer);
          handleCountTokens(clientReq, clientRes, requestBuffer, logRequestEnd, startTime);
          return;
        }
        const nativeOpenAITokenCount =
          method === 'POST' &&
          isOpenAIInputTokensPath(clientPath) &&
          isNativeOpenAIResponsesTarget(initialPrepared.profile);
        const nativeGeminiTokenCount =
          method === 'POST' &&
          isOpenAIInputTokensPath(clientPath) &&
          initialPrepared.profile?.protocol === 'gemini' &&
          isNativeGeminiDeveloperTarget(initialPrepared.profile, null, initialPrepared);
        if (
          method === 'POST' &&
          isOpenAIInputTokensPath(clientPath) &&
          !nativeOpenAITokenCount &&
          !nativeGeminiTokenCount
        ) {
          populateAuditDataFromPrepared(clientRes, initialPrepared, requestBuffer);
          handleResponsesInputTokens(clientReq, clientRes, requestBuffer, logRequestEnd, startTime);
          return;
        }

        let activeForwardTerminal = null;
        const downstreamCancellation = createDownstreamCancellation({
          clientReq,
          clientRes,
          onCancel: () => {
            const detail = {
              method,
              path: logPath,
              startTime,
              statusCode: 499,
              type: 'client_disconnected',
              errorType: 'client_disconnected',
              failureKind: 'client_disconnected',
            };
            if (activeForwardTerminal) activeForwardTerminal.fail(detail);
            else
              logRequestEnd(method, logPath, startTime, 499, {
                type: detail.type,
                errorType: detail.errorType,
                failureKind: detail.failureKind,
              });
          },
        });

        function doForward(currentPrepared, attempt = 1) {
          if (downstreamCancellation.isCancelled() || clientRes.destroyed) return;
          const pinnedTarget = inspectClientContextTarget(
            clientReq.headers,
            currentPrepared,
            parseTargetUrl,
            currentPrepared.authMode === 'official-login'
              ? currentPrepared.profile?.apiKey || null
              : process.env.API_KEY || currentPrepared.profile?.apiKey || null
          );
          if (!pinnedTarget.ok) {
            clientRes.removeHeader?.(CONTEXT_TARGET_HEADER);
            sendJsonError(clientRes, 409, {
              error: {
                type: 'invalid_request_error',
                code: 'context_target_mismatch',
                message: 'The authorized context recovery target changed or is unavailable.',
              },
            });
            logRequestEnd(method, logPath, startTime, 409, { type: 'context_target_mismatch' });
            return;
          }
          if (pinnedTarget.pinned) clientRes.setHeader(CONTEXT_TARGET_HEADER, pinnedTarget.token);
          const MAX_RETRIES = 2; // Up to 3 total attempts
          // Response handlers below close over the upstream status variable, which
          // only exists once the upstream response callback fired. A client-visible
          // failure before that point (timeout, socket error) must not be logged as
          // a successful 200.
          let upstreamTimedOut = false;
          // A terminal failure (timeout or socket error) owns the client response and
          // the single request_end record. Later upstream callbacks - including the
          // response 'end' handler that only knows the upstream status - must not emit
          // a second, contradictory success record for the same request.
          const terminalState = createUpstreamTerminalState({
            logRequestEnd,
            recordFailure: (detail) => recordAuditUpstreamFailure(clientRes, detail),
          });
          activeForwardTerminal = terminalState;

          function settleUpstreamFailure(detail = {}) {
            return terminalState.fail({
              method,
              path: logPath,
              startTime,
              reason: detail.failureKind || detail.errorType || 'proxy_error',
              ...detail,
            });
          }
          const requestProtocol = isGeminiProfile(currentPrepared.profile)
            ? 'gemini'
            : isClaudeProfile(currentPrepared.profile)
              ? 'claude'
              : 'openai';
          // 协议版本透传:Claude 走 anthropic-version header
          const protocolVersion = resolveProfileProtocolVersion(currentPrepared.profile);
          if (protocolVersion) {
            // 通过 out-of-band 变量携带,稍后在 outgoingHeaders 合并
            currentPrepared._protocolVersion = protocolVersion;
          }

          if (clientRes.__auditData) {
            populateAuditDataFromPrepared(clientRes, currentPrepared, requestBuffer);
          }
          if (
            clientReq.entryAuth &&
            clientReq.entryAuth.enabled &&
            !profileMatchesEntryKey(clientReq.entryAuth, currentPrepared.profile)
          ) {
            sendJsonError(clientRes, 403, {
              error: {
                type: 'permission_denied',
                message: 'Proxy entry API key is not allowed to use this route.',
              },
            });
            logRequestEnd(method, logPath, startTime, 403, { type: 'entry_auth_profile' });
            return;
          }

          if (evidenceCapability && attempt === 1)
            evidenceCapability.observeInput(
              evidenceKind,
              requestBuffer,
              clientReq.headers['content-encoding']
            );

          if (
            currentPrepared.authMode === 'official-login' &&
            currentPrepared.authProvider === 'trae'
          ) {
            if (method === 'POST' && isOpenAIChatCompletionsPath(clientPath)) {
              handleTraeOfficialChatCompletion(
                clientReq,
                clientRes,
                requestBuffer,
                currentPrepared,
                startTime,
                urlPath
              );
              return;
            }
            if (method === 'POST' && isOpenAIResponsesPath(clientPath)) {
              handleTraeOfficialResponses(
                clientReq,
                clientRes,
                requestBuffer,
                currentPrepared,
                startTime,
                urlPath
              );
              return;
            }
            if (method === 'POST' && isClaudeMessagesPath(clientPath)) {
              handleTraeOfficialClaudeMessages(
                clientReq,
                clientRes,
                requestBuffer,
                currentPrepared,
                startTime,
                urlPath,
                {
                  claudeProcessStyle: shouldUseDesktopRoutes
                    ? getClaudeDesktopTraeProcessStyle(CONFIG, {
                        claudeDesktop3p: desktop3pRequest,
                      })
                    : '',
                }
              );
              return;
            }
            sendJsonError(clientRes, 501, {
              error: {
                type: 'not_implemented',
                message:
                  'Trae 官方登录桥接目前支持 OpenAI /v1/chat/completions、OpenAI /v1/responses 和 Claude /v1/messages。',
              },
            });
            logRequestEnd(method, logPath, startTime, 501, {
              type: 'trae_official_unsupported_path',
            });
            return;
          }

          if (
            currentPrepared.authMode === 'official-login' &&
            currentPrepared.authProvider === 'tianxi'
          ) {
            if (method === 'POST' && isOpenAIResponsesPath(clientPath)) {
              handleTianxiOfficialResponses(
                clientReq,
                clientRes,
                requestBuffer,
                currentPrepared,
                startTime,
                urlPath
              );
              return;
            }
            sendJsonError(clientRes, 501, {
              error: {
                type: 'not_implemented',
                message: 'Tianxi bridge currently supports OpenAI /v1/responses only.',
              },
            });
            logRequestEnd(method, logPath, startTime, 501, {
              type: 'tianxi_official_unsupported_path',
            });
            return;
          }

          noteUpstreamProfileUsed(currentPrepared.profile);
          const target = parseTargetUrl(currentPrepared.profile.targetUrl);
          const upstreamPath = target.path + clientPath.replace(/^\/v1/, '');
          const apiKey =
            currentPrepared.authMode === 'official-login'
              ? currentPrepared.profile.apiKey || null
              : process.env.API_KEY || currentPrepared.profile.apiKey || null;
          const isClaudeEntryRequest = forceClaudeEntry(entry) && isClaudeMessagesPath(clientPath);
          const isClaudeTokenCountRequest = isAnthropicTokenCountPath(clientPath);
          const isChatEntryRequest =
            forceChatEntry(entry) && isOpenAIChatCompletionsPath(clientPath);
          const isImagesEntryRequest =
            forceChatEntry(entry) && isOpenAIImagesGenerationsPath(clientPath);
          const isImageJobCreateRequest =
            forceChatEntry(entry) && isOpenAIImageJobsCollectionPath(clientPath);
          const isResponsesRequestPath = isOpenAIResponsesPath(clientPath);
          const isCompactionRequest = isResponsesCompactionPath(clientPath);
          if (isCompactionRequest) {
            try {
              const workbuddy =
                currentPrepared.authProvider === 'workbuddy' ||
                currentPrepared.profile?.protocol === 'workbuddy';
              const normalizeCompaction = workbuddy
                ? normalizeWorkBuddyStandaloneCompactionRequest
                : normalizeNativeResponsesCompactionRequest;
              currentPrepared = normalizeCompaction(currentPrepared, {
                target,
                apiKey,
                method,
                originalBuffer: requestBuffer,
                requestEncoding: clientReq.headers['content-encoding'],
                maxBytes: MAX_REQUEST_BODY_BYTES,
              });
            } catch (error) {
              const statusCode = error.statusCode || 400;
              sendJsonError(clientRes, statusCode, {
                error: { type: 'invalid_request_error', code: error.code, message: error.message },
              });
              logRequestEnd(method, logPath, startTime, statusCode, {
                type: 'native_compaction_request_invalid',
                errorCode: error.code,
              });
              return;
            }
            if (currentPrepared.workbuddyStandaloneCompaction === true) {
              handleOpenAIResponsesToOpenAIChat(
                clientReq,
                clientRes,
                currentPrepared,
                target,
                apiKey,
                upstreamPath,
                startTime
              );
              return;
            }
          }
          const isResponsesTokenCountRequest = isOpenAIInputTokensPath(clientPath);
          const isResponsesEntryRequest = forceResponsesEntry(entry) && isResponsesRequestPath;
          if (
            isResponsesTokenCountRequest &&
            currentPrepared.profile?.protocol === 'gemini' &&
            isNativeGeminiDeveloperTarget(currentPrepared.profile, target, currentPrepared)
          ) {
            handleGeminiResponsesInputTokens(
              clientReq,
              clientRes,
              currentPrepared,
              target,
              apiKey,
              upstreamPath,
              startTime
            );
            return;
          }
          const isRoutedResponsesConversionRequest =
            isResponsesRequestPath &&
            (isClaudeProfile(currentPrepared.profile) || isGeminiProfile(currentPrepared.profile));
          const clientStreamingPreference = jsonRequestStreamingPreference(
            currentPrepared,
            clientReq.headers['content-encoding']
          );
          if (
            clientStreamingPreference === false &&
            isChatEntryRequest &&
            isChatStreamingForced(CONFIG)
          ) {
            currentPrepared = { ...currentPrepared, forceUpstreamChatStreaming: true };
          }

          if (
            currentPrepared.authMode === 'official-login' &&
            currentPrepared.authProvider === 'google' &&
            isGeminiProfile(currentPrepared.profile) &&
            !(typeof apiKey === 'string' && apiKey.startsWith('ya29.'))
          ) {
            sendJsonError(clientRes, 401, {
              error: {
                type: 'authentication_error',
                message:
                  'Google official-login credentials are unavailable or expired. Please sign in again before using this route.',
              },
            });
            logRequestEnd(method, logPath, startTime, 401, {
              type: 'google_official_auth_missing',
            });
            return;
          }

          if (method === 'POST') {
            try {
              preflightWorkBuddyRequest(currentPrepared, {
                requestPath: clientPath,
                requestEncoding: clientReq.headers['content-encoding'],
              });
              preflightDeepSeekRequest(currentPrepared, {
                requestPath: clientPath,
                requestEncoding: clientReq.headers['content-encoding'],
              });
            } catch (error) {
              if (error.code !== 'invalid_request_error') throw error;
              sendJsonError(clientRes, 400, {
                error: { type: error.code, message: error.message },
              });
              logRequestEnd(method, logPath, startTime, 400, {
                type:
                  error.provider === 'deepseek'
                    ? 'deepseek_request_invalid'
                    : 'workbuddy_request_invalid',
              });
              return;
            }
          }

          const isResponsesUpstream =
            currentPrepared.profile &&
            (currentPrepared.profile.api === 'openai-codex-responses' ||
              currentPrepared.profile.api === 'openai-responses' ||
              currentPrepared.profile.protocol === 'openai-responses' ||
              (currentPrepared.profile.targetUrl &&
                (currentPrepared.profile.targetUrl.includes('/backend-api/codex') ||
                  currentPrepared.profile.targetUrl.includes('/backend-api'))));

          // 协议转换路由表:把 8 个 if 块(原 270 行)合并成数据驱动的调度。
          // 每条路由包含:匹配谓词、logModelMapping 标签、压缩请求体拒绝消息、目标 handler。
          // 第一个匹配的路由会处理并 return,后续路由不再评估(与原代码语义一致)。
          const conversionRoutes = [
            {
              label: 'image-job->gemini',
              match:
                isImageJobCreateRequest &&
                isGeminiProfile(currentPrepared.profile) &&
                method === 'POST',
              rejectMessage:
                'OpenAI image jobs to Gemini conversion does not support compressed request bodies',
              handler: handleOpenAIImageJobCreate,
            },
            {
              label: 'chat->responses',
              match:
                isResponsesUpstream && isOpenAIChatCompletionsPath(clientPath) && method === 'POST',
              rejectMessage:
                'Chat to Responses conversion does not support compressed request bodies',
              handler: handleOpenAIChatToOpenAIResponses,
            },
            {
              label: 'claude->responses',
              match: isResponsesUpstream && isClaudeEntryRequest && method === 'POST',
              rejectMessage:
                'Claude to Responses conversion does not support compressed request bodies',
              handler: handleClaudeMessagesToOpenAIResponses,
            },
            {
              label: 'claude->openai',
              match:
                method === 'POST' &&
                (shouldConvertClaudeMessagesToOpenAI(
                  clientReq,
                  currentPrepared.profile,
                  clientPath
                ) ||
                  (isClaudeEntryRequest && isOpenAIProfile(currentPrepared.profile))),
              rejectMessage:
                'Claude to OpenAI conversion does not support compressed request bodies',
              handler: handleClaudeMessagesToOpenAIChat,
            },
            {
              label: 'images->openai-official-responses',
              match:
                isImagesEntryRequest &&
                isResponsesUpstream &&
                currentPrepared.authMode === 'official-login' &&
                currentPrepared.authProvider === 'openai' &&
                method === 'POST',
              rejectMessage:
                'OpenAI Images to OpenAI official Responses conversion does not support compressed request bodies',
              handler: handleOpenAIImagesToOpenAIOfficialResponses,
            },
            {
              label: 'images->gemini',
              match:
                isImagesEntryRequest &&
                isGeminiProfile(currentPrepared.profile) &&
                method === 'POST',
              rejectMessage:
                'OpenAI Images to Gemini conversion does not support compressed request bodies',
              handler: handleOpenAIImagesToGemini,
            },
            {
              label: 'openai->gemini',
              match:
                isChatEntryRequest && isGeminiProfile(currentPrepared.profile) && method === 'POST',
              rejectMessage:
                'OpenAI to Gemini conversion does not support compressed request bodies',
              handler: handleOpenAIChatToGeminiMessages,
            },
            {
              label: 'openai->claude',
              match:
                isClaudeProfile(currentPrepared.profile) &&
                method === 'POST' &&
                isOpenAIChatCompletionsPath(clientPath),
              rejectMessage:
                'OpenAI to Claude conversion does not support compressed request bodies',
              handler: handleOpenAIChatToClaudeMessages,
            },
            {
              label: 'responses->claude',
              match:
                (isResponsesEntryRequest || isRoutedResponsesConversionRequest) &&
                method === 'POST' &&
                isClaudeProfile(currentPrepared.profile),
              rejectMessage:
                'OpenAI Responses conversion does not support compressed request bodies',
              handler: handleOpenAIResponsesToClaudeMessages,
            },
            {
              label: 'responses->gemini',
              match:
                (isResponsesEntryRequest || isRoutedResponsesConversionRequest) &&
                method === 'POST' &&
                isGeminiProfile(currentPrepared.profile),
              rejectMessage:
                'OpenAI Responses conversion does not support compressed request bodies',
              handler: handleOpenAIResponsesToGeminiMessages,
            },
            {
              label: 'responses->chat',
              match:
                isResponsesEntryRequest &&
                method === 'POST' &&
                isOpenAIProfile(currentPrepared.profile) &&
                shouldConvertResponsesToOpenAIChat(currentPrepared.profile),
              rejectMessage: null,
              handler: handleOpenAIResponsesToOpenAIChat,
            },
            {
              label: 'claude->gemini',
              match:
                isGeminiProfile(currentPrepared.profile) &&
                method === 'POST' &&
                isClaudeMessagesPath(clientPath),
              rejectMessage: 'Gemini conversion does not support compressed request bodies',
              handler: handleGeminiMessages,
            },
          ];

          function tryConversionRoute(route) {
            if (!route.match) return false;
            if (route.rejectMessage && clientReq.headers['content-encoding']) {
              clientRes.writeHead(400, {
                'Content-Type': 'application/json; charset=utf-8',
                'access-control-allow-origin': '*',
              });
              clientRes.end(
                JSON.stringify({
                  error: { type: 'invalid_request_error', message: route.rejectMessage },
                })
              );
              return true;
            }
            logModelMapping(route.label, method, upstreamPath, currentPrepared, requestBuffer);
            route.handler(
              clientReq,
              clientRes,
              currentPrepared,
              target,
              apiKey,
              upstreamPath,
              startTime
            );
            return true;
          }

          for (const route of conversionRoutes) {
            if (tryConversionRoute(route)) return;
          }

          if (isImageJobCreateRequest) {
            sendJsonError(clientRes, 501, {
              error: {
                type: 'not_implemented',
                message: 'Image jobs currently require a Gemini-backed model route.',
              },
            });
            logRequestEnd(method, logPath, startTime, 501, {
              type: 'image_job_unsupported_profile',
            });
            return;
          }

          // These policies only change the upstream transport. Protocol-conversion handlers own
          // their streaming behavior, so applying the policy before dispatch would leak SSE to a
          // client that explicitly requested a JSON response.
          try {
            currentPrepared = normalizeProviderContextRequest(currentPrepared, {
              target,
              isResponsesRequest: isResponsesEntryRequest,
              isClaudeMessagesRequest: isClaudeEntryRequest,
              isClaudeTokenCountRequest,
              requestEncoding: clientReq.headers['content-encoding'],
              protocolOptions: CONFIG.protocolOptions || {},
            });
            currentPrepared = normalizeCodexResponsesRequest(currentPrepared, {
              target,
              isResponsesRequest: isResponsesEntryRequest,
              requestEncoding: clientReq.headers['content-encoding'],
            });
          } catch (error) {
            if (error.code !== 'invalid_request_error') throw error;
            sendJsonError(clientRes, 400, { error: { type: error.code, message: error.message } });
            logRequestEnd(method, logPath, startTime, 400, { type: 'codex_request_invalid' });
            return;
          }
          currentPrepared = applyResponseStreamingPolicy(currentPrepared, {
            enabled: isResponseStreamingEnabled(CONFIG, clientReq.reqId),
            isResponsesRequest: isResponsesEntryRequest,
            requestEncoding: clientReq.headers['content-encoding'],
          });
          const isWorkBuddy =
            currentPrepared.authProvider === 'workbuddy' ||
            (currentPrepared.profile &&
              (currentPrepared.profile.protocol === 'workbuddy' ||
                String(currentPrepared.profile.id).toLowerCase().includes('workbuddy')));
          if (
            isWorkBuddy &&
            sendPassthroughLocalCooldown(
              clientReq,
              clientRes,
              currentPrepared,
              upstreamPath,
              startTime,
              { getUpstreamCooldown, log, logRequestEnd }
            )
          ) {
            return;
          }
          currentPrepared = applyChatStreamingPolicy(currentPrepared, {
            enabled: isChatStreamingForced(CONFIG) || isWorkBuddy,
            isChatRequest: isChatEntryRequest,
            requestEncoding: clientReq.headers['content-encoding'],
          });
          if (
            isWorkBuddy &&
            isChatEntryRequest &&
            !clientReq.headers['content-encoding'] &&
            currentPrepared.buffer
          ) {
            let sanitizedBody;
            try {
              const parsedBody = JSON.parse(currentPrepared.buffer.toString('utf8'));
              sanitizedBody = sanitizeWorkBuddyChatBody(parsedBody, {
                targetModel:
                  currentPrepared.rewriteTo !== '-' ? currentPrepared.rewriteTo : parsedBody.model,
              });
              if (
                sanitizedBody.__hpmDiagnostics &&
                typeof sanitizedBody.__hpmDiagnostics === 'object'
              ) {
                clientRes.__diagnostics = {
                  protocol: currentPrepared.profile && currentPrepared.profile.protocol,
                  route: currentPrepared.model,
                  target:
                    currentPrepared.rewriteTo !== '-'
                      ? currentPrepared.rewriteTo
                      : parsedBody.model,
                  upstreamPath,
                  profile: currentPrepared.profile && currentPrepared.profile.id,
                  hpmDiagnostics: sanitizedBody.__hpmDiagnostics,
                };
              }
              currentPrepared.buffer = Buffer.from(JSON.stringify(sanitizedBody));
              currentPrepared.bodyChanged = true;
            } catch (e) {}
            if (sanitizedBody && rejectContextOverflow(clientRes, sanitizedBody, sendJsonError)) {
              return;
            }
          }
          if (!clientReq.headers['content-encoding'] && currentPrepared.buffer) {
            try {
              const parsedBody = JSON.parse(currentPrepared.buffer.toString('utf8'));
              attachPreparedDiagnostics(clientRes, currentPrepared, upstreamPath, parsedBody, {
                protocol:
                  currentPrepared.profile && currentPrepared.profile.protocol
                    ? currentPrepared.profile.protocol
                    : requestProtocol,
                entryProtocol: entryLabel(entry),
                missingReason:
                  isResponsesRequestPath && isOpenAIProfile(currentPrepared.profile)
                    ? 'direct-responses-passthrough'
                    : 'diagnostics-not-attached',
              });
            } catch (diagnosticsError) {
              // Diagnostics are best-effort observability: a body that cannot be
              // parsed must not fail the proxied request, but the reason has to be
              // recorded instead of silently swallowed.
              log.debug(
                'Context diagnostics were not attached for ' +
                  logPath +
                  ': ' +
                  (diagnosticsError && diagnosticsError.message
                    ? diagnosticsError.message
                    : diagnosticsError)
              );
            }
          }

          if (method === 'POST' && isClaudeMessagesPath(clientPath))
            sampleRequestToolResults(currentPrepared, requestProtocol, upstreamPath);

          const outgoingHeaders = buildOutgoingHeaders(fwdHeaders, {
            requestProtocol,
            protocolVersion: currentPrepared._protocolVersion,
            authMode: currentPrepared.authMode,
            authProvider: currentPrepared.authProvider,
            uid:
              (currentPrepared.workbuddyAuth && currentPrepared.workbuddyAuth.uid) ||
              (currentPrepared.profile && currentPrepared.profile.uid),
            profile: currentPrepared.profile,
            apiKey,
            routed: currentPrepared.routed,
            bodyChanged: currentPrepared.bodyChanged,
            bodyBuffer: currentPrepared.buffer,
          });
          applyProviderContextHeaders(outgoingHeaders, currentPrepared);
          const nativeJsonObjectRequest = jsonObjectPassthroughRequest(
            currentPrepared.buffer,
            clientPath
          );
          if (
            currentPrepared.forcedChatStreaming ||
            currentPrepared.forcedResponseStreaming ||
            nativeJsonObjectRequest ||
            isCompactionRequest
          ) {
            outgoingHeaders['accept-encoding'] = 'identity';
          }
          if (currentPrepared.routed) {
            logModelMapping('route', method, upstreamPath, currentPrepared, requestBuffer);
          }

          if (clientRes.__auditData) {
            clientRes.__auditData.upstream = {
              method,
              path: upstreamPath,
              targetHost: target.hostname,
              targetProtocol: target.protocol,
              headers: redactHeaders(outgoingHeaders),
              body: captureAuditBody(
                clientRes.__auditData,
                currentPrepared.buffer,
                outgoingHeaders['content-encoding'],
                captureRequestBody
              ).body,
            };
          }

          const transport =
            (isChatEntryRequest && createWorkBuddyHttpTransport(currentPrepared, apiKey)) ||
            (target.protocol === 'https:' ? https : http);
          let upstreamResponseSeen = false;
          let upstreamResponseStatusCode = null;
          const proxyReq = transport.request(
            {
              hostname: process.env.TARGET || target.hostname,
              port: parsePortOrDefault(
                process.env.TARGET_PORT || target.port,
                target.protocol === 'https:' ? 443 : 80
              ),
              path: upstreamPath,
              method: method,
              headers: outgoingHeaders,
              timeout: resolveUpstreamTimeout(currentPrepared && currentPrepared.profile),
              agent: target.protocol === 'https:' ? globalHttpsAgent : globalHttpAgent,
            },
            (proxyRes) => {
              if (downstreamCancellation.isCancelled()) {
                proxyRes.destroy();
                return;
              }
              upstreamResponseSeen = true;
              upstreamResponseStatusCode = proxyRes.statusCode;
              observeUpstreamResponse(clientRes, proxyRes);
              const code = proxyRes.statusCode;
              const recovery = resolveUpstreamRecovery({
                kind: 'status',
                statusCode: code,
                attempt,
                maxRetries: MAX_RETRIES,
                prepared: currentPrepared,
                profiles:
                  isCompactionRequest || hasCodexCompactionState(currentPrepared)
                    ? []
                    : getProfiles(loadConfig()) || [],
                retryAfter: proxyRes.headers['retry-after'],
                method,
                headers: clientReq.headers,
                responseStarted: clientRes.headersSent,
                allowPostFailover: !clientRes.headersSent,
              });

              if (recovery.type === 'failover') {
                safeLog.warn(
                  `[Failover] Upstream returned status ${code}, falling back to backup profile: ${recovery.profile.id}`
                );
                const backupPrepared = { ...currentPrepared, profile: recovery.profile };
                proxyRes.destroy();
                doForward(backupPrepared, 2);
                return;
              }

              if (recovery.type === 'retry') {
                safeLog.warn(
                  `[Retry] Upstream returned ${code}, retrying in ${Math.round(recovery.delayMs)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
                );
                proxyRes.destroy();
                setTimeout(() => doForward(currentPrepared, attempt + 1), recovery.delayMs);
                return;
              }

              const headers = {
                ...proxyRes.headers,
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'access-control-allow-headers': '*',
              };

              if (isCompactionRequest && code >= 200 && code < 300) {
                guardNativeCompactionResponse({
                  proxyRes,
                  clientRes,
                  headers,
                  statusCode: code,
                  maxBytes: MAX_CONVERSION_RESPONSE_BYTES,
                  sendJsonError,
                  onComplete: () => {
                    if (!terminalState.markComplete()) return;
                    logRequestEnd(method, logPath, startTime, code, {
                      type: 'native_compaction_validated',
                    });
                  },
                  onFailure: (errorCode) =>
                    settleUpstreamFailure({
                      failureKind: 'native_compaction_error',
                      type: 'native_compaction_error',
                      errorType: errorCode,
                      statusCode: 502,
                    }),
                });
                return;
              }

              const codexStream = isCodexStreamResponse(currentPrepared, code, proxyRes.headers);
              const isStream =
                codexStream ||
                (proxyRes.headers['content-type'] || '').indexOf('text/event-stream') >= 0;
              if (codexStream && !headers['content-type'])
                headers['content-type'] = 'text/event-stream; charset=utf-8';
              const shouldCaptureRateLimitBody =
                code === 429 && shouldApplyConvertedRateLimitCooldown(currentPrepared);
              const rateLimitBodyChunks = [];
              let rateLimitBodyBytes = 0;
              const responseContractKind = currentPrepared.forcedChatStreaming
                ? 'chat'
                : currentPrepared.forcedResponseStreaming
                  ? 'responses'
                  : clientStreamingPreference === false && isChatEntryRequest
                    ? 'chat'
                    : clientStreamingPreference === false && isResponsesEntryRequest
                      ? 'responses'
                      : null;
              const shouldCollapseForcedStream = isStream && responseContractKind !== null;
              const jsonObjectRequest = code >= 200 && code < 300 ? nativeJsonObjectRequest : null;
              if (jsonObjectRequest) {
                guardJsonObjectResponse({
                  proxyRes,
                  clientRes,
                  clientReq,
                  headers,
                  statusCode: code,
                  request: jsonObjectRequest,
                  isStream,
                  clientStreaming: clientStreamingPreference,
                  maxBytes: MAX_CONVERSION_RESPONSE_BYTES,
                  sendJsonError,
                  onComplete: () => {
                    if (!terminalState.markComplete()) return;
                    logRequestEnd(method, logPath, startTime, code, {
                      type: 'json_object_validated',
                    });
                  },
                  onFailure: (errorCode) =>
                    settleUpstreamFailure({
                      failureKind: 'json_object_output_error',
                      type: 'json_object_output_error',
                      errorType: errorCode,
                      statusCode: 502,
                    }),
                });
                return;
              }
              const shouldSanitizeOpenAIStream =
                code >= 200 &&
                code < 300 &&
                isStream &&
                isClaudeMessagesPath(clientPath) &&
                isOpenAIProfile(currentPrepared.profile);
              const shouldProtectStream =
                code >= 200 &&
                code < 300 &&
                isStream &&
                isClaudeMessagesPath(clientPath) &&
                !isOpenAIProfile(currentPrepared.profile);
              if (shouldProtectStream || shouldSanitizeOpenAIStream || shouldCollapseForcedStream)
                delete headers['content-length'];
              if (shouldCollapseForcedStream) {
                // The collector answers failures itself (JSON 502 before headers), so the
                // stream guard only needs to catch an incomplete close with no 'end' and
                // no 'error' - a shape that otherwise leaves the client waiting forever.
                guardUpstreamStream(proxyRes, {
                  clientRes,
                  label: 'Upstream',
                  logType: responseContractKind + '_stream_collapse_error',
                  method,
                  upstreamPath,
                  startTime,
                  stream: false,
                  respondOnFailure: false,
                  reportFailure: ({ reason, code, message, diagnostics }) => {
                    settleUpstreamFailure({
                      failureKind: 'stream_collapse_aborted',
                      type: responseContractKind + '_stream_collapse_error',
                      errorType: 'upstream_stream_aborted',
                      statusCode: 502,
                      error: message,
                      extra: { reason, code, ...(diagnostics || {}) },
                    });
                  },
                });
                collapseForcedStreamResponse({
                  clientRes,
                  headers,
                  kind: responseContractKind,
                  maxBytes: MAX_CONVERSION_RESPONSE_BYTES,
                  proxyRes,
                  sendJsonError,
                  statusCode: code,
                  onComplete: () => {
                    if (!terminalState.markComplete()) return;
                    logRequestEnd(method, logPath, startTime, code, {
                      type: responseContractKind + '_stream_collapsed',
                    });
                  },
                  onFailure: (statusCode) => {
                    if (terminalState.isSettled()) return;
                    settleUpstreamFailure({
                      failureKind: 'stream_collapse_error',
                      type: responseContractKind + '_stream_collapse_error',
                      errorType: 'stream_collapse_error',
                      statusCode,
                    });
                  },
                });
                return;
              }
              clientRes.writeHead(code, headers);
              let logged = false;
              if (shouldSanitizeOpenAIStream || shouldProtectStream) {
                updateClientDiagnostics(clientRes, {
                  protocol: 'openai',
                  route: currentPrepared.model,
                  target: currentPrepared.rewriteTo,
                  upstreamPath,
                  profile: currentPrepared.profile && currentPrepared.profile.id,
                });
                const streamType = shouldSanitizeOpenAIStream
                  ? 'openai_stream_sanitized'
                  : 'openai_stream_protected';
                const sseState = {
                  buffer: '',
                  pendingClaudeTool: null,
                  ...(shouldSanitizeOpenAIStream ? { mode: 'strip-empty-optionals' } : {}),
                };
                const streamGuard = guardUpstreamStream(proxyRes, {
                  clientRes,
                  label: 'OpenAI',
                  logType: streamType + '_aborted',
                  method,
                  upstreamPath,
                  startTime,
                  reportFailure: (detail) =>
                    settleUpstreamFailure({
                      failureKind: 'upstream_stream_aborted',
                      type: detail.logType,
                      errorType: detail.errorType,
                      error: detail.message,
                      extra: {
                        reason: detail.reason,
                        code: detail.code,
                        ...(detail.diagnostics || {}),
                      },
                    }),
                });
                setUtf8StreamEncoding(proxyRes);
                bindClaudeFilteredStream({
                  proxyRes,
                  clientRes,
                  clientReq,
                  upstreamPath,
                  startTime,
                  state: sseState,
                  streamGuard,
                  protocolOptions: CONFIG.protocolOptions || {},
                  processChunk: processClaudeSseChunk,
                  finish: flushClaudeSseFilter,
                  sampleChunk: (text) =>
                    sampleResponseChunk('openai-upstream', text, {
                      route: currentPrepared.model,
                      target: currentPrepared.rewriteTo,
                      upstreamPath,
                    }),
                  onFailure: (failureCode) =>
                    settleUpstreamFailure({
                      failureKind: 'claude_filter_conversion_error',
                      type: streamType + '_error',
                      errorType: 'conversion_failed',
                      statusCode: 502,
                      extra: { code: failureCode },
                    }),
                  onOutputFailure: (failureCode) =>
                    terminalState.fail({
                      reason: failureCode,
                      errorType: 'conversion_output_error',
                      statusCode: failureCode === 'client_disconnected' ? 499 : 502,
                    }),
                  logRequestEnd: (...args) => {
                    if (args[3] < 400 && !terminalState.markComplete()) return;
                    logRequestEnd(...args);
                  },
                  onComplete: (report) =>
                    report(method, logPath, startTime, code, { type: streamType }),
                });
                return;
              }

              proxyRes.on('data', function (_chunk) {
                if (
                  shouldCaptureRateLimitBody &&
                  rateLimitBodyBytes < MAX_PASSTHROUGH_RATE_LIMIT_BODY_BYTES
                ) {
                  const chunk = Buffer.isBuffer(_chunk) ? _chunk : Buffer.from(String(_chunk));
                  const remaining = MAX_PASSTHROUGH_RATE_LIMIT_BODY_BYTES - rateLimitBodyBytes;
                  const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
                  rateLimitBodyChunks.push(captured);
                  rateLimitBodyBytes += captured.length;
                }
                if (!logged) {
                  const elapsed = Date.now() - startTime;
                  if (!isStream)
                    log.info(
                      'ok ' + method + ' ' + logPath + '  -> ' + code + ' (' + elapsed + 'ms)'
                    );
                  logged = true;
                }
              });

              proxyRes.on('end', function () {
                // A timeout or socket error may already have terminated this request
                // while the upstream kept flushing bytes. The first observer owns the
                // record, so a late 'end' must not overwrite a failure with 200.
                if (!terminalState.markComplete()) return;
                if (isStream)
                  log.info(
                    'ok ' +
                      method +
                      ' ' +
                      urlPath +
                      '  -> ' +
                      code +
                      ' (streaming, ' +
                      (Date.now() - startTime) +
                      'ms)'
                  );
                const cooldownMeta =
                  code >= 400
                    ? applyPassthroughRateLimitCooldown({
                        statusCode: code,
                        headers: proxyRes.headers,
                        responseBody:
                          shouldCaptureRateLimitBody && rateLimitBodyChunks.length > 0
                            ? Buffer.concat(rateLimitBodyChunks).toString('utf8')
                            : '',
                        prepared: currentPrepared,
                        parseRetryAfterHeaderSeconds,
                        setUpstreamCooldown,
                      })
                    : null;
                logRequestEnd(method, logPath, startTime, code, {
                  type: isStream ? 'openai_stream' : 'openai',
                  ...(cooldownMeta
                    ? {
                        targetModel: cooldownMeta.targetModel,
                        retryAfterSeconds: cooldownMeta.retryAfterSeconds,
                        cooldownSource: cooldownMeta.source,
                      }
                    : {}),
                });

                if (code >= 400) {
                  const requestId =
                    proxyRes.headers['x-request-id'] ||
                    proxyRes.headers['request-id'] ||
                    proxyRes.headers['anthropic-request-id'] ||
                    '-';
                  const retryAfter = proxyRes.headers['retry-after'] || '-';
                  const profileId = currentPrepared.profile?.id || '-';
                  log.warn(
                    '!! upstream error ' +
                      method +
                      ' -> ' +
                      code +
                      ' profile=' +
                      profileId +
                      ' request-id=' +
                      requestId +
                      ' retry-after=' +
                      retryAfter
                  );
                  logProxyEvent('upstream_error', {
                    method,
                    code,
                    profileId,
                    ...(cooldownMeta
                      ? {
                          targetModel: cooldownMeta.targetModel,
                          retryAfterSeconds: cooldownMeta.retryAfterSeconds,
                          cooldownSource: cooldownMeta.source,
                        }
                      : {}),
                    requestId,
                    retryAfter: cooldownMeta ? String(cooldownMeta.retryAfterSeconds) : retryAfter,
                  });
                }
              });

              const streamGuard = guardUpstreamStream(proxyRes, {
                clientRes,
                label: 'Upstream',
                logType: isStream ? 'openai_stream_aborted' : 'openai_response_aborted',
                method,
                upstreamPath,
                startTime,
                stream: isStream || clientWantsEventStream,
                reportFailure: (detail) =>
                  settleUpstreamFailure({
                    failureKind: 'upstream_stream_aborted',
                    type: detail.logType,
                    errorType: detail.errorType,
                    error: detail.message,
                    extra: {
                      reason: detail.reason,
                      code: detail.code,
                      ...(detail.diagnostics || {}),
                    },
                  }),
              });
              proxyRes.on('end', () => streamGuard.markComplete());
              // Upstreams commonly send response.completed and then hold the socket
              // open; finish on the terminal frame instead of waiting for close.
              const terminalWatcher = attachTerminalFrameCompletion({
                proxyRes,
                isStream: isStream || clientWantsEventStream,
                onComplete: () => {
                  if (!terminalState.markComplete()) return;
                  streamGuard.markComplete();
                  if (!clientRes.writableEnded) {
                    try {
                      clientRes.end();
                    } catch (err) {}
                  }
                  logRequestEnd(method, logPath, startTime, code, {
                    type: 'openai_stream_terminal',
                  });
                  try {
                    if (typeof proxyRes.unpipe === 'function') proxyRes.unpipe(clientRes);
                    if (typeof proxyRes.destroy === 'function') proxyRes.destroy();
                  } catch (err) {}
                },
              });
              proxyRes.pipe(clientRes);
              if (terminalWatcher) {
                // Registered after pipe() so the terminal frame is forwarded to the
                // client before the response is closed. This listener must not run
                // first, or the frame carrying provider usage would be dropped.
                proxyRes.on('data', (chunk) => terminalWatcher.push(chunk));
              }
            }
          );
          downstreamCancellation.setActive(proxyReq);
          const connectionObserver = observeUpstreamRequestConnection(proxyReq);

          proxyReq.on('timeout', function () {
            if (downstreamCancellation.isCancelled()) return;
            // This timer covers the whole request lifetime, not just the wait for
            // response headers. If it fires before any response callback ran there is
            // no upstream status to report; without this flag the completion handlers
            // below would log the timeout as a successful 200 (code stayed undefined).
            upstreamTimedOut = true;
            const recovery = resolveUpstreamRecovery({
              kind: 'error',
              attempt,
              maxRetries: MAX_RETRIES,
              prepared: currentPrepared,
              profiles:
                isCompactionRequest || hasCodexCompactionState(currentPrepared)
                  ? []
                  : getProfiles(loadConfig()) || [],
              method,
              headers: clientReq.headers,
              responseStarted: clientRes.headersSent,
              allowPostFailover: !clientRes.headersSent,
            });
            if (recovery.type === 'failover') {
              safeLog.warn(
                `[Failover] Upstream timed out, falling back to backup profile: ${recovery.profile.id}`
              );
              proxyReq.destroy();
              doForward({ ...currentPrepared, profile: recovery.profile }, 2);
              return;
            }
            if (recovery.type === 'retry') {
              safeLog.warn(
                `[Retry] Upstream timeout, retrying in ${Math.round(recovery.delayMs)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
              );
              proxyReq.destroy();
              setTimeout(() => doForward(currentPrepared, attempt + 1), recovery.delayMs);
              return;
            }
            // destroy(err) re-enters the 'error' handler below, which owns the single
            // terminal record. The message is kept so operators keep seeing the real
            // cause instead of a generic socket error.
            proxyReq.destroy(new Error('Gateway Timeout (Upstream request timed out)'));
          });

          proxyReq.on('error', function (err) {
            if (downstreamCancellation.isCancelled()) return;
            const failureDiagnostics = collectUpstreamRequestFailureDiagnostics({
              proxyReq,
              clientRes,
              upstreamResponseSeen,
              upstreamResponseStatusCode,
              connectionSnapshot: connectionObserver.snapshot(),
              error: err,
              requestBodyByteLength: currentPrepared.buffer && currentPrepared.buffer.length,
              contentLength: outgoingHeaders['content-length'] ?? outgoingHeaders['Content-Length'],
            });
            const safeFailureCode = failureDiagnostics.upstreamErrorCode || 'UPSTREAM_ERROR';
            // 证书不匹配/连不上这类失败的根因通常是该域名的 DNS 答案不可信。
            // 丢弃缓存条目，让紧随其后的重试必须重新解析，而不是复用同一个地址。
            // 失效动作挂在 agent 上：配置热更新会整体替换 agent 与其解析器缓存，
            // 从当前 agent 取用可保证操作的是正在生效的那份缓存。
            const upstreamAgent = transport === https ? globalHttpsAgent : globalHttpAgent;
            if (upstreamAgent && typeof upstreamAgent.invalidateUpstreamAddress === 'function') {
              try {
                upstreamAgent.invalidateUpstreamAddress(target.hostname, err && err.code);
              } catch (_error) {}
            }
            const recovery = resolveUpstreamRecovery({
              kind: 'error',
              attempt,
              maxRetries: MAX_RETRIES,
              prepared: currentPrepared,
              profiles:
                isCompactionRequest || hasCodexCompactionState(currentPrepared)
                  ? []
                  : getProfiles(loadConfig()) || [],
              method,
              headers: clientReq.headers,
              errorCode: err && err.code,
              preTransmissionContext: readPreTransmissionContext(proxyReq),
              responseStarted: clientRes.headersSent,
              allowPostFailover: !clientRes.headersSent,
            });
            if (recovery.type === 'failover') {
              safeLog.warn(
                `[Failover] Upstream request failed (${safeFailureCode}), falling back to backup profile: ${recovery.profile.id}`
              );
              doForward({ ...currentPrepared, profile: recovery.profile }, 2);
              return;
            }
            if (recovery.type === 'retry') {
              safeLog.warn(
                `[Retry] Upstream error (${safeFailureCode}), retrying in ${Math.round(recovery.delayMs)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
              );
              setTimeout(() => doForward(currentPrepared, attempt + 1), recovery.delayMs);
              return;
            }

            log.error('xx ' + method + ' ' + logPath + '  ' + safeFailureCode);
            const firstFailureObservation = !terminalState.isSettled();
            logProxyEvent('proxy_error', {
              method,
              path: logPath,
              error: 'Upstream request failed',
              code: safeFailureCode,
              ...failureDiagnostics,
              // A socket error can also arrive after the response already completed
              // (keep-alive teardown); flagging it keeps a late observer from being read
              // as a second, contradictory outcome for the same reqId.
              ...(firstFailureObservation ? {} : { late: true }),
            });
            if (!firstFailureObservation) return;
            // Register the outcome before touching the client response. The audit record
            // is written from inside clientRes.end(), so recording afterwards would
            // leave the audit log reporting the client-visible 200 for a request whose
            // events-log entry is a 502.
            settleUpstreamFailure({
              failureKind: upstreamTimedOut ? 'upstream_timeout' : 'upstream_error',
              type: 'proxy_error',
              errorType: 'proxy_error',
              // Must match what the client actually saw (502 in both branches below);
              // failureKind carries the timeout/socket distinction the old log lost.
              statusCode: 502,
              error: 'Upstream request failed',
              extra: { code: safeFailureCode, ...failureDiagnostics },
            });
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, {
                'Content-Type': 'application/json; charset=utf-8',
                'access-control-allow-origin': '*',
              });
              clientRes.end(
                JSON.stringify({
                  error: { message: 'Proxy error: ' + safeFailureCode, type: 'proxy_error' },
                })
              );
            } else {
              // Headers (and possibly a streaming status 200) already reached the
              // client, so the status cannot be corrected. End the body with an
              // explicit error event instead of leaving the client waiting forever.
              terminateClientAfterUpstreamFailure(clientRes, {
                stream: clientWantsEventStream || clientAcceptsEventStream(clientRes),
                payload: {
                  type: 'error',
                  error: { type: 'proxy_error', message: 'Proxy error: ' + safeFailureCode },
                },
              });
            }
          });

          proxyReq.end(currentPrepared.buffer);
        }

        applyCliSessionModelOverride(initialPrepared, {
          cliSession,
          requestBuffer,
          requestEncoding: clientReq.headers['content-encoding'],
          resolveRoute,
          modelRoutes: MODEL_ROUTES,
          profiles: PROFILES,
          activeProfile: ACTIVE_PROFILE,
        });

        resolveOfficialCredentials(initialPrepared, clientReq.headers)
          .then(async function (prepared) {
            if (
              isClaudeMessagesPath(clientPath) &&
              prepared.buffer &&
              !clientReq.headers['content-encoding']
            ) {
              try {
                const parsed = JSON.parse(prepared.buffer.toString('utf8'));
                const augmented = await mcpHub.augmentRequestTools(parsed);
                prepared.buffer = Buffer.from(JSON.stringify(augmented));
              } catch (e) {}
            }
            doForward(prepared, 1);
          })
          .catch(function (err) {
            const credentialFailure = antigravityCredentialFailure(err);
            if (credentialFailure) {
              sendJsonError(clientRes, 503, { error: credentialFailure });
              logRequestEnd(method, logPath, startTime, 503, {
                type: 'google_official_auth_unavailable',
                code: credentialFailure.code,
              });
              return;
            }
            log.error('[auth] Failed to resolve credentials:', err.message);
            doForward(initialPrepared, 1);
          });
      },
      onAborted() {
        clientRes.destroy();
      },
    });
  }

  return handleRequestInner;
}

module.exports = {
  createCoreRequestHandler,
  _test: {
    applyPassthroughRateLimitCooldown,
    passthroughCooldownTargetModel,
    sendPassthroughLocalCooldown,
  },
};
