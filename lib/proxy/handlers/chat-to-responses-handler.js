'use strict';
const { isCodexResponsesTarget } = require('../responses-target');
const { parseResponsesUpstreamBody } = require('../responses-upstream-body');
const { assertJsonObjectCompletion } = require('../json-object-output-contract');
const {
  preflightDeepSeekResponsesBody,
  preflightDeepSeekResponsesControls,
} = require('../deepseek-request-contract');

const {
  convertedRateLimitCooldown,
  sendConvertedLocalCooldown,
} = require('./converted-rate-limit');
const { attachClientDiagnostics } = require('./client-diagnostics');
const { withUpstreamTiming } = require('../request-timing');
const { rejectContextOverflow } = require('../context-budget-manager');

function createOpenAIChatToResponsesHandler(ctx, routeHelpers) {
  const {
    https,
    http,
    collectBoundedResponse,
    openAIChatToResponsesRequest,
    openAIResponsesToChatResponse,
    onProxyError,
    onProxyTimeout,
    parseJsonOrSseJson,
    parseProxyBody,
    sendJsonError,
    upstreamRequestOptions,
  } = ctx;
  const {
    boundedResponseContext,
    handleConvertedJsonResponse,
    handleResponsesChatStream,
    proxyErrorContext,
  } = routeHelpers;

  return function handleOpenAIChatToOpenAIResponses(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
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
    ) {
      return;
    }
    let responsesBody;
    try {
      if (Object.prototype.hasOwnProperty.call(parsed, 'context_management')) {
        const error = new TypeError('Chat ingress cannot round-trip provider context items');
        error.code = 'invalid_request_error';
        throw error;
      }
      preflightDeepSeekResponsesControls(prepared, parsed);
      responsesBody = openAIChatToResponsesRequest(
        { ...parsed, model: targetModel },
        {
          codex: isCodexResponsesTarget(prepared.profile, target),
        }
      );
      if (responsesBody.__hpmDiagnostics && typeof responsesBody.__hpmDiagnostics === 'object') {
        responsesBody.__hpmDiagnostics.providerContext = {
          applied: false,
          explicit: false,
          reason: 'converted-protocol-no-roundtrip',
        };
      }
      responsesBody = preflightDeepSeekResponsesBody(prepared, responsesBody);
    } catch (error) {
      const invalidRequest = error?.code === 'invalid_request_error';
      sendJsonError(clientRes, invalidRequest ? 400 : 502, {
        error: {
          type: invalidRequest ? 'invalid_request_error' : 'protocol_conversion_error',
          message: invalidRequest
            ? 'Request contains content or options unsupported by Responses conversion'
            : 'Request could not be converted safely',
        },
      });
      return;
    }
    if (rejectContextOverflow(clientRes, responsesBody, sendJsonError)) return;
    attachClientDiagnostics(
      clientRes,
      prepared,
      targetModel,
      upstreamPath,
      responsesBody,
      'openai',
      'openai-chat'
    );
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/responses', headers, {
        profile: prepared.profile,
        fallbackTimeoutMs: 600000,
      }),
      withUpstreamTiming(clientRes, (proxyRes) => {
        const code = proxyRes.statusCode;
        if (parsed.stream && code >= 200 && code < 300) {
          handleResponsesChatStream({
            clientReq,
            clientRes,
            parsed,
            proxyRes,
            startTime,
            targetModel,
            upstreamPath,
          });
          return;
        }

        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'chat_to_responses',
          (responseBody) => {
            handleConvertedJsonResponse({
              proxyRes,
              clientReq,
              clientRes,
              upstreamPath,
              startTime,
              responseBody,
              upstreamProvider: 'openai',
              upstreamErrorType: 'chat_to_responses_error',
              successType: 'chat_to_responses',
              rateLimitCooldown: convertedRateLimitCooldown(prepared, targetModel),
              conversionLabel: 'OpenAI Chat from Responses',
              conversionLogType: 'openai_responses_to_chat_conversion_error',
              convert: (body) => {
                const payload = parseResponsesUpstreamBody(body, parseJsonOrSseJson, {
                  maxBytes: ctx.maxConversionResponseBytes,
                });
                assertJsonObjectCompletion(
                  payload,
                  payload && Array.isArray(payload.choices) && !payload.output
                    ? 'chat'
                    : 'responses',
                  parsed,
                  { maxBytes: ctx.maxConversionResponseBytes ?? 16 * 1024 * 1024 }
                );
                return payload && Array.isArray(payload.choices) && !payload.output
                  ? payload
                  : openAIResponsesToChatResponse(payload, parsed.model || targetModel);
              },
            });
          },
          boundedResponseContext(clientReq, startTime, 'chat_to_responses')
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
          'openai_responses_to_chat_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  };
}

module.exports = { createOpenAIChatToResponsesHandler };
