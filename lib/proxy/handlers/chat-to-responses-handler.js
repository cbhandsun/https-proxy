'use strict';

const {
  convertedRateLimitCooldown,
  sendConvertedLocalCooldown,
} = require('./converted-rate-limit');
const { attachClientDiagnostics } = require('./client-diagnostics');
const { withUpstreamTiming } = require('../request-timing');

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
    const responsesBody = openAIChatToResponsesRequest({ ...parsed, model: targetModel });
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
                const payload = parseJsonOrSseJson(body);
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
