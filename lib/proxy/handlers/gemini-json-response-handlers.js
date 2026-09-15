'use strict';

const { sendConversionError } = require('./route-error-utils');

function createGeminiJsonResponseHandlers({
  handleConvertedJsonResponse,
  handleGeminiUpstreamError,
  geminiResponseToClaude,
  claudeResponseToOpenAIChat,
  openAIChatToResponses,
  rememberResponsesFromChatResponse,
  unwrapCodeAssistResponse,
  parseJsonOrSseJson,
  writeJsonResponse,
  logRequestEnd,
  sendJsonError,
}) {
  function handleResponsesToGeminiJson(options) {
    const {
      proxyRes,
      clientReq,
      clientRes,
      upstreamPath,
      startTime,
      responseBody,
      targetModel,
      claudeBody,
      parsed,
      chatBody,
    } = options;
    handleConvertedJsonResponse({
      proxyRes,
      clientReq,
      clientRes,
      upstreamPath,
      startTime,
      responseBody,
      upstreamProvider: 'gemini',
      upstreamErrorType: 'responses_to_gemini_error',
      successType: 'responses_to_gemini',
      conversionLabel: 'OpenAI Responses to Gemini',
      conversionLogType: 'responses_to_gemini_conversion_error',
      convert: (body) => {
        const claudeResponse = geminiResponseToClaude(
          unwrapCodeAssistResponse(parseJsonOrSseJson(body)),
          targetModel,
          claudeBody.tools
        );
        const chatResponse = claudeResponseToOpenAIChat(
          claudeResponse,
          parsed.model || targetModel
        );
        const response = openAIChatToResponses(chatResponse, parsed.model || targetModel, parsed);
        rememberResponsesFromChatResponse(response, chatBody, chatResponse);
        return response;
      },
    });
  }

  function handleOpenAIChatToGeminiJson(options) {
    const {
      proxyRes,
      clientReq,
      clientRes,
      prepared,
      upstreamPath,
      startTime,
      responseBody,
      targetModel,
      claudeBody,
      parsed,
    } = options;
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
        requestEndType: 'openai_to_gemini_error',
      });
      return;
    }
    try {
      const claudeResponse = geminiResponseToClaude(
        unwrapCodeAssistResponse(parseJsonOrSseJson(responseBody)),
        targetModel,
        claudeBody.tools
      );
      const openAIResponse = claudeResponseToOpenAIChat(
        claudeResponse,
        parsed.model || targetModel
      );
      writeJsonResponse(clientRes, 200, openAIResponse);
      logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
        type: 'openai_to_gemini',
        usage: claudeResponse.usage,
      });
    } catch (err) {
      sendConversionError({
        clientReq,
        clientRes,
        upstreamPath,
        startTime,
        err,
        label: 'Gemini response',
        logType: 'openai_to_gemini_conversion_error',
        sendJsonError,
        logRequestEnd,
      });
    }
  }

  return { handleOpenAIChatToGeminiJson, handleResponsesToGeminiJson };
}

module.exports = { createGeminiJsonResponseHandlers };
