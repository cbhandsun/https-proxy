'use strict';
const { createConversionStreamBudget } = require('./conversion-stream-budget');
const { openAIChatUsageToClaudeUsage } = require('./protocol-usage-details');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function claudeJsonStopReason(reason, hasTools) {
  if (reason === 'content_filter') throw new TypeError('Upstream response was filtered');
  if (reason === 'length') return 'max_tokens';
  if (!['stop', 'tool_calls'].includes(reason))
    throw new TypeError('Upstream response did not complete safely');
  return hasTools || reason === 'tool_calls' ? 'tool_use' : 'end_turn';
}

function createResponsesClaudeResponseConverter({
  decodeResponsesResponse,
  toolToClaude,
  protocolOptions,
}) {
  return function responsesResponseToClaude(payload, model) {
    try {
      if (
        !record(payload) ||
        !['completed', 'incomplete'].includes(payload.status) ||
        payload.error ||
        !Array.isArray(payload.output)
      )
        throw new TypeError('Invalid upstream Responses response');
      const budget = createConversionStreamBudget(protocolOptions);
      budget.consume({}, JSON.stringify(payload));
      const incomplete = payload.status === 'incomplete';
      if (
        incomplete &&
        (!record(payload.incomplete_details) ||
          payload.incomplete_details.reason !== 'max_output_tokens')
      )
        throw new TypeError('Upstream response did not complete safely');
      const tools = {};
      for (const item of payload.output) {
        if (!record(item) || typeof item.type !== 'string')
          throw new TypeError('Invalid upstream Responses item');
        if (
          item.status != null &&
          !['completed', 'incomplete', 'in_progress'].includes(item.status)
        )
          throw new TypeError('Invalid upstream Responses item status');
        if (!incomplete && item.status && item.status !== 'completed')
          throw new TypeError('Unfinished upstream Responses item');
        if (item.type === 'message') {
          if (item.role !== 'assistant') throw new TypeError('Invalid upstream Responses role');
          if (typeof item.content !== 'string') {
            if (!Array.isArray(item.content))
              throw new TypeError('Invalid upstream Responses content');
            for (const part of item.content) {
              if (
                !record(part) ||
                !['output_text', 'text'].includes(part.type) ||
                typeof part.text !== 'string'
              )
                throw new TypeError('Unsupported upstream Responses content');
            }
          }
        } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          if (
            (item.name != null && (typeof item.name !== 'string' || !item.name.trim())) ||
            (item.call_id != null && (typeof item.call_id !== 'string' || !item.call_id)) ||
            (item.id != null && (typeof item.id !== 'string' || !item.id))
          )
            throw new TypeError('Invalid upstream Responses tool');
          budget.addTool(tools);
          const input = item.type === 'custom_tool_call' ? item.input : item.arguments;
          if (
            item.type === 'custom_tool_call' &&
            input !== undefined &&
            typeof input !== 'string' &&
            !record(input)
          )
            throw new TypeError('Invalid upstream Responses custom tool input');
          budget.appendArguments(
            {},
            typeof input === 'string' ? input : JSON.stringify(input ?? {})
          );
          if (!incomplete && item.type === 'function_call' && input === null)
            throw new TypeError('Invalid upstream Responses tool arguments');
        } else if (item.type === 'reasoning') {
          for (const key of ['text', 'thought'])
            if (item[key] != null && typeof item[key] !== 'string')
              throw new TypeError('Invalid upstream Responses reasoning');
          for (const key of ['summary', 'content']) {
            const parts = item[key];
            if (parts == null || typeof parts === 'string') continue;
            const entries = Array.isArray(parts) ? parts : [parts];
            for (const part of entries)
              if (typeof part !== 'string' && (!record(part) || typeof part.text !== 'string'))
                throw new TypeError('Invalid upstream Responses reasoning');
          }
        } else if (!['web_search_call', 'file_search_call'].includes(item.type)) {
          throw new TypeError('Unsupported upstream Responses item');
        }
      }
      const normalized = decodeResponsesResponse(
        incomplete
          ? {
              ...payload,
              output: payload.output.filter(
                (item) => !['function_call', 'custom_tool_call'].includes(item.type)
              ),
            }
          : payload,
        model
      );
      const content = [];
      if (
        !incomplete &&
        normalized.toolCalls.length !==
          payload.output.filter((item) => ['function_call', 'custom_tool_call'].includes(item.type))
            .length
      )
        throw new TypeError('Unresolved upstream Responses tool');
      if (normalized.reasoning)
        content.push({
          type: 'thinking',
          thinking: normalized.reasoning,
          signature: 'deepseek-reasoning',
        });
      if (normalized.text) content.push({ type: 'text', text: normalized.text });
      for (const tool of normalized.toolCalls) {
        const block = toolToClaude(tool);
        if (!block || !record(block.input) || typeof block.name !== 'string' || !block.name.trim())
          throw new TypeError('Invalid upstream Responses tool');
        content.push(block);
        budget.appendArguments({}, JSON.stringify(block.input));
      }
      const response = {
        id: normalized.id,
        type: 'message',
        role: 'assistant',
        model: normalized.model,
        content,
        stop_reason: claudeJsonStopReason(normalized.finishReason, normalized.toolCalls.length > 0),
        stop_sequence: null,
        usage: openAIChatUsageToClaudeUsage(normalized.usage),
      };
      budget.consume({}, JSON.stringify(response));
      return response;
    } catch {
      throw new TypeError('Upstream Responses response could not be converted safely');
    }
  };
}
module.exports = { createResponsesClaudeResponseConverter, claudeJsonStopReason };
