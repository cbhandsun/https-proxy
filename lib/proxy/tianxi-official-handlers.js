'use strict';

const { randomUUID } = require('node:crypto');
const { sanitizeTianxiErrorText } = require('./tianxi-error-message');
const {
  assertTianxiPermissionSupported,
  tianxiReadOnlyInstructions,
  TIANXI_PERMISSION_MESSAGE,
} = require('./tianxi-permission-boundary');
const { AbortController } = globalThis;
const {
  buildTianxiResponsesResponse,
  createTianxiResponsesStream,
  writeTianxiResponsesStream,
} = require('./tianxi-responses');
const { extractTianxiPromptText } = require('./tianxi-agentcore-protocol');
const {
  getTianxiOfficialBridgeUrl,
  normalizeTianxiOfficialModelName: defaultNormalizeTianxiOfficialModelName,
} = require('./tianxi-official');
const { createTianxiBridgeRuntime, shouldUseDirectRuntime } = require('./tianxi-bridge-runtime');
const {
  createTianxiClientToolSessions,
  serveTianxiClientToolLease,
  parseClientOutputs,
} = require('./tianxi-client-tool-sessions');
const { createTianxiToolResultCache, REFERENCE_PATTERN } = require('./tianxi-tool-result-cache');
const { createTianxiToolResultSession } = require('./tianxi-tool-result-session');
const {
  waitTianxiResultContinuation,
  trackTianxiNativeTask,
} = require('./tianxi-live-result-wait');
const {
  resolveTianxiResultBridge,
  parseTianxiResultContinuation,
} = require('./tianxi-tool-result-continuation');
const {
  replayTianxiResult,
  replayTianxiResultCall,
  unavailableTianxiResultResponse,
} = require('./tianxi-tool-result-replay');
const {
  parseTianxiResultFormat,
  tianxiResultToolForFormat,
} = require('./tianxi-progress-presentation');
const { unsupportedTianxiResponsesFeature } = require('./tianxi-request-contract');
const {
  resolveTianxiNativeReadTools: defaultResolveTianxiNativeReadTools,
} = require('./tianxi-native-read-tools');
const {
  buildTianxiContinuationInput,
  createTianxiResponseHistory,
} = require('./tianxi-response-history');

function writeJsonResponse(clientRes, payload) {
  const body = JSON.stringify(payload);
  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  clientRes.end(body);
}

function compactRouteString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function sanitizeTianxiDiagnosticText(value) {
  return sanitizeTianxiErrorText(String(value || ''));
}

function sanitizeTianxiBridgeDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
    return undefined;
  }
  const sanitized = {};
  for (const key of Object.keys(diagnostics)) {
    const value = diagnostics[key];
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = sanitizeTianxiDiagnosticText(value).slice(0, 500);
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function assistantTextFromResponsesResponse(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .filter((item) => item.type === 'message' && item.phase !== 'commentary')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text || '')
    .join('');
}

function streamErrorLogType(hadNativeFrames, response) {
  if (!hadNativeFrames) return 'tianxi_official_responses_bridge_stream_failed';
  return response?.status === 'completed'
    ? 'tianxi_official_responses_bridge_stream_partial_completed'
    : 'tianxi_official_responses_bridge_stream_incomplete';
}

const TIANXI_TOOL_HISTORY_TYPES = new Set([
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_call',
  'tool_call_output',
  'call',
  'additional_tools',
  'tool_search_call',
  'tool_search_output',
]);

function isTianxiToolHistoryInput(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    TIANXI_TOOL_HISTORY_TYPES.has(value.type)
  );
}

function stripTianxiToolHistoryInput(value) {
  if (Array.isArray(value)) {
    return value
      .map(stripTianxiToolHistoryInput)
      .filter((item) => item !== undefined && item !== null);
  }
  if (!value || typeof value !== 'object') return value;
  if (isTianxiToolHistoryInput(value)) return undefined;
  if (!Object.hasOwn(value, 'content')) return value;
  const next = { ...value };
  const content = stripTianxiToolHistoryInput(value.content);
  if (content === undefined || content === null) delete next.content;
  else next.content = content;
  return next;
}

const NATIVE_FAILURE_CODES = new Set([
  'tianxi_tac_server_idle_timeout',
  'tianxi_tac_server_incomplete',
  'tianxi_tac_server_ws_error',
  'tianxi_tac_server_output_limit',
  'tianxi_native_runtime_timeout',
  'tianxi_tac_header_unavailable',
  'tianxi_tac_server_port_invalid',
  'tianxi_tac_server_port_unavailable',
]);

function nativeFailureCode(error) {
  const candidates = [
    error?.code,
    error?.diagnostics?.cause_code,
    error?.diagnostics?.cause_message,
  ];
  return (
    candidates.find((value) => NATIVE_FAILURE_CODES.has(value)) || 'tianxi_native_runtime_failed'
  );
}

function tianxiRouteMetadata(route) {
  if (!route || typeof route !== 'object') return {};
  const agentId = compactRouteString(route.tianxiAgentId || route.agentId || route.to);
  const llm = compactRouteString(route.tianxiLlm || route.llm);
  const channel = compactRouteString(route.tianxiChannel || route.channel);
  const metadata = {};
  if (agentId) metadata.agent_id = agentId;
  if (llm) metadata.llm = llm;
  if (route.tianxiSdkModel) metadata.sdk_model = compactRouteString(route.tianxiSdkModel);
  if (channel) metadata.channel = channel;
  return metadata;
}

function createTianxiOfficialHandlers({
  sendJsonError,
  logRequestEnd,
  logProxyEvent,
  openAIResponsesToChat,
  normalizeTianxiOfficialModelName = defaultNormalizeTianxiOfficialModelName,
  callTianxiOfficialBridge,
  makeRequest,
  fallbackId,
  stableCreated,
  resolveTianxiNativeReadTools = defaultResolveTianxiNativeReadTools,
  responseHistory = createTianxiResponseHistory(),
  toolResultCache = createTianxiToolResultCache(),
  clientToolSessions = createTianxiClientToolSessions({
    onDiagnostic: (diagnostic) => logProxyEvent?.('tianxi_client_tool_failed', diagnostic),
    onCorrection: (diagnostic) =>
      logProxyEvent?.('tianxi_client_tool_arguments_rejected', diagnostic),
  }),
  supportsTianxiClientTools = (profile) => shouldUseDirectRuntime(profile, process.env),
}) {
  const bridgeRuntime =
    callTianxiOfficialBridge ||
    createTianxiBridgeRuntime({
      makeRequest,
      getTianxiOfficialBridgeUrl,
    }).callTianxiOfficialBridge;

  function parseTianxiOfficialJsonBody(clientReq, clientRes, requestBuffer, startTime, urlPath) {
    if (clientReq.headers['content-encoding']) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'Tianxi bridge does not support compressed request bodies',
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 400, {
        type: 'tianxi_official_responses_bridge_compressed',
      });
      return null;
    }
    try {
      const value = JSON.parse(requestBuffer.toString('utf8') || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        sendJsonError(clientRes, 400, {
          error: {
            type: 'invalid_request_error',
            code: 'tianxi_request_body_invalid',
            message: 'Tianxi Responses request body must be a JSON object.',
          },
        });
        logRequestEnd(clientReq.method, urlPath, startTime, 400, {
          type: 'tianxi_official_responses_bridge_invalid_body',
        });
        return null;
      }
      return value;
    } catch (err) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'Invalid JSON request body: ' + err.message,
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 400, {
        type: 'tianxi_official_responses_bridge_bad_json',
      });
      return null;
    }
  }

  async function handleTianxiOfficialResponses(
    clientReq,
    clientRes,
    requestBuffer,
    currentPrepared,
    startTime,
    urlPath
  ) {
    const requestBody = parseTianxiOfficialJsonBody(
      clientReq,
      clientRes,
      requestBuffer,
      startTime,
      urlPath
    );
    if (!requestBody) return;
    const owner = JSON.stringify([
      clientReq.entryAuth?.key?.id || 'local-entry',
      currentPrepared.profile?.id || '',
    ]);
    const resultError = (status, code) => {
      sendJsonError(clientRes, status, { error: { type: 'invalid_request_error', code } });
      logRequestEnd(clientReq.method, urlPath, startTime, status, { type: code });
    };
    const sdkRoute = Boolean(currentPrepared.route?.tianxiSdkModel);
    if (sdkRoute && unsupportedTianxiResponsesFeature(requestBody, { responseHistory: true })) {
      resultError(400, 'tianxi_sdk_feature_unsupported');
      return;
    }
    try {
      const clientOutputs = parseClientOutputs(requestBody.input);
      if (
        clientOutputs &&
        unsupportedTianxiResponsesFeature(requestBody, {
          nativeReadTools: true,
          responseHistory: true,
          toolHistory: true,
        })
      ) {
        resultError(400, 'tianxi_client_continuation_request_invalid');
        return;
      }
      const lease = clientOutputs
        ? clientToolSessions.resume(owner, requestBody.input, {
            allowTools: requestBody.tool_choice !== 'none',
          })
        : null;
      if (lease) {
        const replay = await serveTianxiClientToolLease(
          clientRes,
          lease,
          requestBody.stream === true
        );
        logRequestEnd(clientReq.method, urlPath, startTime, 200, {
          type: 'tianxi_client_tool_continuation',
          status: replay.status,
        });
        return;
      }
    } catch (error) {
      resultError(error.statusCode || 400, error.code || 'tianxi_client_continuation_invalid');
      return;
    }
    if (requestBody.metadata && Object.hasOwn(requestBody.metadata, 'tianxi_result_reference')) {
      const reference = requestBody.metadata.tianxi_result_reference;
      if (
        typeof reference !== 'string' ||
        !REFERENCE_PATTERN.test(reference) ||
        requestBody.stream === true
      ) {
        resultError(400, 'tianxi_result_reference_invalid');
        return;
      }
      const record = toolResultCache.lookup(owner, reference);
      if (!record) {
        resultError(404, 'tianxi_result_not_found');
        return;
      }
      const format = parseTianxiResultFormat(requestBody.metadata.tianxi_result_format);
      if (!format) {
        resultError(400, 'tianxi_result_format_invalid');
        return;
      }
      writeJsonResponse(clientRes, {
        object: 'tianxi.tool_result',
        ...record,
        tool: tianxiResultToolForFormat(record.tool, format),
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 200, { type: 'tianxi_result_lookup' });
      return;
    }
    const continuation = parseTianxiResultContinuation(requestBody.input);
    if (continuation.kind !== 'none') {
      if (continuation.kind === 'invalid') {
        resultError(400, 'tianxi_result_continuation_invalid');
        return;
      }
      let retained = toolResultCache.continuation(owner, continuation.references);
      if (retained?.status === 'in_progress' && !retained.nextCall) {
        retained = await waitTianxiResultContinuation(
          toolResultCache,
          owner,
          continuation.references,
          clientRes,
          { stream: requestBody.stream === true }
        );
        if (clientRes.destroyed) return;
      }
      if (!retained) {
        if (clientRes.headersSent) {
          replayTianxiResult(
            unavailableTianxiResultResponse('incomplete', currentPrepared.model),
            clientRes,
            true
          );
          logRequestEnd(clientReq.method, urlPath, startTime, 200, {
            type: 'tianxi_result_continuation_expired',
          });
          return;
        }
        resultError(404, 'tianxi_result_not_found');
        return;
      }
      if (retained.status === 'in_progress' && !retained.nextCall) {
        resultError(409, 'tianxi_result_continuation_unavailable');
        return;
      }
      if (!retained.response) {
        const failed = unavailableTianxiResultResponse(retained.status, currentPrepared.model);
        const replay = replayTianxiResult(failed, clientRes, requestBody.stream === true);
        if (requestBody.stream !== true) writeJsonResponse(clientRes, replay);
        logRequestEnd(clientReq.method, urlPath, startTime, 200, {
          type: 'tianxi_result_continuation_terminal_unavailable',
          causeCode: retained.status,
        });
        return;
      }
      if (retained.nextCall && requestBody.tool_choice === 'none') {
        resultError(409, 'tianxi_result_client_tools_disabled');
        return;
      }
      const replay = retained.nextCall
        ? replayTianxiResultCall(
            retained.response,
            retained.nextCall,
            clientRes,
            requestBody.stream === true
          )
        : replayTianxiResult(retained.response, clientRes, requestBody.stream === true);
      const retainedTurns = responseHistory.get(retained.response.id, owner);
      if (requestBody.store !== false && retainedTurns)
        responseHistory.save(replay.id, owner, retainedTurns);
      if (requestBody.stream !== true) writeJsonResponse(clientRes, replay);
      logRequestEnd(clientReq.method, urlPath, startTime, 200, {
        type: 'tianxi_result_continuation',
      });
      return;
    }
    const resultTool = resolveTianxiResultBridge(requestBody.tools, requestBody.input);
    const tianxiInput = stripTianxiToolHistoryInput(requestBody.input);
    const tianxiRequestBody = { ...requestBody, input: tianxiInput };
    let nativeReadTools;
    try {
      nativeReadTools =
        (currentPrepared.rewriteTo || currentPrepared.route?.to) === 'super'
          ? resolveTianxiNativeReadTools(currentPrepared.profile, {
              requestInput: tianxiRequestBody.input,
            })
          : null;
    } catch (_error) {
      sendJsonError(clientRes, 422, {
        error: {
          type: 'invalid_request_error',
          code: 'tianxi_native_workspace_invalid',
          message: 'Tianxi native read-only workspace is unavailable.',
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 422, {
        type: 'tianxi_native_workspace_invalid',
      });
      return;
    }
    const unsupportedFeature = unsupportedTianxiResponsesFeature(requestBody, {
      nativeReadTools: Boolean(nativeReadTools),
      responseHistory: true,
      toolHistory: true,
    });
    if (unsupportedFeature) {
      const unsupportedInput = unsupportedFeature === 'input';
      if (unsupportedInput && tianxiRequestBody.stream === true) {
        const model = normalizeTianxiOfficialModelName(
          currentPrepared.rewriteTo || currentPrepared.model || tianxiRequestBody.model || ''
        );
        writeTianxiResponsesStream(
          clientRes,
          tianxiRequestBody,
          [
            {
              type: 'task_status',
              data: {
                status: 'FAILED',
                error_code: 'tianxi_input_media_unsupported',
                error_detail: 'Tianxi local Responses accepts text input only.',
              },
            },
          ],
          model,
          {
            responseId: 'resp_' + randomUUID().replace(/-/g, ''),
            createdAt: Math.floor(Date.now() / 1000),
          }
        );
        logRequestEnd(clientReq.method, urlPath, startTime, 200, {
          type: 'tianxi_official_input_media_unsupported_stream',
        });
        return;
      }
      const invalidParallelPolicy = unsupportedFeature === 'parallel_tool_calls';
      const statusCode = invalidParallelPolicy ? 400 : 422;
      sendJsonError(clientRes, statusCode, {
        error: {
          type: 'invalid_request_error',
          code: invalidParallelPolicy
            ? 'tianxi_invalid_request_parameter'
            : unsupportedInput
              ? 'tianxi_input_media_unsupported'
              : 'tianxi_tool_bridge_unsupported',
          param: unsupportedFeature,
          message: invalidParallelPolicy
            ? 'parallel_tool_calls must be a boolean or null.'
            : unsupportedInput
              ? 'Tianxi local Responses accepts text input only.'
              : 'This Tianxi route cannot execute the requested client tools. Use tianxi/super with the read-only tool bridge enabled for project inspection.',
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, statusCode, {
        type: invalidParallelPolicy
          ? 'tianxi_official_invalid_request_parameter'
          : unsupportedInput
            ? 'tianxi_official_input_media_unsupported'
            : 'tianxi_official_tools_unsupported',
        unsupportedFeature,
      });
      return;
    }
    const previousId = tianxiRequestBody.previous_response_id;
    if (
      previousId != null &&
      (typeof previousId !== 'string' || !/^resp_[0-9a-f]{32}$/.test(previousId))
    ) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          code: 'tianxi_previous_response_id_invalid',
          param: 'previous_response_id',
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 400, {
        type: 'tianxi_previous_response_id_invalid',
      });
      return;
    }
    const previousTurns = previousId ? responseHistory.get(previousId, owner) : [];
    if (previousId && !previousTurns) {
      sendJsonError(clientRes, 404, {
        error: {
          type: 'invalid_request_error',
          code: 'tianxi_previous_response_not_found',
          param: 'previous_response_id',
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 404, {
        type: 'tianxi_previous_response_not_found',
      });
      return;
    }
    const userText = extractTianxiPromptText(tianxiRequestBody.input);
    const continuedInput = previousId
      ? buildTianxiContinuationInput(previousTurns, userText)
      : tianxiRequestBody.input;
    if (continuedInput == null) {
      sendJsonError(clientRes, 413, {
        error: { type: 'invalid_request_error', code: 'tianxi_context_too_large' },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 413, {
        type: 'tianxi_context_too_large',
      });
      return;
    }
    const requestSummary = {
      requestBodyBytes: requestBuffer.length,
      promptChars: userText.length,
      nativeInputChars: extractTianxiPromptText(continuedInput).length,
      continuation: Boolean(previousId),
      nativeReadTools: Boolean(nativeReadTools),
      clientResultBridgeAdvertised: Boolean(resultTool),
      clientResultCallMode: requestBody.parallel_tool_calls === false ? 'serial' : 'parallel',
      clientResultBridgeSource: resultTool?.source || 'unavailable',
      clientResultToolStyle: resultTool
        ? resultTool.kind === 'code_mode'
          ? 'code_mode'
          : resultTool.namespace
            ? 'namespaced'
            : 'flattened'
        : 'unavailable',
    };
    const model = normalizeTianxiOfficialModelName(
      currentPrepared.rewriteTo || currentPrepared.model || tianxiRequestBody.model || ''
    );
    const chatBody = (() => {
      try {
        return openAIResponsesToChat({
          ...tianxiRequestBody,
          model: model || tianxiRequestBody.model,
        });
      } catch (_err) {
        return null;
      }
    })();
    const payload = {
      model,
      input: continuedInput,
      instructions: tianxiReadOnlyInstructions(tianxiRequestBody.instructions, nativeReadTools),
      stream: Boolean(tianxiRequestBody.stream),
      metadata: {
        source: 'https-proxy-manager',
        profileId: currentPrepared.profile && currentPrepared.profile.id,
        requestedModel: tianxiRequestBody.model || '',
        routedModel: currentPrepared.rewriteTo || currentPrepared.model || '',
        tianxi: { ...tianxiRouteMetadata(currentPrepared.route), ...(nativeReadTools || {}) },
      },
      chat: chatBody,
    };
    if (
      !sdkRoute &&
      currentPrepared.profile?.tianxiClientReadTools === true &&
      requestBody.tool_choice !== 'none'
    ) {
      const executor = resolveTianxiResultBridge(requestBody.tools, requestBody.input, {
        preferCodeMode: true,
        requireCommandExecutor: true,
      });
      if (!nativeReadTools || !executor || !supportsTianxiClientTools(currentPrepared.profile)) {
        resultError(422, 'tianxi_client_executor_unavailable');
        return;
      }
      try {
        clientRes.setHeader?.('X-Tianxi-Tool-Mode', 'client-read-only');
        const lease = clientToolSessions.start({
          owner,
          model,
          payload: { ...payload, instructions: tianxiRequestBody.instructions },
          nativeTools: nativeReadTools,
          run: (nativePayload, context) =>
            bridgeRuntime(nativePayload, currentPrepared.profile, context),
          onFinal(final) {
            const assistant = assistantTextFromResponsesResponse(final);
            if (requestBody.store !== false && final.status === 'completed' && assistant)
              responseHistory.save(final.id, owner, [
                ...previousTurns,
                { user: userText, assistant },
              ]);
          },
        });
        const delivered = await serveTianxiClientToolLease(
          clientRes,
          lease,
          requestBody.stream === true
        );
        logRequestEnd(clientReq.method, urlPath, startTime, 200, {
          type: 'tianxi_client_tool_handoff',
          status: delivered.status,
        });
      } catch (error) {
        if (!clientRes.headersSent)
          resultError(error.statusCode || 400, error.code || 'tianxi_client_session_invalid');
      }
      return;
    }
    const controller = new AbortController();
    const resultBridge =
      nativeReadTools && requestBody.tool_choice !== 'none' && resultTool
        ? createTianxiToolResultSession(toolResultCache, owner, {
            parallelToolCalls: requestBody.parallel_tool_calls,
            resultTool,
            live: requestBody.stream === true,
          })
        : null;
    requestSummary.resultBridgeEnabled = Boolean(resultBridge);
    requestSummary.progressModeReason = resultBridge
      ? 'bridge_enabled'
      : !nativeReadTools
        ? 'native_tools_disabled'
        : requestBody.tool_choice === 'none'
          ? 'client_tools_disabled'
          : !requestSummary.clientResultBridgeAdvertised
            ? 'client_bridge_unavailable'
            : 'bridge_capacity_unavailable';
    if (!clientRes.headersSent && typeof clientRes.setHeader === 'function') {
      clientRes.setHeader(
        'X-Tianxi-Progress-Mode',
        resultBridge ? 'mcp-result-bridge' : 'commentary'
      );
    }
    const responseId = 'resp_' + randomUUID().replace(/-/g, '');
    const responseDeps = {
      fallbackId,
      stableCreated,
      responseId,
      nativeProgressItems: true,
      nativeProgressMessages: true,
      nativeReasoningSegments: true,
      nativeProgressDetails: true,
      nativeProgressWorkspace: nativeReadTools?.cwd,
      resultBridge,
      liveResultBridge: requestBody.stream === true && requestBody.parallel_tool_calls === false,
      createdAt: Math.floor(Date.now() / 1000),
    };
    let heartbeat = null;
    let responseStream = null;
    let requestEnded = false;
    let permissionBlocked = false;
    let handedOff = false;
    const logBridgeEnd = (statusCode, details) => {
      if (requestEnded) return;
      requestEnded = true;
      logRequestEnd(clientReq.method, urlPath, startTime, statusCode, details);
    };
    const onClose = () => {
      if (!clientRes.writableEnded) {
        logBridgeEnd(499, {
          type: 'tianxi_official_responses_bridge_canceled',
          causeCode: 'client_disconnected',
          tianxi: responseStream?.getSummary(),
          tianxiRequest: requestSummary,
        });
        controller.abort();
        resultBridge?.abort();
      }
    };
    if (typeof clientRes.on === 'function') clientRes.on('close', onClose);
    const endNativeTask = trackTianxiNativeTask();
    try {
      if (tianxiRequestBody.stream) {
        if (nativeReadTools && typeof clientRes.setHeader === 'function') {
          clientRes.setHeader('X-Tianxi-Tool-Mode', 'native-read-only');
        }
        responseStream = createTianxiResponsesStream(
          clientRes,
          tianxiRequestBody,
          model,
          responseDeps
        );
        heartbeat = setInterval(() => {
          if (!controller.signal.aborted && !clientRes.destroyed && !clientRes.writableEnded) {
            clientRes.write(': tianxi-bridge-waiting\n\n');
          }
        }, 15000);
      }
      const bridge = await bridgeRuntime(payload, currentPrepared.profile, {
        signal: controller.signal,
        onFrame(frame) {
          try {
            assertTianxiPermissionSupported(frame);
          } catch (error) {
            permissionBlocked = true;
            throw error;
          }
          responseStream?.writeFrame(frame);
          if (
            !handedOff &&
            responseStream?.state.status !== 'failed' &&
            resultBridge?.readyForHandoff &&
            resultBridge.enableLive(model, () => controller.abort())
          ) {
            handedOff = true;
            responseStream.finish([], { toolHandoff: true });
            if (heartbeat) clearInterval(heartbeat);
            logBridgeEnd(200, {
              type: 'tianxi_result_live_handoff',
              tianxiRequest: requestSummary,
            });
          }
        },
      });
      if (controller.signal.aborted || (clientRes.destroyed && !handedOff)) return;
      for (const frame of bridge.frames) {
        try {
          assertTianxiPermissionSupported(frame);
        } catch (error) {
          permissionBlocked = true;
          throw error;
        }
      }
      const response = buildTianxiResponsesResponse(tianxiRequestBody, bridge.frames, model, {
        ...responseDeps,
        resultBridge: null,
      });
      const presentedResponse = resultBridge
        ? buildTianxiResponsesResponse(tianxiRequestBody, bridge.frames, model, responseDeps)
        : response;
      resultBridge?.settle(response);
      const assistantText = assistantTextFromResponsesResponse(response);
      if (tianxiRequestBody.store !== false && response.status === 'completed' && assistantText) {
        responseHistory.save(responseId, owner, [
          ...previousTurns,
          { user: userText, assistant: assistantText },
        ]);
      }
      if (
        !tianxiRequestBody.stream &&
        nativeReadTools &&
        typeof clientRes.setHeader === 'function'
      ) {
        clientRes.setHeader('X-Tianxi-Tool-Mode', 'native-read-only');
      }
      clientRes.__diagnostics = {
        protocol: 'tianxi',
        route: currentPrepared.model,
        target: currentPrepared.rewriteTo,
        bridgeUrl: bridge.bridgeUrl,
      };
      if (tianxiRequestBody.stream) {
        responseStream.finish(bridge.frames);
      } else {
        writeJsonResponse(clientRes, presentedResponse);
      }
      logBridgeEnd(200, {
        type: tianxiRequestBody.stream
          ? 'tianxi_official_responses_bridge_stream'
          : 'tianxi_official_responses_bridge',
        tianxi: responseStream ? responseStream.getSummary() : requestSummary,
        ...(responseStream ? { tianxiRequest: requestSummary } : {}),
      });
    } catch (err) {
      if (controller.signal.aborted || (clientRes.destroyed && !handedOff)) return;
      const causeCode = permissionBlocked
        ? 'tianxi_native_permission_required'
        : nativeFailureCode(err);
      if (responseStream && clientRes.headersSent) {
        const hadNativeFrames = responseStream.frameCount > 0;
        if (!hadNativeFrames || permissionBlocked || handedOff) {
          responseStream.writeFrame({
            type: 'task_status',
            data: {
              status: 'FAILED',
              // Codex treats unknown response.failed codes as retryable stream errors.
              // Interactive approval is unsupported for this request, not an upstream outage.
              error_code: permissionBlocked || handedOff ? 'invalid_prompt' : causeCode,
              error_detail: permissionBlocked
                ? TIANXI_PERMISSION_MESSAGE
                : 'Tianxi native request failed.',
            },
          });
        }
        resultBridge?.settle(
          buildTianxiResponsesResponse(
            tianxiRequestBody,
            responseStream.getFrames(),
            model,
            { ...responseDeps, resultBridge: null },
            { interrupted: true }
          )
        );
        const response = responseStream.finish([], { interrupted: true });
        const assistantText = assistantTextFromResponsesResponse(response);
        if (
          tianxiRequestBody.store !== false &&
          response?.status === 'completed' &&
          assistantText
        ) {
          responseHistory.save(responseId, owner, [
            ...previousTurns,
            { user: userText, assistant: assistantText },
          ]);
        }
        logBridgeEnd(200, {
          type: streamErrorLogType(hadNativeFrames, response),
          causeCode,
          tianxi: responseStream.getSummary(),
          tianxiRequest: requestSummary,
        });
        return;
      }
      resultBridge?.settle(null);
      const isConnectionError =
        err &&
        (err.code === 'ECONNREFUSED' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          /timeout|connect ECONNREFUSED/i.test(err.message || ''));
      const statusCode = permissionBlocked
        ? 403
        : isConnectionError
          ? 503
          : err.statusCode && err.statusCode >= 400
            ? err.statusCode
            : 502;
      sendJsonError(clientRes, statusCode, {
        error: {
          type: permissionBlocked
            ? 'invalid_request_error'
            : isConnectionError
              ? 'service_unavailable'
              : 'api_error',
          message: permissionBlocked
            ? TIANXI_PERMISSION_MESSAGE
            : isConnectionError
              ? 'Tianxi local super mode is not reachable. Open Tianxi AI and sign in, then retry.'
              : 'Tianxi bridge request failed.',
          bridge_url: err.bridgeUrl,
          diagnostics: sanitizeTianxiBridgeDiagnostics(err.diagnostics),
        },
      });
      logBridgeEnd(statusCode, {
        type: 'tianxi_official_responses_bridge_error',
        bridgeUrl: err.bridgeUrl,
        causeCode,
        tianxiRequest: requestSummary,
      });
    } finally {
      endNativeTask();
      if (permissionBlocked) controller.abort();
      if (resultBridge && !resultBridge.hasCalls) resultBridge.discard();
      if (heartbeat) clearInterval(heartbeat);
      if (typeof clientRes.off === 'function') clientRes.off('close', onClose);
    }
  }

  return {
    handleTianxiOfficialResponses,
  };
}

module.exports = {
  createTianxiOfficialHandlers,
};
