'use strict';
const { claudeUsageToOpenAIChatUsage } = require('./protocol-usage-details');
const { createConversionStreamBudget } = require('./conversion-stream-budget');

function buildGeminiChatResponse(data, deps, options) {
  if (data.failureCode) throw new TypeError('Upstream Gemini response did not complete safely');
  const parts =
    typeof deps.filterClaudeCompatibleBlocks === 'function'
      ? deps.filterClaudeCompatibleBlocks(data.parts)
      : data.parts;
  const calls = parts
    .filter((part) => part.type === 'tool_use')
    .map((part) => {
      const input = deps.cleanToolArgs(part.name, part.input);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new TypeError('Invalid upstream Gemini tool arguments');
      return {
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(input) },
      };
    });
  const reasoning = parts
    .filter(data.isThinking)
    .map((part) => part.thinking || part.signature || '')
    .join('');
  const content = parts
    .filter((part) => !data.isThinking(part) && part.type !== 'tool_use')
    .map(data.textForPart)
    .join('');
  const response = {
    id: data.id,
    object: 'chat.completion',
    created: options.stableCreated(data.id),
    model: data.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason:
          data.stopReason === 'max_tokens'
            ? 'length'
            : data.stopReason === 'refusal'
              ? 'content_filter'
              : calls.length
                ? 'tool_calls'
                : 'stop',
      },
    ],
    usage: claudeUsageToOpenAIChatUsage(data.usage),
  };
  createConversionStreamBudget(deps.protocolOptions).consume({}, JSON.stringify(response));
  return response;
}
module.exports = { buildGeminiChatResponse };
