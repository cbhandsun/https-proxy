'use strict';

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
}

function createOpenAIResponsesToChatHandler(ctx, routeHelpers) {
  const {
    https,
    http,
    CORS_HEADERS,
    sendJsonError,
    logRequestEnd,
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
    maxConversionResponseBytes = 16 * 1024 * 1024,
  } = ctx;
  const { boundedResponseContext, handleConvertedJsonResponse, proxyErrorContext } = routeHelpers;

  return function handleOpenAIResponsesToOpenAIChat(
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
    if (rejectUnsupportedResponsesConversion(clientRes, parsed)) return;
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
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    const clientWantsStream = chatBody.stream === true;
    if (shouldApplyConvertedRateLimitCooldown(prepared)) chatBody.stream = true;
    prepareConvertedChatBody(prepared, chatBody, targetModel);
    const requestBody = Buffer.from(JSON.stringify(chatBody));
    const { headers, audit } = createConvertedChatRequest(prepared, target, apiKey, requestBody);
    if (clientRes.__auditData) clientRes.__auditData.upstream = audit;
    const proxyReq = (target.protocol === 'https:' ? https : http).request(
      upstreamRequestOptions(target, target.path + '/chat/completions', headers),
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
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
          proxyRes.on('data', (chunk) =>
            processOpenAIChatSseChunkToResponses(
              clientRes,
              chunk.toString('utf8'),
              bridge.responseState
            )
          );
          proxyRes.on('end', () => {
            bridge.flush();
            rememberResponsesFromBridge(bridge, chatBody);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'responses_to_chat_stream',
            });
          });
          return;
        }
        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'responses_to_chat',
          (responseBody) => {
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
  };
}

module.exports = {
  createOpenAIResponsesToChatHandler,
};
