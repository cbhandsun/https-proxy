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

const { parseOpenAIReasoningEffort } = require('../gemini-reasoning');
const { MAX_INLINE_MEDIA_BYTES, inspectOpenAIMultimodalPart } = require('../multimodal-content');

function createRequestValidators({ sendJsonError }) {
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
      if (tool.type === 'function') return false;
      const type = String(tool.type).toLowerCase();
      if (type === 'namespace') return false;
      return !(type === 'web_search' || type.startsWith('web_search_preview'));
    });
    if (!unsupported) return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message:
          'Responses tool type "' +
          unsupported.type +
          '" cannot be converted to Chat, Claude, or Gemini upstreams. Only function tools are supported on converted routes.',
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
            message:
              'Responses input item type "' +
              item.type +
              '" cannot be converted to Chat, Claude, or Gemini upstreams.',
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
              message:
                'Responses content part type "' +
                part.type +
                '" cannot be converted to Chat, Claude, or Gemini upstreams.',
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

  function rejectUnsupportedResponsesStructuredOutput(clientRes, parsed) {
    const format = parsed && ((parsed.text && parsed.text.format) || parsed.response_format);
    if (!format) return false;
    const type = typeof format === 'object' ? format.type : '';
    if (!type || type === 'text') return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message:
          'Structured Responses output format "' +
          type +
          '" cannot be converted to Claude or Gemini upstreams.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesReasoning(_clientRes, _parsed) {
    return false;
  }

  function rejectUnsupportedResponsesConversion(clientRes, parsed, targetProtocol) {
    return (
      rejectUnsupportedResponsesTools(clientRes, parsed) ||
      rejectUnsupportedResponsesInput(clientRes, parsed, targetProtocol)
    );
  }

  function rejectInvalidGeminiReasoning(clientRes, parsed, requestLabel) {
    const reasoning = parseOpenAIReasoningEffort(parsed);
    if (reasoning.valid) return false;
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

  function rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed, targetProtocol) {
    return (
      rejectUnsupportedResponsesConversion(clientRes, parsed, targetProtocol) ||
      rejectUnsupportedResponsesStructuredOutput(clientRes, parsed) ||
      (targetProtocol === 'Gemini' || targetProtocol === 'Claude'
        ? rejectInvalidGeminiReasoning(clientRes, parsed, 'Responses')
        : rejectUnsupportedResponsesReasoning(clientRes, parsed))
    );
  }

  function rejectUnsupportedOpenAIChatNonOpenAIConversion(clientRes, parsed, targetProtocol) {
    const unsupportedTool =
      parsed && Array.isArray(parsed.tools)
        ? parsed.tools.find((tool) => tool && tool.type && tool.type !== 'function')
        : null;
    if (unsupportedTool) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message:
            'OpenAI Chat tool type "' +
            unsupportedTool.type +
            '" cannot be converted to ' +
            targetProtocol +
            ' upstreams. Only function tools are supported on converted routes.',
        },
      });
      return true;
    }

    const messages = parsed && Array.isArray(parsed.messages) ? parsed.messages : [];
    for (const message of messages) {
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

    const responseFormat = parsed && parsed.response_format;
    const responseFormatType =
      responseFormat && typeof responseFormat === 'object' ? responseFormat.type : '';
    if (responseFormatType && responseFormatType !== 'text') {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message:
            'OpenAI Chat response_format "' +
            responseFormatType +
            '" cannot be converted to ' +
            targetProtocol +
            ' upstreams.',
        },
      });
      return true;
    }

    const reasoning = parseOpenAIReasoningEffort(parsed);
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
