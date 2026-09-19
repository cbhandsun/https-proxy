'use strict';

const { buildTianxiResponsesResponse, writeTianxiResponsesStream } = require('./tianxi-responses');
const {
  getTianxiOfficialBridgeUrl,
  normalizeTianxiOfficialModelName: defaultNormalizeTianxiOfficialModelName,
} = require('./tianxi-official');
const { createTianxiBridgeRuntime } = require('./tianxi-bridge-runtime');

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
      return JSON.parse(requestBuffer.toString('utf8') || '{}');
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
      input: requestBody.input,
      instructions: requestBody.instructions,
      stream: Boolean(requestBody.stream),
      metadata: {
        source: 'https-proxy-manager',
        profileId: currentPrepared.profile && currentPrepared.profile.id,
        requestedModel: requestBody.model || '',
        routedModel: currentPrepared.rewriteTo || currentPrepared.model || '',
        tianxi: tianxiRouteMetadata(currentPrepared.route),
      },
      chat: chatBody,
    };
    try {
      const bridge = await bridgeRuntime(payload, currentPrepared.profile);
      clientRes.__diagnostics = {
        protocol: 'tianxi',
        route: currentPrepared.model,
        target: currentPrepared.rewriteTo,
        bridgeUrl: bridge.bridgeUrl,
      };
      if (requestBody.stream) {
        writeTianxiResponsesStream(clientRes, requestBody, bridge.frames, model, {
          fallbackId,
          stableCreated,
        });
      } else {
        writeJsonResponse(
          clientRes,
          buildTianxiResponsesResponse(requestBody, bridge.frames, model, {
            fallbackId,
            stableCreated,
          })
        );
      }
      logRequestEnd(clientReq.method, urlPath, startTime, 200, {
        type: requestBody.stream
          ? 'tianxi_official_responses_bridge_stream'
          : 'tianxi_official_responses_bridge',
      });
    } catch (err) {
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
            : 'Tianxi bridge request failed: ' + (err.message || err),
          bridge_url: err.bridgeUrl,
          diagnostics: sanitizeTianxiBridgeDiagnostics(err.diagnostics),
        },
      });
      logRequestEnd(clientReq.method, urlPath, startTime, statusCode, {
        type: 'tianxi_official_responses_bridge_error',
        bridgeUrl: err.bridgeUrl,
      });
    }
  }

  return {
    handleTianxiOfficialResponses,
  };
}

module.exports = {
  createTianxiOfficialHandlers,
};
