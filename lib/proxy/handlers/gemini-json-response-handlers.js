'use strict';

const { attachGeminiDiagnostics } = require('./client-diagnostics');
const { sendConversionError } = require('./route-error-utils');

function createGeminiJsonResponseHandlers({
  handleConvertedJsonResponse,
  handleGeminiUpstreamError,
  geminiResponseToClaude,
  geminiResponseToResponses,
  geminiResponseToChat,
  stableCreated,
  buildResponsesResponse,
  rememberResponsesFromBridge,
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
      toolPreambleText,
      geminiBody,
    } = options;
    attachGeminiDiagnostics(
      clientRes,
      options.prepared || {},
      targetModel,
      upstreamPath,
      geminiBody,
      'openai-responses'
    );
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
      requestBodyForDiagnostics: geminiBody,
      convert: (body) => {
        if (
          typeof geminiResponseToResponses === 'function' &&
          typeof buildResponsesResponse === 'function'
        ) {
          const response = geminiResponseToResponses(
            unwrapCodeAssistResponse(parseJsonOrSseJson(body)),
            targetModel,
            claudeBody.tools,
            {
              buildResponse: buildResponsesResponse,
              clientModel: parsed.model || targetModel,
              responsesToolPreambleText: toolPreambleText,
              request: parsed,
            }
          );
          rememberResponsesFromBridge(
            {
              responseState: {
                id: response.id,
                failed: response.status === 'failed',
                completedOutputItems: response.output,
              },
            },
            chatBody
          );
          return response;
        }
        const claudeResponse = geminiResponseToClaude(
          unwrapCodeAssistResponse(parseJsonOrSseJson(body)),
          targetModel,
          claudeBody.tools,
          { responsesToolPreambleText: toolPreambleText }
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
      geminiBody,
    } = options;
    attachGeminiDiagnostics(
      clientRes,
      prepared || {},
      targetModel,
      upstreamPath,
      geminiBody,
      'openai-chat'
    );
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
        requestBodyForDiagnostics: geminiBody,
      });
      return;
    }
    try {
      if (typeof geminiResponseToChat === 'function') {
        const response = geminiResponseToChat(
          unwrapCodeAssistResponse(parseJsonOrSseJson(responseBody)),
          targetModel,
          claudeBody.tools,
          { clientModel: parsed.model || targetModel, stableCreated }
        );
        writeJsonResponse(clientRes, 200, response);
        logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
          type: 'openai_to_gemini',
          usage: response.usage,
        });
        return;
      }
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
