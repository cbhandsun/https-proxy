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

function createRequestValidators({ sendJsonError }) {
  function rejectUnsupportedResponsesTools(clientRes, parsed) {
    if (!parsed || !Array.isArray(parsed.tools)) return false;
    const unsupported = parsed.tools.find((tool) => tool && tool.type && tool.type !== 'function');
    if (!unsupported) return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Responses tool type "' + unsupported.type + '" cannot be converted to Chat, Claude, or Gemini upstreams. Only function tools are supported on converted routes.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesInput(clientRes, parsed) {
    const input = parsed && parsed.input;
    const items = Array.isArray(input) ? input : [];
    const supportedItemTypes = new Set(['message', 'function_call', 'function_call_output']);
    const supportedContentTypes = new Set(['input_text', 'output_text', 'text', 'input_image']);
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item === 'string') continue;
      if (item.type && !supportedItemTypes.has(item.type)) {
        sendJsonError(clientRes, 400, {
          error: {
            type: 'invalid_request_error',
            message: 'Responses input item type "' + item.type + '" cannot be converted to Chat, Claude, or Gemini upstreams.',
          },
        });
        return true;
      }
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (part && typeof part === 'object' && part.type && !supportedContentTypes.has(part.type)) {
          sendJsonError(clientRes, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'Responses content part type "' + part.type + '" cannot be converted to Chat, Claude, or Gemini upstreams.',
            },
          });
          return true;
        }
        if (part && typeof part === 'object' && part.type === 'input_image' && !(part.image_url || part.url)) {
          sendJsonError(clientRes, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'Responses input_image parts without image_url cannot be converted to Chat, Claude, or Gemini upstreams.',
            },
          });
          return true;
        }
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
        message: 'Structured Responses output format "' + type + '" cannot be converted to Claude or Gemini upstreams.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesReasoning(clientRes, parsed) {
    if (!parsed || !parsed.reasoning) return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Responses reasoning options cannot be converted to Claude or Gemini upstreams.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesConversion(clientRes, parsed) {
    return rejectUnsupportedResponsesTools(clientRes, parsed)
      || rejectUnsupportedResponsesInput(clientRes, parsed);
  }

  function rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed) {
    return rejectUnsupportedResponsesConversion(clientRes, parsed)
      || rejectUnsupportedResponsesStructuredOutput(clientRes, parsed)
      || rejectUnsupportedResponsesReasoning(clientRes, parsed);
  }

  function rejectUnsupportedOpenAIChatNonOpenAIConversion(clientRes, parsed, targetProtocol) {
    const unsupportedTool = parsed && Array.isArray(parsed.tools)
      ? parsed.tools.find((tool) => tool && tool.type && tool.type !== 'function')
      : null;
    if (unsupportedTool) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'OpenAI Chat tool type "' + unsupportedTool.type + '" cannot be converted to ' + targetProtocol + ' upstreams. Only function tools are supported on converted routes.',
        },
      });
      return true;
    }

    const responseFormat = parsed && parsed.response_format;
    const responseFormatType = responseFormat && typeof responseFormat === 'object' ? responseFormat.type : '';
    if (responseFormatType && responseFormatType !== 'text') {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'OpenAI Chat response_format "' + responseFormatType + '" cannot be converted to ' + targetProtocol + ' upstreams.',
        },
      });
      return true;
    }

    if (parsed && (parsed.reasoning || parsed.reasoning_effort)) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'OpenAI Chat reasoning options cannot be converted to ' + targetProtocol + ' upstreams.',
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
    rejectUnsupportedOpenAIChatNonOpenAIConversion,
  };
}

module.exports = { createRequestValidators };
