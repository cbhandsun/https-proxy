'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createConversionStreamOutput } = require('../conversion-stream-output');

const { sendConversionError } = require('./route-error-utils');
const {
  convertedRateLimitCooldown,
  sendConvertedLocalCooldown,
  shouldApplyConvertedRateLimitCooldown,
} = require('./converted-rate-limit');
const {
  createConvertedChatRequest,
  prepareConvertedChatBody,
} = require('./converted-chat-request');
const { createChatCompletionCollector } = require('../forced-stream-collector');
const { withUpstreamTiming } = require('../request-timing');
const { createUpstreamStreamGuard, safeErrorCode } = require('./upstream-stream-guard');
const { StringDecoder } = require('node:string_decoder');
const { rejectContextOverflow } = require('../context-budget-manager');
const { readWorkBuddyAuthInfo } = require('../workbuddy-official');
const {
  isWorkBuddyUnauthorizedResponse,
  refreshWorkBuddyOfficialAuth,
} = require('../workbuddy-auth-refresh');
const { createWorkBuddyWbipcClient } = require('../workbuddy-wbipc-client');
const { isWorkBuddyHostUnavailable } = require('../workbuddy-host-recovery');
const { normalizeWorkBuddyChatSse } = require('../workbuddy-chat-stream-contract');
const { WBIPC_MAX_FRAME_BYTES } = require('../workbuddy-wbipc-frame-reader');
const {
  createWbipcCancellation,
  streamBufferedChatToResponses,
  safeWbipcStatus,
} = require('./workbuddy-responses-flow');
const { isWorkBuddyWbipcPayloadTooLarge } = require('../workbuddy-wbipc-payload');
const { createContextCapacityController } = require('../context-capacity-controller');
const { createContextArtifactStore } = require('../context-artifact-store');
const { createContextCompactionCoordinator } = require('../context-compaction-coordinator');
const { safeCompactionFailureReason } = require('../context-compaction-failure');
const { createContextCompactionBackoff } = require('../context-compaction-backoff');
const { createContextSummaryCheckpoints } = require('../context-summary-checkpoints');
const { createCompactionTiming, measureCompactionTiming } = require('../context-compaction-timing');
const { createContextCompactionEnvelopeStore } = require('../context-compaction-envelope');
const { prepareWorkBuddyCompactionInput } = require('../workbuddy-compaction-bridge');
const { createLocalCompactionEvidenceReader } = require('../context-compaction-evidence');
const {
  renewLocalCompactionReplay,
  compactionReplayFailure,
} = require('../context-compaction-lifecycle');
const { handleWorkBuddyCompactionTrigger } = require('./workbuddy-compaction-flow');
const { bindLocalCompactionMessages } = require('../context-local-compaction-provenance');
const {
  createContextToolCatalogStore,
  TOOL_DISCOVERY_CAPABILITY,
  TOOL_DISCOVERY_HEADER,
} = require('../context-tool-catalog');
const { planWorkBuddyToolDiscovery } = require('../workbuddy-tool-discovery');
const {
  appendContextArtifactTool,
  CONTEXT_ARTIFACT_TOOL_NAME,
} = require('../context-artifact-tool');
const { createWorkBuddyContextPreparation } = require('../workbuddy-context-preparation');
const {
  MAX_HISTORY_BYTES,
  createContextHistoryBranch,
  isContextHistoryFailure,
} = require('../context-history-branch');
const {
  createContextRecoveryGuard,
  planWorkBuddyContextRecovery,
} = require('../workbuddy-context-recovery');
const { createWorkBuddyContextOutcomeRecorder } = require('../context-outcome-metrics');
const { createWorkBuddyMixedToolPhase } = require('../workbuddy-mixed-tool-phase');
const { isWorkBuddyTarget } = require('../workbuddy-request-contract');
const { usesNativeContextPlanning } = require('../context-recovery-policy');
const { nativeWorkBuddyResponseAllowed } = require('../workbuddy-native-context');
const {
  normalizeWorkBuddyToolHistory,
  workBuddyToolHistoryError,
} = require('../workbuddy-tool-history');
const { inspectWorkBuddyToolHistoryConversion } = require('../workbuddy-tool-history-diagnostics');
const {
  WORKBUDDY_REASONING_EFFORTS,
  normalizeWorkBuddyResponsesRequest,
  workBuddyResponsesOptionDiagnostics,
} = require('../workbuddy-responses-compat');
const {
  DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
  DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES,
  DEFAULT_WORKBUDDY_MIN_CLEANUP_BYTES,
  DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
  selectWorkBuddyTools,
  planWorkBuddyWbipcRequest,
} = require('../workbuddy-context-planner');

function collapseOpenAIChatStreamToResponses(options) {
  const {
    proxyRes,
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    parsed,
    targetModel,
    chatBody,
    maxConversionResponseBytes,
    openAIChatToResponses,
    rememberResponsesFromChatResponse,
    writeJsonResponse,
    sendJsonError,
    logRequestEnd,
  } = options;
  const collector = createChatCompletionCollector(maxConversionResponseBytes);
  let settled = false;

  const fail = (err) => {
    if (settled) return;
    settled = true;
    sendConversionError({
      clientReq,
      clientRes,
      upstreamPath,
      startTime,
      err,
      label: 'OpenAI Chat stream',
      logType: 'openai_chat_stream_to_responses_conversion_error',
      sendJsonError,
      logRequestEnd,
    });
  };

  proxyRes.on('data', (chunk) => {
    if (settled) return;
    try {
      collector.push(chunk);
    } catch (err) {
      if (typeof proxyRes.destroy === 'function') proxyRes.destroy();
      fail(err);
    }
  });
  proxyRes.on('end', () => {
    if (settled) return;
    try {
      const chatPayload = collector.finish();
      const response = openAIChatToResponses(chatPayload, parsed.model || targetModel, parsed);
      rememberResponsesFromChatResponse(response, chatBody, chatPayload);
      writeJsonResponse(clientRes, 200, response);
      settled = true;
      logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
        type: 'responses_to_chat_stream_collapsed',
      });
    } catch (err) {
      fail(err);
    }
  });
  proxyRes.on('error', fail);
  // 'error' does not fire for every truncated stream; 'aborted'/incomplete 'close'
  // otherwise leave the client waiting on a response that will never be written.
  proxyRes.on('aborted', () => fail(new Error('Upstream stream was aborted before completion')));
  proxyRes.on('close', () => {
    if (proxyRes.complete === true) return;
    fail(new Error('Upstream stream closed before completion'));
  });
}

function createOpenAIResponsesToChatHandler(ctx, routeHelpers) {
  const {
    https,
    http,
    CORS_HEADERS,
    sendJsonError,
    logRequestEnd: baseLogRequestEnd,
    logProxyEvent,
    writeJsonResponse,
    parseProxyBody,
    upstreamRequestOptions,
    onProxyTimeout,
    onProxyError,
    parseJsonOrSseJson,
    collectBoundedResponse,
    createChatToResponsesBridge,
    responsesToChatWithHistory,
    rememberResponsesFromChatResponse,
    rememberResponsesFromBridge,
    rejectUnsupportedResponsesConversion,
    openAIChatToResponses,
    processOpenAIChatSseChunkToResponses,
    readWorkBuddyAuthInfo: readWorkBuddyAuthInfoOverride = readWorkBuddyAuthInfo,
    refreshWorkBuddyOfficialAuth:
      refreshWorkBuddyOfficialAuthOverride = refreshWorkBuddyOfficialAuth,
    workBuddyWbipcClient: workBuddyWbipcClientOverride,
    contextCapacityController: contextCapacityControllerOverride,
    contextArtifactStore: contextArtifactStoreOverride,
    contextCompactionCoordinator: contextCompactionCoordinatorOverride,
    contextCompactionFailureBackoff: contextCompactionFailureBackoffOverride,
    contextSummaryCheckpoints: contextSummaryCheckpointsOverride,
    contextCompactionEnvelopeStore: contextCompactionEnvelopeStoreOverride,
    contextToolCatalogStore: contextToolCatalogStoreOverride,
    protocolOptions = {},
    maxConversionResponseBytes = 16 * 1024 * 1024,
    workbuddyOperationalInputTokens = protocolOptions.workbuddyOperationalInputTokens ||
      DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
    workbuddyPreflightBodyBytes = protocolOptions.workbuddyPreflightBodyBytes ||
      DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES,
    workbuddyTargetBodyBytes = protocolOptions.workbuddyTargetBodyBytes ||
      DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
    workbuddyMinCleanupBytes = protocolOptions.workbuddyMinCleanupBytes ||
      DEFAULT_WORKBUDDY_MIN_CLEANUP_BYTES,
    workbuddyWbipcRetryBodyBytes = 256 * 1024,
    workbuddyMaxSelectedTools = protocolOptions.workbuddyMaxSelectedTools,
  } = ctx;
  const { boundedResponseContext, handleConvertedJsonResponse, proxyErrorContext } = routeHelpers;
  const workBuddyWbipcClient =
    workBuddyWbipcClientOverride ||
    createWorkBuddyWbipcClient({
      timeoutMs: protocolOptions.workbuddyWbipcTimeoutMs,
      clientVersion: protocolOptions.workbuddyWbipcClientVersion,
    });
  const contextCapacityController =
    contextCapacityControllerOverride || createContextCapacityController();
  const contextArtifactStore =
    contextArtifactStoreOverride ||
    createContextArtifactStore({ maxArtifactBytes: 2 * 1024 * 1024 });
  const contextCompactionCoordinator =
    contextCompactionCoordinatorOverride || createContextCompactionCoordinator();
  const contextCompactionEnvelopeStore =
    contextCompactionEnvelopeStoreOverride ||
    createContextCompactionEnvelopeStore({ renewable: true });
  const contextToolCatalogStore =
    contextToolCatalogStoreOverride || createContextToolCatalogStore();
  const contextPreparation = createWorkBuddyContextPreparation();
  const compactionFailureBackoff =
    contextCompactionFailureBackoffOverride || createContextCompactionBackoff();
  const summaryCheckpoints = contextSummaryCheckpointsOverride || createContextSummaryCheckpoints();

  return function handleOpenAIResponsesToOpenAIChat(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    let contextOutcome;
    const compactionTiming = createCompactionTiming();
    const logRequestEnd = (...args) => {
      contextOutcome?.finish(args[3], args[4]?.errorCode || args[4]?.errorType);
      baseLogRequestEnd(...args);
    };
    const sourceParsed = parseProxyBody(clientRes, prepared.buffer);
    if (!sourceParsed) return;
    const rejectToolHistoryError = (error, phase, messages) => {
      const failure = workBuddyToolHistoryError(error);
      if (!failure) return false;
      sendJsonError(clientRes, 400, failure.payload);
      logRequestEnd(clientReq.method, upstreamPath, startTime, 400, {
        type: 'workbuddy_tool_history_rejected',
        errorCode: failure.code,
        reason: failure.reason,
        phase,
        historyDiagnostics: failure.diagnostics,
        ...(phase === 'converted_history'
          ? {
              conversionDiagnostics: inspectWorkBuddyToolHistoryConversion(
                parsed.input,
                messages,
                failure.diagnostics
              ),
              usesPreviousResponseId:
                typeof parsed.previous_response_id === 'string' &&
                parsed.previous_response_id.length > 0,
            }
          : {}),
      });
      return true;
    };
    const isWorkBuddy = isWorkBuddyTarget(prepared);
    const contextPolicyOptions = { ...protocolOptions };
    const nativeContext = usesNativeContextPlanning(contextPolicyOptions);
    const encryptedWorkBuddy =
      isWorkBuddy && !apiKey && prepared.workbuddyAuth?.accessTokenEncrypted;
    const compactionBinding = encryptedWorkBuddy
      ? {
          owner: prepared.profile?.id,
          provider: 'workbuddy-wbipc',
          model: prepared.rewriteTo !== '-' ? prepared.rewriteTo : sourceParsed.model,
          endpoint: `${target.protocol || 'https:'}//${target.hostname || target.host || 'workbuddy-host'}:${target.port || ''}${target.path || ''}`,
        }
      : null;
    let compactionInput = { body: sourceParsed, trigger: false, summaryTexts: [] };
    try {
      if (encryptedWorkBuddy)
        compactionInput = prepareWorkBuddyCompactionInput(
          sourceParsed,
          compactionBinding,
          contextCompactionEnvelopeStore
        );
    } catch (error) {
      const { code, status, payload } = compactionReplayFailure(error);
      sendJsonError(clientRes, status, payload);
      logRequestEnd(clientReq.method, upstreamPath, startTime, status, {
        type: 'workbuddy_compaction_input_rejected',
        errorCode: code,
      });
      return;
    }
    if (nativeContext && compactionInput.evidenceReceipts?.length) {
      sendJsonError(clientRes, 409, {
        error: {
          type: 'invalid_request_error',
          code: 'context_recovery_disabled',
          message:
            'This local compaction state requires context recovery. Resend the original history or explicitly enable recovery for this target.',
        },
      });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 409, {
        errorCode: 'context_recovery_disabled',
      });
      return;
    }
    const parsed = isWorkBuddy
      ? normalizeWorkBuddyResponsesRequest(compactionInput.body)
      : compactionInput.body;
    if (isWorkBuddy && typeof logProxyEvent === 'function') {
      logProxyEvent(
        'workbuddy_responses_compat',
        workBuddyResponsesOptionDiagnostics(sourceParsed, parsed)
      );
    }
    const conversionOptions = isWorkBuddy
      ? { reasoningEfforts: WORKBUDDY_REASONING_EFFORTS }
      : undefined;
    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    if (rejectUnsupportedResponsesConversion(clientRes, parsed, undefined, conversionOptions))
      return;
    if (
      sendConvertedLocalCooldown(
        clientReq,
        clientRes,
        prepared,
        upstreamPath,
        startTime,
        targetModel,
        ctx
      )
    )
      return;
    let chatBody = measureCompactionTiming(compactionTiming, 'conversion', () =>
      responsesToChatWithHistory(clientRes, parsed, targetModel, conversionOptions)
    );
    if (!chatBody) return;
    if (isWorkBuddy && !compactionInput.trigger) {
      try {
        const history = normalizeWorkBuddyToolHistory(chatBody.messages);
        if (history.changed) {
          chatBody = { ...chatBody, messages: history.messages };
          if (typeof logProxyEvent === 'function')
            logProxyEvent('workbuddy_tool_history_repaired', history.diagnostics);
        }
      } catch (error) {
        if (!rejectToolHistoryError(error, 'converted_history', chatBody.messages)) throw error;
        return;
      }
    }
    try {
      if (
        !nativeContext &&
        compactionInput.tokens?.length &&
        !clientReq.aborted &&
        !clientRes.destroyed
      )
        renewLocalCompactionReplay(
          compactionInput.tokens,
          compactionBinding,
          contextCompactionEnvelopeStore,
          contextArtifactStore
        );
    } catch (error) {
      const { code, status, payload } = compactionReplayFailure(error);
      sendJsonError(clientRes, status, payload);
      logRequestEnd(clientReq.method, upstreamPath, startTime, status, {
        type: 'workbuddy_compaction_input_rejected',
        errorCode: code,
      });
      return;
    }
    bindLocalCompactionMessages(chatBody.messages, compactionInput.summaryTexts);
    if (compactionInput.trigger) {
      handleWorkBuddyCompactionTrigger({
        body: parsed,
        standalone: prepared.workbuddyStandaloneCompaction === true,
        authenticatedSummaryTexts: compactionInput.summaryTexts,
        archiveHistoricalUsers: !nativeContext,
        captureEvidence: !nativeContext,
        prepareWindow: (input) =>
          prepareConvertedChatBody(
            { ...prepared, activePromptPreset: null, promptPreset: null },
            ctx.openAIResponsesToChat(
              { model: targetModel, input, store: false, truncation: 'disabled' },
              conversionOptions
            ),
            targetModel,
            { protocolOptions, deferContextPlanning: true }
          ),
        callIdDigests: compactionInput.callIdDigests,
        binding: compactionBinding,
        store: contextCompactionEnvelopeStore,
        coordinator: contextCompactionCoordinator,
        artifactStore: contextArtifactStore,
        evidenceReceipts: compactionInput.evidenceReceipts,
        maxRequestBytes: workbuddyTargetBodyBytes,
        maxInputTokens: workbuddyOperationalInputTokens,
        maxResponseBytes: maxConversionResponseBytes,
        prepareSummary: (body) =>
          prepareConvertedChatBody(
            { ...prepared, activePromptPreset: null, promptPreset: null },
            body,
            targetModel,
            { protocolOptions, deferContextPlanning: true }
          ),
        requestSummary: (body, signal) =>
          workBuddyWbipcClient.request(
            {
              method: 'POST',
              path: `${target.path || ''}/chat/completions`,
              headers: {
                'content-type': 'application/json',
                accept: body.stream ? 'text/event-stream' : 'application/json',
              },
              body: Buffer.from(JSON.stringify(body)),
            },
            { signal }
          ),
        clientReq,
        clientRes,
        sendJsonError,
        writeJsonResponse,
        logRequestEnd,
        upstreamPath,
        startTime,
        CORS_HEADERS,
      });
      return;
    }
    const wbipcContext =
      isWorkBuddy && !apiKey && prepared.workbuddyAuth?.accessTokenEncrypted
        ? {
            owner: String(prepared.profile?.id || 'workbuddy').slice(0, 256),
            scope: 'hcs_' + randomUUID().replace(/-/g, ''),
          }
        : null;
    let toolCatalog;
    let clientWantsStream;
    let requestBody;
    try {
      if (wbipcContext && !nativeContext) {
        clientRes.setHeader?.('x-hpm-context-capabilities', TOOL_DISCOVERY_CAPABILITY);
        const capability =
          protocolOptions.workbuddyToolDiscoveryPolicy === 'disabled'
            ? null
            : clientReq.headers?.[TOOL_DISCOVERY_HEADER];
        const negotiation = contextToolCatalogStore.open(chatBody, {
          ...wbipcContext,
          capability,
          initialNames:
            capability === TOOL_DISCOVERY_CAPABILITY
              ? (
                  selectWorkBuddyTools(chatBody.tools, chatBody.messages, {
                    maxSelectedTools: 5,
                    requiredToolName:
                      chatBody.tool_choice?.function?.name || chatBody.tool_choice?.name,
                  }).tools || []
                )
                  .map((tool) => tool.function?.name)
                  .filter((name) => typeof name === 'string')
              : [],
        });
        if (negotiation.applied) {
          chatBody = negotiation.body;
          toolCatalog = negotiation.catalog;
        }
        if (typeof logProxyEvent === 'function')
          logProxyEvent('workbuddy_tool_discovery_negotiation', {
            applied: negotiation.applied,
            // Only allowlisted reasons created by the catalog implementation.
            reason: negotiation.reason,
            catalogToolCount: negotiation.originalToolCount || 0,
            activeToolCount: toolCatalog?.stats().loadedTools || 0,
          });
      }
      clientWantsStream = chatBody.stream === true;
      if (shouldApplyConvertedRateLimitCooldown(prepared)) chatBody.stream = true;
      measureCompactionTiming(compactionTiming, 'conversion', () =>
        prepareConvertedChatBody(prepared, chatBody, targetModel, {
          protocolOptions,
          deferContextPlanning: Boolean(wbipcContext),
        })
      );
      // Provider preparation may clone messages. Bind only its final normalized
      // objects; subsequent history clones carry this non-wire capability.
      bindLocalCompactionMessages(chatBody.messages, compactionInput.summaryTexts);
      const preparedBudget = chatBody.__hpmDiagnostics?.contextBudget;
      if (
        (nativeContext ||
          !wbipcContext ||
          (preparedBudget?.enabled && preparedBudget.inputBudgetTokens === 0)) &&
        rejectContextOverflow(clientRes, chatBody, sendJsonError)
      ) {
        toolCatalog?.close();
        if (wbipcContext) {
          contextOutcome = createWorkBuddyContextOutcomeRecorder(logProxyEvent, null);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 400, {
            errorCode: 'context_length_exceeded',
          });
        }
        return;
      }
      if (isWorkBuddy) normalizeWorkBuddyToolHistory(chatBody.messages, { repair: false });
      requestBody = Buffer.from(JSON.stringify(chatBody));
    } catch (err) {
      toolCatalog?.close();
      if (rejectToolHistoryError(err, 'provider_preparation')) return;
      if (wbipcContext) contextOutcome = createWorkBuddyContextOutcomeRecorder(logProxyEvent, null);
      sendConversionError({
        clientReq,
        clientRes,
        upstreamPath,
        startTime,
        err,
        label: 'WorkBuddy context preparation',
        logType: 'workbuddy_context_preparation_error',
        sendJsonError,
        logRequestEnd,
      });
      return;
    }
    function sendEncryptedCredentialError(status, wbipcStatus) {
      const unavailable = isWorkBuddyHostUnavailable(wbipcStatus ?? status);
      const httpStatus = unavailable ? 503 : 401;
      const code = unavailable
        ? 'workbuddy_host_unavailable'
        : 'workbuddy_encrypted_credentials_unsupported';
      sendJsonError(clientRes, httpStatus, {
        error: {
          type: unavailable ? 'service_unavailable' : 'authentication_error',
          code,
          message: unavailable
            ? 'WorkBuddy local request bridge could not be restored automatically. Open WorkBuddy, ensure it is signed in, and retry.'
            : 'WorkBuddy official credentials are encrypted by the current WorkBuddy client and cannot be read directly by this adapter. The local WorkBuddy request bridge was not available; open WorkBuddy, ensure it is signed in, and retry.',
          wbipc_status: safeWbipcStatus(wbipcStatus ?? status),
        },
      });
      logRequestEnd(clientReq.method, upstreamPath, startTime, httpStatus, {
        type: 'responses_to_chat_error',
        errorType: code,
        wbipcStatus: safeWbipcStatus(wbipcStatus ?? status),
      });
    }

    function sendWbipcPayloadTooLarge(diagnostics) {
      const retryAfterMs =
        diagnostics?.taskStateBackoffApplied === true &&
        Number.isSafeInteger(diagnostics.taskStateRetryAfterMs) &&
        diagnostics.taskStateRetryAfterMs > 0 &&
        diagnostics.taskStateRetryAfterMs <= 30000
          ? diagnostics.taskStateRetryAfterMs
          : undefined;
      if (retryAfterMs !== undefined)
        clientRes.setHeader?.('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      sendJsonError(clientRes, 413, {
        error: {
          type: 'invalid_request_error',
          code: 'workbuddy_request_too_large',
          message: diagnostics?.nativeContextPreserved
            ? 'The complete WorkBuddy request exceeds the operational capacity. Compact or shorten the input and retry. All original inputs were retained; automatic compaction and recovery are disabled.'
            : diagnostics?.truncationDisabled
              ? 'The WorkBuddy request exceeds the safe operational context with truncation disabled. Shorten the input or enable automatic truncation.'
              : diagnostics?.reason === 'immutable_context_too_large'
                ? 'The immutable system and developer context exceeds the safe WorkBuddy request capacity. Shorten the fixed instructions; the proxy will not rewrite them.'
                : diagnostics?.taskStateBackoffApplied === true
                  ? 'An identical compaction attempt recently failed and is temporarily backed off. All original inputs were retained. Wait for the retry cooldown before continuing; a new conversation is not required merely because compaction failed.'
                  : (diagnostics?.taskStateSummaryAttempted === true ||
                        diagnostics?.taskStateBackoffApplied === true) &&
                      diagnostics?.userArchiveStatus === 'selected'
                    ? 'Recoverable historical-user archival could not be completed safely, so the request is still too large. All original inputs were retained. This is a compaction failure, not proof that the fixed instructions and current input cannot fit; inspect the task-state failure diagnostics before discarding the conversation.'
                    : diagnostics?.reason === 'required_context_too_large'
                      ? 'The retained instructions and user inputs exceed the current WorkBuddy operational request budget. Tool-history compaction alone cannot make them fit, and safe historical-user archival could not reduce them enough. All original inputs were retained. This budget is not a confirmed model context limit; inspect capacity and archival diagnostics, or continue in a fresh conversation with the necessary requirements.'
                      : 'The WorkBuddy request still exceeds the safe operational context after tool selection and conversation compaction. Start a fresh conversation or reread the remaining large input in smaller slices.',
          wbipc_status: 'E_PAYLOAD_TOO_LARGE',
          context_reason: diagnostics?.reason,
          task_state_failure_reason: safeCompactionFailureReason(
            diagnostics?.taskStateFailureReason
          ),
          retry_after_ms: retryAfterMs,
          estimated_input_tokens: diagnostics && diagnostics.finalEstimatedTokens,
          body_bytes: diagnostics && diagnostics.finalBodyBytes,
          attempted_body_bytes: diagnostics?.attemptedFinalBodyBytes,
          attempted_input_tokens: diagnostics?.attemptedFinalEstimatedTokens,
          required_context_bytes: diagnostics?.requiredContextMessageBytes,
          required_context_input_tokens: diagnostics?.requiredContextEstimatedTokens,
        },
      });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 413, {
        type: 'responses_to_chat_error',
        errorType: 'workbuddy_request_too_large',
        wbipcStatus: 'E_PAYLOAD_TOO_LARGE',
        contextReason: diagnostics && diagnostics.reason,
        taskStateFailureReason: safeCompactionFailureReason(diagnostics?.taskStateFailureReason),
        bodyBytes: diagnostics && diagnostics.finalBodyBytes,
        estimatedTokens: diagnostics && diagnostics.finalEstimatedTokens,
        droppedMessages: diagnostics && diagnostics.droppedMessages,
        continuationSummaryAdded: diagnostics && diagnostics.continuationSummaryAdded,
        foldedMessages: diagnostics && diagnostics.foldedMessages,
        foldedProtectedMessages: diagnostics && diagnostics.foldedProtectedMessages,
        foldedToolOutputs: diagnostics && diagnostics.foldedToolOutputs,
      });
    }

    function convertBufferedWbipcResponse(responseBody, statusCode, responseHeaders) {
      const proxyRes = { statusCode, headers: responseHeaders || {} };
      if (
        !Number.isInteger(statusCode) ||
        statusCode < 200 ||
        statusCode > 599 ||
        typeof responseBody !== 'string' ||
        Buffer.byteLength(responseBody) > WBIPC_MAX_FRAME_BYTES
      ) {
        sendConversionError({
          clientReq,
          clientRes,
          upstreamPath,
          startTime,
          err: new TypeError('Invalid WorkBuddy response'),
          label: 'WorkBuddy WBIPC response',
          logType: 'workbuddy_wbipc_response_conversion_error',
          sendJsonError,
          logRequestEnd,
        });
        return;
      }
      if (chatBody.stream && statusCode >= 200 && statusCode < 300) {
        try {
          responseBody = normalizeWorkBuddyChatSse(responseBody);
        } catch (err) {
          sendConversionError({
            clientReq,
            clientRes,
            upstreamPath,
            startTime,
            err,
            label: 'WorkBuddy WBIPC Chat stream',
            logType: 'workbuddy_wbipc_chat_stream_to_responses_conversion_error',
            sendJsonError,
            logRequestEnd,
          });
          return;
        }
      }
      if (chatBody.stream && statusCode >= 200 && statusCode < 300 && clientWantsStream) {
        streamBufferedChatToResponses({
          responseBody,
          clientReq,
          clientRes,
          upstreamPath,
          startTime,
          protocolOptions,
          CORS_HEADERS,
          parsed,
          targetModel,
          chatBody,
          createChatToResponsesBridge,
          processOpenAIChatSseChunkToResponses,
          rememberResponsesFromBridge,
          logRequestEnd,
          sendJsonError,
        });
        return;
      }

      handleConvertedJsonResponse({
        logRequestEnd,
        proxyRes,
        clientReq,
        clientRes,
        upstreamPath,
        startTime,
        responseBody,
        upstreamProvider: 'openai',
        upstreamErrorType: 'responses_to_chat_error',
        successType: 'responses_to_chat',
        rateLimitCooldown: convertedRateLimitCooldown(prepared, targetModel),
        conversionLabel: 'OpenAI Responses',
        conversionLogType: 'openai_chat_to_responses_conversion_error',
        convert: (body) => {
          const chatPayload = parseJsonOrSseJson(body);
          const response = openAIChatToResponses(chatPayload, parsed.model || targetModel, parsed);
          rememberResponsesFromChatResponse(response, chatBody, chatPayload);
          return response;
        },
      });
    }

    if (isWorkBuddy && !apiKey && prepared.workbuddyAuth?.accessTokenEncrypted) {
      const artifactOwner = wbipcContext.owner;
      const artifactScope = wbipcContext.scope;
      const replayEvidence = compactionInput.evidenceReceipts || [];
      // Only authenticated cross-request receipts require the compaction owner.
      // Ordinary request-local recovery retains its existing owner/scope contract.
      const artifactReadStore = replayEvidence.length
        ? createLocalCompactionEvidenceReader(
            contextArtifactStore,
            compactionBinding,
            replayEvidence
          )
        : contextArtifactStore;
      if (replayEvidence.length) chatBody.tools = appendContextArtifactTool(chatBody.tools);
      const capacityKey = JSON.stringify([
        artifactOwner,
        String(target.path || '').slice(0, 256),
        String(targetModel || '').slice(0, 128),
        chatBody.stream === true ? 'stream' : 'json',
      ]);
      const learnedTargetBodyBytes = contextCapacityController.targetBytes(
        capacityKey,
        workbuddyTargetBodyBytes
      );
      const plannerOptions = {
        contextPolicyOptions,
        protectedMessages: new Set(
          chatBody.messages.filter(
            (message) =>
              message.role === 'assistant' &&
              typeof message.content === 'string' &&
              compactionInput.summaryTexts.some((text) => message.content.includes(text))
          )
        ),
        operationalInputTokens: chatBody.__hpmDiagnostics?.contextBudget?.enabled
          ? Math.min(
              workbuddyOperationalInputTokens,
              chatBody.__hpmDiagnostics.contextBudget.inputBudgetTokens
            )
          : workbuddyOperationalInputTokens,
        preflightBodyBytes: Math.min(workbuddyPreflightBodyBytes, learnedTargetBodyBytes),
        targetBodyBytes: learnedTargetBodyBytes,
        minimumCleanupBytes: workbuddyMinCleanupBytes,
        maxSelectedTools: workbuddyMaxSelectedTools,
        artifactStore: contextArtifactStore,
        artifactOwner,
        artifactScope,
        artifactReadStore,
        preserveToolSchemas: Boolean(toolCatalog),
        preserveArtifactTool: replayEvidence.length > 0,
        // Authorized local archival keeps complete originals behind authenticated
        // indexes; native providers and their opaque state stay on their own path.
        archiveHistoricalUsers: true,
      };
      let historyBranch;
      let preflightPlan;
      let backgroundCompaction;
      // Install the terminal recorder before attaching disconnect listeners:
      // the client may already be gone, or disconnect during summarization.
      contextOutcome = createWorkBuddyContextOutcomeRecorder(logProxyEvent, null);
      const cancellation = createWbipcCancellation({
        clientReq,
        clientRes,
        onCancel: (code) =>
          logRequestEnd(
            clientReq.method,
            upstreamPath,
            startTime,
            code === 'client_disconnected' ? 499 : 502,
            { type: 'workbuddy_wbipc_request_cancelled', errorCode: code }
          ),
      });
      let effectiveChatBody = chatBody;
      let responseRequestBody = chatBody;
      let preflightRejected = false;
      const recoveryGuard = createContextRecoveryGuard();
      const mixedToolPhase = createWorkBuddyMixedToolPhase({ toolDiscovery: Boolean(toolCatalog) });
      const sendContextRecoveryError = (code) => {
        contextOutcome.finish(502, code);
        sendConversionError({
          clientReq,
          clientRes,
          upstreamPath,
          startTime,
          err: new TypeError('Invalid WorkBuddy context recovery phase'),
          label: 'WorkBuddy context artifact continuation',
          logType: 'workbuddy_context_artifact_continuation_error',
          sendJsonError,
          logRequestEnd,
        });
      };
      const requestViaWbipc = async (
        body,
        { signal = cancellation.signal, learnCapacity = true } = {}
      ) => {
        // Check the actual outgoing window, including compaction/recovery turns.
        // Admission or checkpoint validity alone does not prove tool pairing.
        normalizeWorkBuddyToolHistory(body.messages, { repair: false });
        const buffer = Buffer.from(JSON.stringify(body));
        const requestStarted = performance.now();
        if (learnCapacity) responseRequestBody = body;
        const response = await workBuddyWbipcClient.request(
          {
            method: 'POST',
            path: `${target.path || ''}/chat/completions`,
            headers: {
              'content-type': 'application/json',
              accept: body.stream ? 'text/event-stream' : 'application/json',
            },
            body: buffer,
          },
          { signal }
        );
        if (
          learnCapacity &&
          !signal.aborted &&
          !cancellation.isCanceled() &&
          response?.ok === true &&
          Number.isInteger(response.status) &&
          response.status >= 200 &&
          response.status < 300
        ) {
          contextPreparation.observeMain(capacityKey, performance.now() - requestStarted);
          contextCapacityController.recordSuccess(
            capacityKey,
            buffer.length,
            workbuddyTargetBodyBytes
          );
        }
        return response;
      };
      Promise.resolve()
        .then(async () => {
          if (cancellation.isCanceled()) return null;
          if (!nativeContext)
            historyBranch = createContextHistoryBranch(chatBody, {
              owner: artifactOwner,
              scope: artifactScope,
              // Ingress accepts 64 MiB. The pre-compaction branch must admit that
              // bounded source before the planner applies the smaller host budget.
              maxBytes: MAX_HISTORY_BYTES,
              initialCallIdDigests: compactionInput.callIdDigests,
            });
          plannerOptions.historyBranch = historyBranch;
          plannerOptions.signal = cancellation.signal;
          const preparation = await contextPreparation.prepare(chatBody, plannerOptions, {
            historyBranch,
            policyKey: capacityKey,
            coordinator: contextCompactionCoordinator,
            compactionScope: artifactScope,
            failureBackoff: compactionFailureBackoff,
            summaryCheckpoints,
            compactionRetryBinding: { ...compactionBinding, owner: artifactOwner },
            compactionTiming,
            signal: cancellation.signal,
            // Dedicated task summarization uses the same authorized host, but
            // cannot teach main-request capacity or inherit execution controls.
            requestSummary: (body, { signal }) =>
              requestViaWbipc(body, { signal, learnCapacity: false }),
          });
          preflightPlan = preparation.plan;
          backgroundCompaction = preparation.background;
          if (cancellation.isCanceled()) return null;
          contextOutcome.update({ preflightPlan });
          if (preflightPlan.diagnostics.preflightApplied && typeof logProxyEvent === 'function')
            logProxyEvent('workbuddy_context_plan', preflightPlan.diagnostics);
          if (!preflightPlan.fits) {
            preflightRejected = true;
            if (isContextHistoryFailure(preflightPlan.diagnostics.reason))
              sendContextRecoveryError(preflightPlan.diagnostics.reason);
            else sendWbipcPayloadTooLarge(preflightPlan.diagnostics);
            return null;
          }
          effectiveChatBody = preflightPlan.body;
          const mainRequest = requestViaWbipc(effectiveChatBody);
          backgroundCompaction?.start();
          return mainRequest;
        })
        .then(async (initialResponse) => {
          if (cancellation.isCanceled() || preflightRejected) return;
          let wbipcResponse = initialResponse;
          if (
            initialResponse?.ok === true &&
            Number.isInteger(initialResponse.status) &&
            initialResponse.status >= 200 &&
            initialResponse.status < 300
          ) {
            const completed = backgroundCompaction?.take();
            if (completed && !completed.ok && typeof logProxyEvent === 'function')
              logProxyEvent('workbuddy_context_background', {
                committed: false,
                // This reason comes from the private operation/commit capability,
                // never a provider body or client-supplied marker.
                reason: completed.reason,
              });
            if (completed?.ok) {
              preflightPlan = completed.plan;
              effectiveChatBody = completed.plan.body;
              if (typeof logProxyEvent === 'function')
                logProxyEvent('workbuddy_context_plan', {
                  ...preflightPlan.diagnostics,
                  backgroundAppliedToContinuationHistory: true,
                });
            }
          }
          // No pending candidate may outlive the request's next history writer.
          // An unfinished summary never delays this response or a recovery turn.
          backgroundCompaction?.close();
          let retryPlan = null;
          let retryAttempted = false;
          let retrySucceeded = false;
          let artifactRounds = 0;
          let artifactsResolved = 0;
          let artifactsAttempted = 0;
          let artifactsUnavailable = 0;
          let artifactsBudgetExceeded = 0;
          let artifactsDelivered = 0;
          const updateContextOutcome = () => {
            contextOutcome.update({
              preflightPlan,
              retryPlan,
              retryAttempted,
              retrySucceeded,
              artifactReadRounds: artifactRounds,
              artifactsResolved,
              artifactsAttempted,
              artifactsUnavailable,
              artifactsBudgetExceeded,
              artifactsDelivered,
              finalResponse: wbipcResponse,
            });
          };
          updateContextOutcome();
          if (!nativeContext && isWorkBuddyWbipcPayloadTooLarge(initialResponse)) {
            const rejectedBodyBytes = Buffer.byteLength(JSON.stringify(effectiveChatBody));
            const learned = contextCapacityController.recordRejection(
              capacityKey,
              rejectedBodyBytes
            );
            const retryTargetBodyBytes = contextCapacityController.targetBytes(
              capacityKey,
              workbuddyWbipcRetryBodyBytes
            );
            retryPlan = planWorkBuddyWbipcRequest(effectiveChatBody, {
              ...plannerOptions,
              force: true,
              adaptiveCompaction: true,
              operationalInputTokens: Math.min(plannerOptions.operationalInputTokens, 64 * 1024),
              targetBodyBytes: retryTargetBodyBytes,
            });
            if (!retryPlan.fits && isContextHistoryFailure(retryPlan.diagnostics.reason)) {
              sendContextRecoveryError(retryPlan.diagnostics.reason);
              return;
            }
            if (typeof logProxyEvent === 'function') {
              logProxyEvent('workbuddy_wbipc_payload_fallback', {
                retrying: retryPlan.changed === true && retryPlan.fits === true,
                originalBodyBytes: retryPlan.diagnostics.originalBodyBytes,
                retryBodyBytes: retryPlan.diagnostics.finalBodyBytes,
                originalEstimatedTokens: retryPlan.diagnostics.originalEstimatedTokens,
                retryEstimatedTokens: retryPlan.diagnostics.finalEstimatedTokens,
                droppedMessages: retryPlan.diagnostics.droppedMessages || 0,
                continuationSummaryAdded: retryPlan.diagnostics.continuationSummaryAdded === true,
                foldedMessages: retryPlan.diagnostics.foldedMessages || 0,
                foldedProtectedMessages: retryPlan.diagnostics.foldedProtectedMessages || 0,
                foldedToolOutputs: retryPlan.diagnostics.foldedToolOutputs || 0,
                compactionPasses: retryPlan.diagnostics.compactionPasses || 0,
                finalMessageChars: retryPlan.diagnostics.finalMessageChars || 0,
                finalProtectedMessageChars: retryPlan.diagnostics.finalProtectedMessageChars || 0,
                originalProtectedMessageBytes:
                  retryPlan.diagnostics.originalProtectedMessageBytes || 0,
                retryProtectedMessageBytes: retryPlan.diagnostics.finalProtectedMessageBytes || 0,
                originalToolsBytes: retryPlan.diagnostics.originalToolsBytes || 0,
                retryToolsBytes: retryPlan.diagnostics.finalToolsBytes || 0,
                originalToolCount: retryPlan.diagnostics.originalToolCount || 0,
                selectedToolCount: retryPlan.diagnostics.selectedToolCount || 0,
                learnedSafeBodyBytes: learned?.safeBytes || 0,
                retryTargetBodyBytes,
              });
            }
            if (retryPlan.changed === true && retryPlan.fits === true) {
              retryAttempted = true;
              effectiveChatBody = retryPlan.body;
              updateContextOutcome();
              wbipcResponse = await requestViaWbipc(effectiveChatBody);
              retrySucceeded = !!(
                wbipcResponse?.ok === true &&
                Number.isInteger(wbipcResponse.status) &&
                wbipcResponse.status >= 200 &&
                wbipcResponse.status < 300
              );
              updateContextOutcome();
              if (cancellation.isCanceled()) return;
            }
          }
          while (
            !nativeContext &&
            wbipcResponse?.ok === true &&
            Number.isInteger(wbipcResponse.status) &&
            wbipcResponse.status >= 200 &&
            wbipcResponse.status < 300
          ) {
            const phase = mixedToolPhase.prepare(
              wbipcResponse.body,
              effectiveChatBody,
              WBIPC_MAX_FRAME_BYTES,
              historyBranch,
              responseRequestBody
            );
            if (phase.matched) {
              if (!phase.ok) {
                sendContextRecoveryError(phase.reason);
                return;
              }
              wbipcResponse = { ...wbipcResponse, body: phase.responseBody };
              effectiveChatBody = phase.body;
              if (phase.mode === 'release' && toolCatalog) {
                const active = toolCatalog.tools(artifactOwner, artifactScope);
                if (!active.ok) {
                  sendContextRecoveryError(active.reason);
                  return;
                }
                effectiveChatBody = {
                  ...effectiveChatBody,
                  tools: effectiveChatBody.tools?.some(
                    (tool) => tool?.function?.name === CONTEXT_ARTIFACT_TOOL_NAME
                  )
                    ? appendContextArtifactTool(active.tools)
                    : active.tools,
                };
              }
              // A validated mixed-tool phase deliberately changes temporary
              // controls. Make that a managed replacement, never a stale
              // compactor's implicit model/tools/settings overwrite.
              const replaced = historyBranch.replace(
                effectiveChatBody,
                historyBranch.stats().version
              );
              if (!replaced.ok) {
                sendContextRecoveryError(replaced.reason);
                return;
              }
              if (phase.mode === 'release') break;
            }
            const discovered = planWorkBuddyToolDiscovery({
              responseBody: wbipcResponse.body,
              chatBody: effectiveChatBody,
              catalog: toolCatalog,
              owner: artifactOwner,
              scope: artifactScope,
              plannerOptions,
              recoveryGuard,
              internalOnly: mixedToolPhase.hasDeferredCalls(),
              maxBytes: WBIPC_MAX_FRAME_BYTES,
              targetBodyBytes: contextCapacityController.targetBytes(
                capacityKey,
                learnedTargetBodyBytes
              ),
            });
            if (discovered.matched) {
              if (!discovered.ok) {
                sendContextRecoveryError(discovered.reason);
                return;
              }
              const plan = discovered.plan;
              if (!plan.fits) {
                if (
                  isContextHistoryFailure(plan.diagnostics.reason) ||
                  plan.diagnostics.reason?.startsWith('context_tool_')
                )
                  sendContextRecoveryError(plan.diagnostics.reason);
                else sendWbipcPayloadTooLarge(plan.diagnostics);
                return;
              }
              if (
                mixedToolPhase.hasDeferredCalls() &&
                discovered.attemptedCount > 0 &&
                discovered.resolvedCount !== discovered.attemptedCount
              ) {
                sendContextRecoveryError('context_artifact_recovery_failed');
                return;
              }
              if (discovered.attemptedCount > 0) artifactRounds += 1;
              artifactsResolved += discovered.resolvedCount;
              artifactsAttempted += discovered.attemptedCount;
              artifactsUnavailable += discovered.unavailableCount;
              artifactsBudgetExceeded += discovered.budgetExceededCount;
              effectiveChatBody = plan.body;
              wbipcResponse = await requestViaWbipc(effectiveChatBody);
              if (cancellation.isCanceled()) return;
              if (
                wbipcResponse?.ok === true &&
                wbipcResponse.status >= 200 &&
                wbipcResponse.status < 300
              )
                artifactsDelivered += discovered.resolvedCount;
              updateContextOutcome();
              if (typeof logProxyEvent === 'function')
                logProxyEvent('workbuddy_tool_discovery', {
                  round: plan.diagnostics.toolDiscoveryRound,
                  schemasLoaded: plan.diagnostics.toolSchemasLoaded,
                  schemaBytes: plan.diagnostics.toolSchemaBytes,
                  bodyBytes: plan.diagnostics.finalBodyBytes,
                  estimatedTokens: plan.diagnostics.finalEstimatedTokens,
                });
              continue;
            }
            const guard = recoveryGuard.accept(
              wbipcResponse.body,
              effectiveChatBody.stream === true,
              WBIPC_MAX_FRAME_BYTES
            );
            if (!guard.matched) break;
            if (!guard.ok) {
              sendContextRecoveryError(guard.reason);
              return;
            }
            const continuation = planWorkBuddyContextRecovery({
              responseBody: wbipcResponse.body,
              chatBody: effectiveChatBody,
              store: artifactReadStore,
              owner: artifactOwner,
              maxBytes: WBIPC_MAX_FRAME_BYTES,
              plannerOptions,
              targetBodyBytes: contextCapacityController.targetBytes(
                capacityKey,
                learnedTargetBodyBytes
              ),
            });
            if (!continuation.matched) break;
            if (!continuation.ok) {
              sendContextRecoveryError('context_artifact_invalid_turn');
              return;
            }
            artifactRounds += 1;
            artifactsResolved += continuation.resolvedCount;
            artifactsAttempted += continuation.attemptedCount;
            artifactsUnavailable += continuation.unavailableCount;
            artifactsBudgetExceeded += continuation.budgetExceededCount;
            const continuationPlan = continuation.plan;
            updateContextOutcome();
            if (
              mixedToolPhase.hasDeferredCalls() &&
              continuation.attemptedCount > 0 &&
              continuation.resolvedCount !== continuation.attemptedCount
            ) {
              sendContextRecoveryError('context_artifact_recovery_failed');
              return;
            }
            if (!continuationPlan.fits) {
              if (isContextHistoryFailure(continuationPlan.diagnostics.reason))
                sendContextRecoveryError(continuationPlan.diagnostics.reason);
              else sendWbipcPayloadTooLarge(continuationPlan.diagnostics);
              return;
            }
            effectiveChatBody = continuationPlan.body;
            wbipcResponse = await requestViaWbipc(effectiveChatBody);
            if (
              wbipcResponse?.ok === true &&
              Number.isInteger(wbipcResponse.status) &&
              wbipcResponse.status >= 200 &&
              wbipcResponse.status < 300
            ) {
              artifactsDelivered += continuation.resolvedCount;
            }
            updateContextOutcome();
            if (cancellation.isCanceled()) return;
            if (typeof logProxyEvent === 'function') {
              logProxyEvent('workbuddy_context_artifact_read', {
                round: artifactRounds,
                resolvedArtifacts: continuation.resolvedCount,
                attemptedArtifacts: continuation.attemptedCount,
                unavailableArtifacts: continuation.unavailableCount,
                budgetExceededArtifacts: continuation.budgetExceededCount,
                bodyBytes: continuationPlan.diagnostics.finalBodyBytes,
                estimatedTokens: continuationPlan.diagnostics.finalEstimatedTokens,
              });
            }
          }
          updateContextOutcome();
          if (
            nativeContext &&
            wbipcResponse?.ok === true &&
            Number.isInteger(wbipcResponse.status) &&
            wbipcResponse.status >= 200 &&
            wbipcResponse.status < 300 &&
            !nativeWorkBuddyResponseAllowed(
              wbipcResponse.body,
              effectiveChatBody,
              WBIPC_MAX_FRAME_BYTES,
              compactionInput.callIdDigests
            )
          ) {
            sendContextRecoveryError('context_artifact_invalid_turn');
            return;
          }
          if (typeof logProxyEvent === 'function') {
            logProxyEvent('workbuddy_wbipc_request', {
              ok: wbipcResponse && wbipcResponse.ok === true,
              status: safeWbipcStatus(wbipcResponse?.status),
              wbipcStatus: safeWbipcStatus(wbipcResponse?.status),
            });
          }
          if (!wbipcResponse || wbipcResponse.ok !== true) {
            if (isWorkBuddyWbipcPayloadTooLarge(wbipcResponse)) {
              contextCapacityController.recordRejection(
                capacityKey,
                Buffer.byteLength(JSON.stringify(effectiveChatBody))
              );
              sendWbipcPayloadTooLarge(
                retryPlan ? retryPlan.diagnostics : preflightPlan.diagnostics
              );
              return;
            }
            sendEncryptedCredentialError(
              wbipcResponse && wbipcResponse.status,
              wbipcResponse && wbipcResponse.status
            );
            return;
          }
          if (effectiveChatBody !== chatBody) {
            chatBody.messages = effectiveChatBody.messages;
            if (Array.isArray(effectiveChatBody.tools)) chatBody.tools = effectiveChatBody.tools;
          }
          cancellation.complete();
          convertBufferedWbipcResponse(
            wbipcResponse.body,
            wbipcResponse.status,
            wbipcResponse.headers || {}
          );
        })
        .catch((err) => {
          if (cancellation.isCanceled()) return;
          if (rejectToolHistoryError(err, 'wbipc_send')) return;
          if (!preflightPlan || toolCatalog || isContextHistoryFailure(err?.code)) {
            // Preparation failure is not proof that host credentials are unreadable.
            sendConversionError({
              clientReq,
              clientRes,
              upstreamPath,
              startTime,
              err,
              label: 'WorkBuddy context preparation',
              logType: 'workbuddy_context_preparation_error',
              sendJsonError,
              logRequestEnd,
            });
            return;
          }
          if (typeof logProxyEvent === 'function') {
            logProxyEvent('workbuddy_wbipc_request', {
              ok: false,
              status: 'error',
              errorCode: safeErrorCode(err),
            });
          }
          if (!clientRes.headersSent) sendEncryptedCredentialError('error', 'error');
          else
            logRequestEnd(clientReq.method, upstreamPath, startTime, 502, {
              errorCode: 'request_failed',
            });
        })
        .finally(() => {
          backgroundCompaction?.close();
          toolCatalog?.close();
          historyBranch?.close();
          cancellation.complete();
        });
      return;
    }

    function sendUpstreamChatRequest(currentPrepared, currentApiKey, retryAttempted) {
      const { headers, audit } = createConvertedChatRequest(
        currentPrepared,
        target,
        currentApiKey,
        requestBody
      );
      if (clientRes.__auditData) clientRes.__auditData.upstream = audit;
      const proxyReq = (target.protocol === 'https:' ? https : http).request(
        upstreamRequestOptions(target, target.path + '/chat/completions', headers, {
          profile: currentPrepared.profile,
          fallbackTimeoutMs: 600000,
        }),
        withUpstreamTiming(clientRes, (proxyRes) => {
          if (chatBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            if (!clientWantsStream) {
              collapseOpenAIChatStreamToResponses({
                proxyRes,
                clientReq,
                clientRes,
                upstreamPath,
                startTime,
                parsed,
                targetModel,
                chatBody,
                maxConversionResponseBytes,
                openAIChatToResponses,
                rememberResponsesFromChatResponse,
                writeJsonResponse,
                sendJsonError,
                logRequestEnd,
              });
              return;
            }
            const outputFlow = createConversionStreamOutput({
              proxyRes,
              clientRes,
              clientReq,
              upstreamPath,
              startTime,
              logRequestEnd,
              protocolOptions,
            });
            {
              const clientRes = outputFlow.clientRes;
              const logRequestEnd = outputFlow.logRequestEnd;
              const guardUpstreamStream = createUpstreamStreamGuard({ ...ctx, logRequestEnd });
              clientRes.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                ...CORS_HEADERS,
              });
              const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
              const decoder = new StringDecoder('utf8');
              const streamGuard = guardUpstreamStream(proxyRes, {
                clientRes,
                label: 'OpenAI Chat',
                logType: 'responses_to_chat_stream_aborted',
                method: clientReq.method,
                upstreamPath,
                startTime,
              });
              proxyRes.on('data', (chunk) => {
                if (streamGuard.hasFailed() || bridge.responseState.done) return;
                try {
                  processOpenAIChatSseChunkToResponses(
                    clientRes,
                    decoder.write(chunk),
                    bridge.responseState
                  );
                } catch (_error) {
                  bridge.responseState.invalidEvent = true;
                  bridge.responseState.buffer = '';
                  bridge.flush();
                }
              });
              proxyRes.on('end', () => {
                if (streamGuard.hasFailed() || clientRes.destroyed) return;
                streamGuard.markComplete();
                processOpenAIChatSseChunkToResponses(
                  clientRes,
                  decoder.end(),
                  bridge.responseState
                );
                bridge.flush();
                const failed = bridge.responseState.failed === true;
                if (!failed) rememberResponsesFromBridge(bridge, chatBody);
                clientRes.end();
                logRequestEnd(clientReq.method, upstreamPath, startTime, failed ? 502 : 200, {
                  type: failed ? 'responses_to_chat_stream_error' : 'responses_to_chat_stream',
                  errorCode: failed ? bridge.responseState.failure?.code : undefined,
                });
              });
            }
            return;
          }
          collectBoundedResponse(
            proxyRes,
            clientRes,
            upstreamPath,
            'responses_to_chat',
            (responseBody) => {
              const retryWithFreshWorkBuddyAuth = async () => {
                if (
                  retryAttempted ||
                  !isWorkBuddy ||
                  clientRes.headersSent ||
                  !isWorkBuddyUnauthorizedResponse(proxyRes.statusCode, responseBody)
                ) {
                  return false;
                }
                const refresh = await refreshWorkBuddyOfficialAuthOverride({
                  beforeAuth: currentPrepared.workbuddyAuth,
                  timeoutMs: protocolOptions.workbuddyAuthRefreshTimeoutMs,
                  intervalMs: protocolOptions.workbuddyAuthRefreshIntervalMs,
                });
                if (typeof logProxyEvent === 'function') {
                  logProxyEvent('workbuddy_auth_refresh', {
                    status: refresh.status,
                    triggerStatus: refresh.triggerStatus,
                    before: refresh.before,
                    after: refresh.after,
                  });
                }
                if (refresh.status !== 'refreshed') {
                  if (!clientRes.headersSent) {
                    sendJsonError(clientRes, 401, {
                      error: {
                        type: 'authentication_error',
                        code: 'workbuddy_auth_refresh_failed',
                        message:
                          'WorkBuddy official login could not be refreshed automatically. Open WorkBuddy and sign in again.',
                        refresh_status: refresh.status,
                      },
                    });
                    logRequestEnd(clientReq.method, upstreamPath, startTime, 401, {
                      type: 'responses_to_chat_error',
                      errorType: 'workbuddy_auth_refresh_failed',
                      refreshStatus: refresh.status,
                    });
                  }
                  return true;
                }
                const freshAuth = readWorkBuddyAuthInfoOverride();
                if (!freshAuth || !freshAuth.accessToken) {
                  if (!clientRes.headersSent) {
                    sendJsonError(clientRes, 401, {
                      error: {
                        type: 'authentication_error',
                        code: 'workbuddy_auth_refresh_missing_token',
                        message:
                          'WorkBuddy official login refreshed without a usable access token. Open WorkBuddy and sign in again.',
                      },
                    });
                    logRequestEnd(clientReq.method, upstreamPath, startTime, 401, {
                      type: 'responses_to_chat_error',
                      errorType: 'workbuddy_auth_refresh_missing_token',
                    });
                  }
                  return true;
                }
                sendUpstreamChatRequest(
                  {
                    ...currentPrepared,
                    profile: {
                      ...currentPrepared.profile,
                      apiKey: freshAuth.accessToken,
                      uid: freshAuth.uid,
                      uin: freshAuth.uin,
                    },
                    workbuddyAuth: freshAuth,
                  },
                  freshAuth.accessToken,
                  true
                );
                return true;
              };
              Promise.resolve()
                .then(retryWithFreshWorkBuddyAuth)
                .then((retried) => {
                  if (retried) return;
                  handleConvertedJsonResponse({
                    proxyRes,
                    clientReq,
                    clientRes,
                    upstreamPath,
                    startTime,
                    responseBody,
                    upstreamProvider: 'openai',
                    upstreamErrorType: 'responses_to_chat_error',
                    successType: 'responses_to_chat',
                    rateLimitCooldown: convertedRateLimitCooldown(prepared, targetModel),
                    conversionLabel: 'OpenAI Responses',
                    conversionLogType: 'openai_chat_to_responses_conversion_error',
                    convert: (body) => {
                      const chatPayload = parseJsonOrSseJson(body);
                      const response = openAIChatToResponses(
                        chatPayload,
                        parsed.model || targetModel,
                        parsed
                      );
                      rememberResponsesFromChatResponse(response, chatBody, chatPayload);
                      return response;
                    },
                  });
                })
                .catch((err) => {
                  if (typeof logProxyEvent === 'function') {
                    logProxyEvent('workbuddy_auth_refresh', {
                      status: 'refresh_error',
                      error: err && err.message ? err.message : String(err),
                    });
                  }
                  handleConvertedJsonResponse({
                    proxyRes,
                    clientReq,
                    clientRes,
                    upstreamPath,
                    startTime,
                    responseBody,
                    upstreamProvider: 'openai',
                    upstreamErrorType: 'responses_to_chat_error',
                    successType: 'responses_to_chat',
                    rateLimitCooldown: convertedRateLimitCooldown(currentPrepared, targetModel),
                    conversionLabel: 'OpenAI Responses',
                    conversionLogType: 'openai_chat_to_responses_conversion_error',
                    convert: (body) => {
                      const chatPayload = parseJsonOrSseJson(body);
                      const response = openAIChatToResponses(
                        chatPayload,
                        parsed.model || targetModel,
                        parsed
                      );
                      rememberResponsesFromChatResponse(response, chatBody, chatPayload);
                      return response;
                    },
                  });
                });
            },
            boundedResponseContext(clientReq, startTime, 'responses_to_chat')
          );
        })
      );

      proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
      proxyReq.on(
        'error',
        onProxyError(
          clientRes,
          'OpenAI',
          proxyErrorContext(
            clientReq,
            upstreamPath,
            startTime,
            'openai',
            'openai_chat_to_responses_proxy_error'
          )
        )
      );
      proxyReq.end(requestBody);
    }

    sendUpstreamChatRequest(prepared, apiKey, false);
  };
}

module.exports = {
  createOpenAIResponsesToChatHandler,
};
