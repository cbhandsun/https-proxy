'use strict';

const DEFAULT_MAX_TOOL_RESULTS = 2;
const MIN_MAX_TOOL_RESULTS = 1;
const MAX_MAX_TOOL_RESULTS = 16;
const MAX_TOOL_RESULT_CHARS = 4000;
const MAX_COLLAPSED_TOOL_RESULTS_CHARS = 12000;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value, defaultValue, min, max) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
  const fallback = Number.isFinite(defaultValue) ? Math.trunc(defaultValue) : min;
  const integer = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function latestUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user') continue;
    return index;
  }
  return -1;
}

function countToolResultsAfterLatestUser(messages) {
  if (!Array.isArray(messages)) return 0;
  const userIndex = latestUserMessageIndex(messages);
  const scoped = userIndex >= 0 ? messages.slice(userIndex + 1) : messages;
  return scoped.filter((message) => isRecord(message) && message.role === 'tool').length;
}

function hasCallableTools(body) {
  return Array.isArray(body && body.tools) && body.tools.length > 0;
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 24)) + '\n[truncated]';
}

function coerceContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && typeof part.text === 'string') return part.text;
        if (isRecord(part) && typeof part.content === 'string') return part.content;
        return stableJson(part);
      })
      .filter(Boolean)
      .join('\n');
  }
  return stableJson(content);
}

function formatToolResult(message, index) {
  const toolCallId =
    typeof message.tool_call_id === 'string' && message.tool_call_id.trim()
      ? ' id=' + truncateText(message.tool_call_id.trim(), 120)
      : '';
  const content = truncateText(coerceContentText(message.content).trim(), MAX_TOOL_RESULT_CHARS);
  return 'Tool result ' + index + toolCallId + ':\n' + (content || '[empty]');
}

function collapseMessagesForFinalAnswer(messages) {
  if (!Array.isArray(messages)) return messages;
  const userIndex = latestUserMessageIndex(messages);
  if (userIndex < 0) return messages;
  const beforeAndLatestUser = messages.slice(0, userIndex + 1);
  const toolResults = messages
    .slice(userIndex + 1)
    .filter((message) => isRecord(message) && message.role === 'tool')
    .map((message, index) => formatToolResult(message, index + 1));
  if (toolResults.length === 0) return messages;

  const collapsed = truncateText(toolResults.join('\n\n'), MAX_COLLAPSED_TOOL_RESULTS_CHARS);
  return [
    ...beforeAndLatestUser,
    {
      role: 'user',
      content: [
        'Tool results are already available for the latest user request.',
        'Answer the user directly from these results. Do not request or call more tools.',
        '',
        collapsed,
      ].join('\n'),
    },
  ];
}

function applyToolLoopGuardToOpenAIChat(body, options = {}) {
  if (!isRecord(body)) return { body, applied: false, toolResultCount: 0 };

  const maxToolResults = boundedInteger(
    options.maxToolResults,
    DEFAULT_MAX_TOOL_RESULTS,
    MIN_MAX_TOOL_RESULTS,
    MAX_MAX_TOOL_RESULTS
  );
  const toolResultCount = countToolResultsAfterLatestUser(body.messages);

  if (!hasCallableTools(body) || toolResultCount < maxToolResults) {
    return { body, applied: false, toolResultCount };
  }

  return {
    body: {
      ...body,
      messages: collapseMessagesForFinalAnswer(body.messages),
      tools: undefined,
      tool_choice: undefined,
    },
    applied: true,
    toolResultCount,
  };
}

module.exports = {
  applyToolLoopGuardToOpenAIChat,
  collapseMessagesForFinalAnswer,
  countToolResultsAfterLatestUser,
};
