'use strict';

const { randomUUID } = require('node:crypto');
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
const { createTianxiBridgeRuntime } = require('./tianxi-bridge-runtime');
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
  return String(value || '')
    .replace(/sat-[A-Za-z0-9._-]+/g, 'sat-<redacted>')
    .replace(
      /\b(authorization|cookie|set-cookie|token|access_token|refresh_token)\b\s*[:=]\s*[^,\s}]+/gi,
      '$1=<redacted>'
    )
    .replace(/[A-Za-z0-9_+/=-]{120,}/g, '<redacted-long>');
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

const NATIVE_FAILURE_CODES = new Set([
  'tianxi_tac_server_idle_timeout',
  'tianxi_tac_server_incomplete',
  'tianxi_tac_server_ws_error',
  'tianxi_native_runtime_timeout',
  'tianxi_tac_header_unavailable',
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
  if (channel) metadata.channel = channel;
  return metadata;
}

function createTianxiOfficialHandlers({
  sendJsonError,
  logRequestEnd,
  openAIResponsesToChat,
  normalizeTianxiOfficialModelName = defaultNormalizeTianxiOfficialModelName,
  callTianxiOfficialBridge,
  makeRequest,
  fallbackId,
  stableCreated,
  resolveTianxiNativeReadTools = defaultResolveTianxiNativeReadTools,
  responseHistory = createTianxiResponseHistory(),
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
    let nativeReadTools;
    try {
      nativeReadTools =
        (currentPrepared.rewriteTo || currentPrepared.route?.to) === 'super'
          ? resolveTianxiNativeReadTools(currentPrepared.profile, {
              requestInput: requestBody.input,
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
    });
    if (unsupportedFeature) {
      const unsupportedInput = unsupportedFeature === 'input';
      if (unsupportedInput && requestBody.stream === true) {
        const model = normalizeTianxiOfficialModelName(
          currentPrepared.rewriteTo || currentPrepared.model || requestBody.model || ''
        );
        writeTianxiResponsesStream(
          clientRes,
          requestBody,
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
      sendJsonError(clientRes, 422, {
        error: {
          type: 'invalid_request_error',
          code: unsupportedInput
            ? 'tianxi_input_media_unsupported'
            : 'tianxi_tool_bridge_unsupported',
          param: unsupportedFeature,
          message: unsupportedInput
            ? 'Tianxi local Responses accepts text input only.'
            : 'Tianxi local Responses supports text generation, but cannot execute client tools.',
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 422, {
        type: unsupportedInput
          ? 'tianxi_official_input_media_unsupported'
          : 'tianxi_official_tools_unsupported',
      });
      return;
    }
    const owner = JSON.stringify([
      clientReq.entryAuth?.key?.id || 'local-entry',
      currentPrepared.profile?.id || '',
    ]);
    const previousId = requestBody.previous_response_id;
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
    const userText = extractTianxiPromptText(requestBody.input);
    const continuedInput = previousId
      ? buildTianxiContinuationInput(previousTurns, userText)
      : requestBody.input;
    if (continuedInput == null) {
      sendJsonError(clientRes, 413, {
        error: { type: 'invalid_request_error', code: 'tianxi_context_too_large' },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, 413, {
        type: 'tianxi_context_too_large',
      });
      return;
    }
    const model = normalizeTianxiOfficialModelName(
      currentPrepared.rewriteTo || currentPrepared.model || requestBody.model || ''
    );
    const chatBody = (() => {
      try {
        return openAIResponsesToChat({ ...requestBody, model: model || requestBody.model });
      } catch (_err) {
        return null;
      }
    })();
    const payload = {
      model,
      input: continuedInput,
      instructions: requestBody.instructions,
      stream: Boolean(requestBody.stream),
      metadata: {
        source: 'https-proxy-manager',
        profileId: currentPrepared.profile && currentPrepared.profile.id,
        requestedModel: requestBody.model || '',
        routedModel: currentPrepared.rewriteTo || currentPrepared.model || '',
        tianxi: { ...tianxiRouteMetadata(currentPrepared.route), ...(nativeReadTools || {}) },
      },
      chat: chatBody,
    };
    const controller = new AbortController();
    const responseId = 'resp_' + randomUUID().replace(/-/g, '');
    const responseDeps = {
      fallbackId,
      stableCreated,
      responseId,
      createdAt: Math.floor(Date.now() / 1000),
    };
    let heartbeat = null;
    let responseStream = null;
    const onClose = () => {
      if (!clientRes.writableEnded) controller.abort();
    };
    if (typeof clientRes.on === 'function') clientRes.on('close', onClose);
    try {
      if (requestBody.stream) {
        if (nativeReadTools && typeof clientRes.setHeader === 'function') {
          clientRes.setHeader('X-Tianxi-Tool-Mode', 'native-read-only');
        }
        responseStream = createTianxiResponsesStream(clientRes, requestBody, model, responseDeps);
        heartbeat = setInterval(() => {
          if (!controller.signal.aborted && !clientRes.destroyed && !clientRes.writableEnded) {
            clientRes.write(': tianxi-bridge-waiting\n\n');
          }
        }, 15000);
      }
      const bridge = await bridgeRuntime(payload, currentPrepared.profile, {
        signal: controller.signal,
        onFrame: responseStream ? responseStream.writeFrame : undefined,
      });
      if (controller.signal.aborted || clientRes.destroyed) return;
      const response = buildTianxiResponsesResponse(
        requestBody,
        bridge.frames,
        model,
        responseDeps
      );
      const assistantText = response.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text || '')
        .join('');
      if (requestBody.store !== false && response.status === 'completed' && assistantText) {
        responseHistory.save(responseId, owner, [
          ...previousTurns,
          { user: userText, assistant: assistantText },
        ]);
      }
      if (!requestBody.stream && nativeReadTools && typeof clientRes.setHeader === 'function') {
        clientRes.setHeader('X-Tianxi-Tool-Mode', 'native-read-only');
      }
      clientRes.__diagnostics = {
        protocol: 'tianxi',
        route: currentPrepared.model,
        target: currentPrepared.rewriteTo,
        bridgeUrl: bridge.bridgeUrl,
      };
      if (requestBody.stream) {
        responseStream.finish(bridge.frames);
      } else {
        writeJsonResponse(clientRes, response);
      }
      logRequestEnd(clientReq.method, urlPath, startTime, 200, {
        type: requestBody.stream
          ? 'tianxi_official_responses_bridge_stream'
          : 'tianxi_official_responses_bridge',
      });
    } catch (err) {
      if (controller.signal.aborted || clientRes.destroyed) return;
      const causeCode = nativeFailureCode(err);
      if (responseStream && clientRes.headersSent) {
        const hadNativeFrames = responseStream.frameCount > 0;
        if (!hadNativeFrames) {
          responseStream.writeFrame({
            type: 'task_status',
            data: {
              status: 'FAILED',
              error_code: causeCode,
              error_detail: 'Tianxi native request failed.',
            },
          });
        }
        responseStream.finish();
        logRequestEnd(clientReq.method, urlPath, startTime, 200, {
          type: hadNativeFrames
            ? 'tianxi_official_responses_bridge_stream_incomplete'
            : 'tianxi_official_responses_bridge_stream_failed',
          causeCode,
        });
        return;
      }
      const isConnectionError =
        err &&
        (err.code === 'ECONNREFUSED' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          /timeout|connect ECONNREFUSED/i.test(err.message || ''));
      const statusCode = isConnectionError
        ? 503
        : err.statusCode && err.statusCode >= 400
          ? err.statusCode
          : 502;
      sendJsonError(clientRes, statusCode, {
        error: {
          type: isConnectionError ? 'service_unavailable' : 'api_error',
          message: isConnectionError
            ? 'Tianxi local super mode is not reachable. Open Tianxi AI and sign in, then retry.'
            : 'Tianxi bridge request failed.',
          bridge_url: err.bridgeUrl,
          diagnostics: sanitizeTianxiBridgeDiagnostics(err.diagnostics),
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, statusCode, {
        type: 'tianxi_official_responses_bridge_error',
        bridgeUrl: err.bridgeUrl,
        causeCode,
      });
    } finally {
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
