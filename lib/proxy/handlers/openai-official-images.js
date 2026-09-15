'use strict';

const {
  DEFAULT_OPENAI_IMAGE_RESPONSES_MODEL,
  openAIImageGenerationToResponses,
  parseOpenAIImageGenerationRequest,
  parseOpenAIResponsesImageGenerationPayloads,
  parseOpenAIResponsesImageGenerationResponse,
} = require('../openai-images');
const { sendConversionError } = require('./route-error-utils');

function imageResponsesModelForRoute(route, profile) {
  const configured =
    (route && (route.responsesModel || route.mainModel)) ||
    (profile && (profile.imageResponsesModel || profile.responsesModel));
  return typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : DEFAULT_OPENAI_IMAGE_RESPONSES_MODEL;
}

function createOpenAIOfficialImagesHandler(ctx) {
  const {
    collectBoundedResponse,
    http,
    https,
    logRequestEnd,
    onProxyError,
    onProxyTimeout,
    parseProxyBody,
    proxyErrorContext,
    sendJsonError,
    sendUpstreamError,
    upstreamRequestOptions,
    writeJsonResponse,
  } = ctx;

  return function handleOpenAIImagesToOpenAIOfficialResponses(
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

    const validation = parseOpenAIImageGenerationRequest(parsed);
    if (!validation.ok) {
      writeJsonResponse(clientRes, 400, { error: validation.error });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 400, {
        type: 'openai_official_images_invalid_request',
      });
      return;
    }

    const responsesModel = imageResponsesModelForRoute(prepared.route, prepared.profile);
    const responsesBody = openAIImageGenerationToResponses(validation.request, responsesModel);
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/responses', headers, {
        profile: prepared.profile,
        fallbackTimeoutMs: 600000,
      }),
      (proxyRes) => {
        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'openai_official_images',
          (responseBody) => {
            if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
              sendUpstreamError(
                clientRes,
                proxyRes.statusCode,
                proxyRes.headers,
                responseBody,
                'openai'
              );
              logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, {
                type: 'openai_official_images_error',
              });
              return;
            }
            try {
              const payload = parseOpenAIResponsesImageGenerationPayloads(responseBody);
              const response = parseOpenAIResponsesImageGenerationResponse(
                payload,
                validation.request
              );
              writeJsonResponse(clientRes, 200, response);
              logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
                type: 'openai_official_images',
                imageCount: response.data.length,
              });
            } catch (err) {
              sendConversionError({
                clientReq,
                clientRes,
                upstreamPath,
                startTime,
                err,
                label: 'OpenAI Responses image generation',
                logType: 'openai_official_images_conversion_error',
                sendJsonError,
                logRequestEnd,
              });
            }
          },
          {
            method: clientReq.method,
            startTime,
            tooLargeLogType: 'openai_official_images_response_too_large',
            errorLogType: 'openai_official_images_response_error',
          }
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI image generation'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'OpenAI image generation',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'openai',
          'openai_official_images_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  };
}

module.exports = {
  createOpenAIOfficialImagesHandler,
  imageResponsesModelForRoute,
};
