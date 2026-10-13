'use strict';
const { resolveCreatedTimestamp } = require('./ids');
const { convertUsageDetails } = require('./protocol-usage-details');
const { responsesFinishReason } = require('./protocol-terminal');
const { toolArgumentsComplete } = require('./protocol-tool-completion');

function createResponsesResponseConverter({
  fallbackId,
  stableCreated,
  resolveToolNameInference,
  messageNormalization,
}) {
  function responsesToolCallToChatToolCall(item, existingArguments) {
    if (!item || typeof item !== 'object') return null;
    if (item.status && item.status !== 'completed') return null;
    const isCustomToolCall = item.type === 'custom_tool_call';
    if (!isCustomToolCall && item.type !== 'function_call') return null;
    const args = isCustomToolCall
      ? typeof item.input === 'string'
        ? JSON.stringify({ input: item.input })
        : item.input && typeof item.input === 'object' && !Array.isArray(item.input)
          ? JSON.stringify(item.input)
          : JSON.stringify({ input: item.input == null ? '' : String(item.input) })
      : item.arguments != null
        ? item.arguments
        : existingArguments;
    let parsedArgs = {};
    if (typeof args === 'string' && args.trim()) {
      try {
        parsedArgs = JSON.parse(args);
      } catch (err) {}
    } else if (args && typeof args === 'object') {
      parsedArgs = args;
    }
    const name = item.name || resolveToolNameInference(parsedArgs);
    if (!name) return null;
    if (!isCustomToolCall && !toolArgumentsComplete({ function: { name, arguments: args } })) {
      const error = new TypeError('Upstream Responses tool arguments are incomplete or invalid');
      error.code = 'upstream_stream_invalid_tool_arguments';
      throw error;
    }
    const id = item.call_id || item.id || fallbackId('call', { name, arguments: args || {} });
    return {
      id,
      type: 'function',
      function: {
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
      },
    };
  }

  function decodeResponsesResponse(payload, model) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.status === 'failed' || payload.error) {
      throw new TypeError('Upstream Responses generation failed');
    }

    const output = Array.isArray(payload.output) ? payload.output : [];

    let assistantText = '';
    let assistantReasoning = '';
    const toolCalls = [];

    for (const item of output) {
      if (!item) continue;
      if (item.type === 'reasoning') {
        const reasoningText = messageNormalization.reasoningSummaryText(item);
        if (reasoningText) {
          assistantReasoning += reasoningText;
        }
      } else if (item.type === 'message' && item.role === 'assistant') {
        if (typeof item.content === 'string') {
          assistantText += item.content;
        } else if (Array.isArray(item.content)) {
          const text = item.content
            .filter((p) => p && (p.type === 'output_text' || p.type === 'text'))
            .map((p) => p.text || '')
            .join('');
          assistantText += text;
        }
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const toolCall = responsesToolCallToChatToolCall(item);
        if (toolCall) toolCalls.push(toolCall);
      }
    }

    const finishReason = responsesFinishReason(payload, toolCalls.length > 0);

    const usage = payload.usage
      ? {
          prompt_tokens: payload.usage.input_tokens || 0,
          completion_tokens: payload.usage.output_tokens || 0,
          total_tokens:
            payload.usage.total_tokens ||
            (payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0),
          ...convertUsageDetails(payload.usage, false),
        }
      : undefined;

    const id = payload.id
      ? payload.id.replace(/^resp/, 'chatcmpl')
      : fallbackId('chatcmpl', { model, output });

    return {
      id,
      created: resolveCreatedTimestamp(payload.created_at, () => stableCreated({ model, output })),
      model: model || payload.model,
      text: assistantText,
      reasoning: assistantReasoning,
      toolCalls,
      finishReason,
      usage,
    };
  }

  function openAIResponsesToChatResponse(payload, model) {
    const value = decodeResponsesResponse(payload, model);
    if (!value) return null;
    const message = { role: 'assistant', content: value.text || null };
    if (value.reasoning) message.reasoning_content = value.reasoning;
    if (value.toolCalls.length) message.tool_calls = value.toolCalls;
    return {
      id: value.id,
      object: 'chat.completion',
      created: value.created,
      model: value.model,
      choices: [{ index: 0, message, finish_reason: value.finishReason }],
      usage: value.usage,
    };
  }
  return {
    responsesToolCallToChatToolCall,
    openAIResponsesToChatResponse,
    decodeResponsesResponse,
  };
}
module.exports = { createResponsesResponseConverter };
