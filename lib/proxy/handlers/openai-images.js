'use strict';

const {
  openAIImageGenerationResponseFromGemini,
  openAIImageGenerationToGemini,
  parseOpenAIImageGenerationRequest,
  parseGeminiImageResponse,
} = require('../openai-images');
const { buildGeminiProxyRequestOptions, sendGeminiLocalCooldown } = require('./route-gemini-utils');
const { sendConversionError } = require('./route-error-utils');

function createOpenAIImagesHandler(ctx) {
  const {
    boundedResponseContext,
    codeAssistGenerateRequest,
    codeAssistUserAgent,
    collectBoundedResponse,
    geminiGeneratePath,
    geminiInlineImageToClaudeBlock,
    getGeminiCooldown,
    handleGeminiUpstreamError,
    http,
    https,
    log,
    logRequestEnd,
    onProxyError,
    onProxyTimeout,
    parseProxyBody,
    proxyErrorContext,
    sendGeminiRateLimit,
    sendJsonError,
    shouldUseCodeAssistUpstream,
    unwrapCodeAssistResponse,
    writeJsonResponse,
  } = ctx;

  return function handleOpenAIImagesToGemini(
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
      sendJsonError(clientRes, 400, { error: validation.error });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 400, {
        type: 'openai_images_invalid_request',
      });
      return;
    }

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : validation.request.model;
    const cooldown = getGeminiCooldown(prepared.profile && prepared.profile.id, targetModel);
    if (
      sendGeminiLocalCooldown({
        clientReq,
        clientRes,
        upstreamPath,
        startTime,
        targetModel,
        cooldown,
        log,
        sendGeminiRateLimit,
      })
    ) {
      return;
    }

    const geminiBody = openAIImageGenerationToGemini(validation.request);
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    const codeAssist = useCodeAssist
      ? codeAssistGenerateRequest(prepared, geminiBody, targetModel, false)
      : null;
    const requestBody = Buffer.from(JSON.stringify(useCodeAssist ? codeAssist.body : geminiBody));
    const path = useCodeAssist
      ? codeAssist.target.pathname + codeAssist.target.search
      : geminiGeneratePath(target.path, targetModel, false);
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
    };
    if (useCodeAssist) headers['user-agent'] = codeAssistUserAgent();
    if (apiKey) {
      if (String(apiKey).startsWith('ya29.')) headers.authorization = `Bearer ${apiKey}`;
      else headers['x-goog-api-key'] = apiKey;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      buildGeminiProxyRequestOptions({
        target,
        useCodeAssist,
        codeAssist,
        path,
        headers,
      }),
      (proxyRes) => {
        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'openai_images_to_gemini',
          (responseBody) => {
            if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
              handleGeminiUpstreamError({
                proxyRes,
                clientReq,
                clientRes,
                prepared,
                upstreamPath,
                startTime,
                responseBody,
                targetModel,
                requestEndType: 'openai_images_to_gemini_error',
              });
              return;
            }
            try {
              const payload = parseGeminiImageResponse(responseBody, unwrapCodeAssistResponse);
              const response = openAIImageGenerationResponseFromGemini(
                payload,
                validation.request,
                geminiInlineImageToClaudeBlock
              );
              writeJsonResponse(clientRes, 200, response);
              logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
                type: 'openai_images_to_gemini',
                imageCount: response.data.length,
              });
            } catch (err) {
              sendConversionError({
                clientReq,
                clientRes,
                upstreamPath,
                startTime,
                err,
                label: 'Gemini image response',
                logType: 'openai_images_to_gemini_conversion_error',
                sendJsonError,
                logRequestEnd,
              });
            }
          },
          boundedResponseContext(clientReq, startTime, 'openai_images_to_gemini')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Gemini image generation'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'Gemini image generation',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'gemini',
          'openai_images_to_gemini_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  };
}

const { createOpenAIImageJobHandlers } = require('./openai-image-jobs');
const { createOpenAIOfficialImagesHandler } = require('./openai-official-images');

function createRouteImageHandlers(ctx, helpers) {
  const handleOpenAIImagesToGemini = createOpenAIImagesHandler({
    ...ctx,
    ...helpers,
  });
  const handleOpenAIImagesToOpenAIOfficialResponses = createOpenAIOfficialImagesHandler({
    ...ctx,
    proxyErrorContext: helpers.proxyErrorContext,
  });
  const { handleOpenAIImageJobControl, handleOpenAIImageJobCreate, _imageJobStore } =
    createOpenAIImageJobHandlers(ctx);
  return {
    handleOpenAIImagesToGemini,
    handleOpenAIImagesToOpenAIOfficialResponses,
    handleOpenAIImageJobControl,
    handleOpenAIImageJobCreate,
    _imageJobStore,
  };
}

module.exports = { createOpenAIImagesHandler, createRouteImageHandlers };
