/**
 * 协议转换前的请求校验器
 *
 * 当客户端调用 OpenAI Responses / Chat Completions 但上游是 Claude / Gemini 时,
 * 需要在转换前拒绝那些无法在 Claude/Gemini 上表达的字段(structured output、
 * reasoning、自定义 tool 类型等),返回 400 + 明确错误。
 *
 * 提取自 handlers.js,所有函数为纯函数(仅依赖 sendJsonError)。
 */
'use strict';
const { rejectConvertedParallelTools } = require('../converted-parallel-tools');
const { validateConvertedRequestScalars } = require('../converted-request-scalars');
const { convertedOutputFormat } = require('../converted-output-format');
const { convertedServiceTier } = require('../converted-service-tier');
const { parseResponsesHistoryPolicy } = require('../responses-history-policy');
const { validateResponsesEndpointOptions } = require('../responses-endpoint-options');
const { validateConvertedFunctionTools } = require('../function-tool-contract');
const { validateChatMessages } = require('../responses-request-options');
const { chatPartToGemini, validateGeminiChatHistory } = require('../gemini-chat-history');

const {
  parseOpenAIReasoningEffort,
  validateClaudeReasoningOutputLimit,
  geminiThinkingConfigFromOpenAI,
} = require('../gemini-reasoning');
const { MAX_INLINE_MEDIA_BYTES, inspectOpenAIMultimodalPart } = require('../multimodal-content');

function createRequestValidators({ sendJsonError }) {
  function rejectInvalidScalars(clientRes, parsed, targetProtocol, targetModel) {
    try {
      validateConvertedRequestScalars(parsed, targetProtocol);
      if (targetProtocol === 'Claude') validateClaudeReasoningOutputLimit(parsed, targetModel);
      convertedServiceTier(parsed.service_tier, 'openai', targetProtocol);
      return false;
    } catch (error) {
      if (error.code !== 'invalid_request_error') throw error;
      sendJsonError(clientRes, 400, {
        error: { type: 'invalid_request_error', message: error.message },
      });
      return true;
    }
  }
  function rejectInvalidFunctionTools(clientRes, parsed, shape, targetProtocol) {
    try {
      validateConvertedFunctionTools(parsed?.tools, shape, targetProtocol);
      return false;
    } catch (error) {
      sendJsonError(clientRes, 400, {
        error: { type: 'invalid_request_error', message: error.message },
      });
      return true;
    }
  }
  function rejectInvalidMultimodalPart(clientRes, part, requestLabel, targetProtocol) {
    const media = inspectOpenAIMultimodalPart(part);
    if (!media.recognized) return false;
    if (media.kind !== 'image' && targetProtocol !== 'Gemini') {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message:
            requestLabel +
            ' ' +
            media.kind +
            ' input cannot be converted to ' +
            (targetProtocol || 'this') +
            ' upstream.',
        },
      });
      return true;
    }
    if (!targetProtocol || media.ok) return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message:
          requestLabel +
          ' ' +
          media.kind +
          ' input is invalid: ' +
          media.error +
          '. Only inline base64 media up to ' +
          Math.floor(MAX_INLINE_MEDIA_BYTES / 1024 / 1024) +
          ' MiB is supported for ' +
          targetProtocol +
          ' conversion.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesTools(clientRes, parsed) {
    const tools = [];
    if (parsed && Array.isArray(parsed.tools)) {
      tools.push(...parsed.tools);
    }
    if (parsed && Array.isArray(parsed.input)) {
      for (const item of parsed.input) {
        if (item && item.type === 'additional_tools' && Array.isArray(item.tools)) {
          tools.push(...item.tools);
        }
      }
    }
    if (tools.length === 0) return false;
    const unsupported = tools.find((tool) => {
      if (!tool || !tool.type) return false;
      if (typeof tool.type !== 'string') return true;
      if (tool.type === 'function') return false;
      const type = String(tool.type).toLowerCase();
      if (type === 'namespace') return false;
      return !(type === 'web_search' || type.startsWith('web_search_preview'));
    });
    if (!unsupported) return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Responses tool type is unsupported by this conversion target.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesInput(clientRes, parsed, targetProtocol) {
    const input = parsed && parsed.input;
    const items = Array.isArray(input) ? input : [];
    const supportedItemTypes = new Set([
      'message',
      'function_call',
      'function_call_output',
      'tool_call',
      'call',
      'custom_tool_call',
      'custom_tool_call_output',
      'tool_result',
      'thought',
      'reasoning',
      'web_search_call',
      'web_search_result',
      'web_search_call_output',
      'web_search',
      'additional_tools',
    ]);
    const supportedContentTypes = new Set([
      'input_text',
      'output_text',
      'text',
      'input_image',
      'web_search_call',
      'web_search_result',
      'thought',
      'reasoning',
    ]);
    if (targetProtocol === 'Gemini') {
      supportedContentTypes.add('image_url');
      supportedContentTypes.add('input_audio');
      supportedContentTypes.add('audio_url');
      supportedContentTypes.add('input_video');
      supportedContentTypes.add('video_url');
      supportedContentTypes.add('thought');
      supportedContentTypes.add('reasoning');
    }
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item === 'string') continue;
      if (item.type && !supportedItemTypes.has(item.type)) {
        sendJsonError(clientRes, 400, {
          error: {
            type: 'invalid_request_error',
            message: 'Responses input item type is unsupported by this conversion target.',
          },
        });
        return true;
      }
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          part.type &&
          !supportedContentTypes.has(part.type)
        ) {
          sendJsonError(clientRes, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'Responses content part type is unsupported by this conversion target.',
            },
          });
          return true;
        }
        if (
          !targetProtocol &&
          part &&
          typeof part === 'object' &&
          part.type === 'input_image' &&
          !(part.image_url || part.url)
        ) {
          sendJsonError(clientRes, 400, {
            error: {
              type: 'invalid_request_error',
              message:
                'Responses input_image parts without image_url cannot be converted to Chat upstreams.',
            },
          });
          return true;
        }
        if (
          part &&
          typeof part === 'object' &&
          rejectInvalidMultimodalPart(clientRes, part, 'Responses', targetProtocol)
        )
          return true;
      }
    }
    return false;
  }

  function rejectInvalidOutputFormat(
    clientRes,
    parsed,
    shape,
    targetProtocol,
    targetModel,
    options
  ) {
    try {
      convertedServiceTier(parsed.service_tier, 'openai', targetProtocol, options);
      convertedOutputFormat(parsed, shape, targetProtocol, targetModel || parsed?.model, options);
      return false;
    } catch (error) {
      if (error.code !== 'invalid_request_error') throw error;
      sendJsonError(clientRes, 400, {
        error: { type: 'invalid_request_error', message: error.message },
      });
      return true;
    }
  }
  function rejectUnsupportedResponsesStructuredOutput(
    clientRes,
    parsed,
    targetProtocol = 'Claude',
    targetModel,
    options
  ) {
    return rejectInvalidOutputFormat(
      clientRes,
      parsed,
      'responses',
      targetProtocol,
      targetModel,
      options
    );
  }

  function rejectUnsupportedResponsesReasoning(_clientRes, _parsed) {
    return false;
  }

  function rejectUnsupportedResponsesConversion(clientRes, parsed, targetProtocol, options) {
    try {
      parseResponsesHistoryPolicy(parsed);
      validateResponsesEndpointOptions(parsed, targetProtocol || 'Chat', undefined, options);
      if (!targetProtocol || targetProtocol === 'Chat')
        convertedOutputFormat(parsed, 'responses', 'Chat', parsed.model);
    } catch (error) {
      if (error.code !== 'invalid_request_error') throw error;
      sendJsonError(clientRes, 400, {
        error: { type: 'invalid_request_error', message: error.message },
      });
      return true;
    }
    return (
      rejectUnsupportedResponsesTools(clientRes, parsed) ||
      rejectInvalidFunctionTools(clientRes, parsed, 'responses', targetProtocol) ||
      rejectUnsupportedResponsesInput(clientRes, parsed, targetProtocol)
    );
  }

  function rejectInvalidGeminiReasoning(clientRes, parsed, requestLabel, targetModel) {
    const reasoning = parseOpenAIReasoningEffort(parsed);
    if (reasoning.valid) {
      if (targetModel) {
        try {
          geminiThinkingConfigFromOpenAI(parsed, targetModel);
        } catch (error) {
          if (error.code !== 'invalid_request_error') throw error;
          sendJsonError(clientRes, 400, { error: { type: error.code, message: error.message } });
          return true;
        }
      }
      return false;
    }
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message:
          requestLabel +
          ' reasoning effort must be one of: none, minimal, low, medium, high, xhigh.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesNonOpenAIConversion(
    clientRes,
    parsed,
    targetProtocol,
    targetModel,
    options
  ) {
    return (
      rejectInvalidScalars(clientRes, parsed, targetProtocol, targetModel) ||
      rejectConvertedParallelTools(clientRes, parsed, targetProtocol, sendJsonError) ||
      rejectUnsupportedResponsesConversion(clientRes, parsed, targetProtocol) ||
      rejectUnsupportedResponsesStructuredOutput(
        clientRes,
        parsed,
        targetProtocol,
        targetModel,
        options
      ) ||
      (targetProtocol === 'Gemini' || targetProtocol === 'Claude'
        ? rejectInvalidGeminiReasoning(
            clientRes,
            parsed,
            'Responses',
            targetProtocol === 'Gemini' ? targetModel || parsed.model : null
          )
        : rejectUnsupportedResponsesReasoning(clientRes, parsed))
    );
  }

  function rejectUnsupportedOpenAIChatNonOpenAIConversion(
    clientRes,
    parsed,
    targetProtocol,
    targetModel,
    options
  ) {
    if (rejectInvalidScalars(clientRes, parsed, targetProtocol, targetModel)) return true;
    if (rejectConvertedParallelTools(clientRes, parsed, targetProtocol, sendJsonError)) return true;
    const unsupportedTool =
      parsed && Array.isArray(parsed.tools)
        ? parsed.tools.find((tool) => tool && tool.type && tool.type !== 'function')
        : null;
    if (unsupportedTool) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'OpenAI Chat tool type is unsupported by this conversion target.',
        },
      });
      return true;
    }

    if (rejectInvalidFunctionTools(clientRes, parsed, 'chat', targetProtocol)) return true;
    if (targetProtocol === 'Gemini') {
      try {
        validateChatMessages(parsed?.messages, { validatePart: chatPartToGemini });
        validateGeminiChatHistory(parsed?.messages || []);
      } catch {
        sendJsonError(clientRes, 400, {
          error: {
            type: 'invalid_request_error',
            message:
              'Invalid Chat history for Gemini conversion. Check roles, tool IDs, arguments and inline media.',
          },
        });
        return true;
      }
    }
    const messages = parsed && Array.isArray(parsed.messages) ? parsed.messages : [];
    for (const message of messages) {
      if (targetProtocol === 'Gemini') continue; // Already validated with its native part contract.
      const content = message && Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          rejectInvalidMultimodalPart(clientRes, part, 'OpenAI Chat', targetProtocol)
        )
          return true;
      }
    }

    if (rejectInvalidOutputFormat(clientRes, parsed, 'chat', targetProtocol, targetModel, options))
      return true;

    const reasoning = parseOpenAIReasoningEffort(parsed);
    if (
      targetProtocol === 'Gemini' &&
      rejectInvalidGeminiReasoning(clientRes, parsed, 'OpenAI Chat', targetModel || parsed.model)
    )
      return true;
    if ((targetProtocol === 'Gemini' || targetProtocol === 'Claude') && !reasoning.valid) {
      return rejectInvalidGeminiReasoning(clientRes, parsed, 'OpenAI Chat');
    }
    if (targetProtocol !== 'Gemini' && targetProtocol !== 'Claude' && reasoning.present) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message:
            'OpenAI Chat reasoning options cannot be converted to ' +
            targetProtocol +
            ' upstreams.',
        },
      });
      return true;
    }

    return false;
  }

  return {
    rejectInvalidFunctionTools,
    rejectUnsupportedResponsesTools,
    rejectUnsupportedResponsesInput,
    rejectUnsupportedResponsesStructuredOutput,
    rejectUnsupportedResponsesReasoning,
    rejectUnsupportedResponsesConversion,
    rejectUnsupportedResponsesNonOpenAIConversion,
    rejectInvalidGeminiReasoning,
    rejectUnsupportedOpenAIChatNonOpenAIConversion,
  };
}

module.exports = { createRequestValidators };
