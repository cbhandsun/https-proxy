'use strict';

const DEFAULT_KEEP_RECENT_TURNS = 2;
const DEFAULT_MAX_TOOL_CHARS = 800;
const DEFAULT_HEAD_CHARS = 300;
const DEFAULT_TAIL_CHARS = 200;
const DEFAULT_MAX_HISTORICAL_MESSAGE_CHARS = 4000;
const ERROR_LINE_RE = /\b(error|exception|traceback|failed|fatal|at\s+\S+:\d+:\d+)\b/i;

function truncateToLimit(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 16)).trimEnd() + '\n[truncated]';
}

function summarizeJsonToolOutput(text, maxChars) {
  const trimmed = String(text || '').trim();
  if (!trimmed || /^[{[]/.test(trimmed) === false) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const summary = Array.isArray(parsed)
      ? {
          type: 'array',
          length: parsed.length,
          sample: parsed.slice(0, 3),
        }
      : {
          type: 'object',
          keys: Object.keys(parsed).slice(0, 40),
          sample: Object.fromEntries(Object.entries(parsed).slice(0, 8)),
        };
    return truncateToLimit(
      JSON.stringify({ note: 'historical JSON tool output compacted', summary }),
      maxChars
    );
  } catch (_error) {
    return null;
  }
}

function summarizeErrorToolOutput(text, maxChars) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const important = lines.filter((line) => ERROR_LINE_RE.test(line)).slice(0, 12);
  if (important.length === 0) return null;
  return truncateToLimit(
    [
      '[historical tool error summary]',
      ...important,
      lines.length > important.length
        ? `[${lines.length - important.length} less relevant lines omitted]`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    maxChars
  );
}

/**
 * Truncates a long text string, keeping head and tail lines/chars,
 * and inserting a structured folding notice.
 */
function truncateToolOutputText(
  text,
  maxChars = DEFAULT_MAX_TOOL_CHARS,
  headChars = DEFAULT_HEAD_CHARS,
  tailChars = DEFAULT_TAIL_CHARS
) {
  if (typeof text !== 'string' || text.length <= maxChars) {
    return text;
  }
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : DEFAULT_MAX_TOOL_CHARS;
  const structured = summarizeJsonToolOutput(text, limit) || summarizeErrorToolOutput(text, limit);
  if (structured) return structured;
  const notice = '\n[...代理已折叠历史执行回显...]\n';
  if (limit <= notice.length) return notice.slice(0, limit);
  const available = limit - notice.length;
  const requestedHead = Number.isFinite(headChars)
    ? Math.max(0, Math.floor(headChars))
    : DEFAULT_HEAD_CHARS;
  const requestedTail = Number.isFinite(tailChars)
    ? Math.max(0, Math.floor(tailChars))
    : DEFAULT_TAIL_CHARS;
  const headLength = Math.min(
    requestedHead,
    Math.ceil((available * requestedHead) / (requestedHead + requestedTail || 1))
  );
  const tailLength = Math.min(requestedTail, available - headLength);
  const head = text.slice(0, headLength);
  const tail = tailLength ? text.slice(-tailLength) : '';
  return head + notice + tail;
}

/**
 * Checks whether a message looks like a tool output / command execution result.
 */
function isToolResponseMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.role === 'tool' || msg.role === 'function') return true;
  if (msg.tool_call_id || msg.tool_call_ids) return true;
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    return msg.content.some((part) => part && part.type === 'tool_result');
  }
  // Also check for common CLI / agent tool output patterns in user role
  if (msg.role === 'user' && typeof msg.content === 'string') {
    const trimmed = msg.content.trimStart();
    if (
      trimmed.startsWith('Command output:') ||
      trimmed.startsWith('<tool_response>') ||
      trimmed.startsWith('[Tool result]') ||
      trimmed.startsWith('Tool execution result:')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Truncate a single message content if it exceeds maxChars.
 */
function optimizeMessageContent(msg, maxChars, headChars, tailChars) {
  if (!msg || typeof msg !== 'object') return msg;
  let content = msg.content;
  let changed = false;

  if (Array.isArray(content) && content.some((part) => part && part.type === 'tool_result')) {
    content = content.map((part) => {
      if (!part || part.type !== 'tool_result') return part;
      const optimized = optimizeMessageContent(
        { content: part.content },
        maxChars,
        headChars,
        tailChars
      );
      if (optimized.content === part.content) return part;
      changed = true;
      return { ...part, content: optimized.content };
    });
  } else if (typeof content === 'string') {
    if (content.length > maxChars) {
      content = truncateToolOutputText(content, maxChars, headChars, tailChars);
      changed = true;
    }
  } else if (Array.isArray(content)) {
    const newParts = content.map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        part.type === 'text' &&
        typeof part.text === 'string'
      ) {
        if (part.text.length > maxChars) {
          changed = true;
          return {
            ...part,
            text: truncateToolOutputText(part.text, maxChars, headChars, tailChars),
          };
        }
      }
      return part;
    });
    if (changed) content = newParts;
  }

  return changed ? { ...msg, content } : msg;
}

function messageContentChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        return sum + part.text.length;
      }
      if (part && part.type === 'tool_result') return sum + messageContentChars(part.content);
      return sum;
    }, 0);
  }
  return 0;
}

/**
 * Optimizes an array of conversation messages by pruning/folding older tool outputs.
 *
 * - System messages are always preserved intact.
 * - The latest `keepRecentTurns` user turns are preserved at 100% full fidelity.
 * - For older turns, tool outputs exceeding `maxHistoricalToolChars` are folded.
 */
function optimizeContextMessages(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length <= 3) {
    return { messages, prunedCount: 0, savedChars: 0 };
  }
  if (options.enabled === false) {
    return { messages, prunedCount: 0, savedChars: 0 };
  }

  const keepRecentTurns = Math.max(1, Number(options.keepRecentTurns) || DEFAULT_KEEP_RECENT_TURNS);
  const maxToolChars = Math.max(
    100,
    Number(options.maxHistoricalToolChars) || DEFAULT_MAX_TOOL_CHARS
  );
  const headChars = Math.max(50, Number(options.headChars) || DEFAULT_HEAD_CHARS);
  const tailChars = Math.max(50, Number(options.tailChars) || DEFAULT_TAIL_CHARS);
  const foldHistoricalMessages = options.foldHistoricalMessages === true;
  const maxHistoricalMessageChars = Math.max(
    maxToolChars,
    Number(options.maxHistoricalMessageChars) || DEFAULT_MAX_HISTORICAL_MESSAGE_CHARS
  );

  // 1. Identify turn boundaries working backwards.
  // Count user messages starting from the end to find the cutoff index for recent turns.
  let userTurnsSeen = 0;
  let recentCutoffIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'user' && !isToolResponseMessage(msg)) {
      userTurnsSeen += 1;
      if (userTurnsSeen >= keepRecentTurns) {
        recentCutoffIndex = i;
        break;
      }
    }
  }

  let prunedCount = 0;
  let originalTotalChars = 0;
  let newTotalChars = 0;

  const optimizedMessages = messages.map((msg, index) => {
    const msgChars = messageContentChars(msg?.content);
    originalTotalChars += msgChars;

    // Never modify system messages or messages in the recent turns window
    if (
      index >= recentCutoffIndex ||
      (msg && (msg.role === 'system' || msg.role === 'developer'))
    ) {
      newTotalChars += msgChars;
      return msg;
    }

    // Historical messages: only prune if it is a tool response
    if (isToolResponseMessage(msg)) {
      const optimized = optimizeMessageContent(msg, maxToolChars, headChars, tailChars);
      const newChars = messageContentChars(optimized?.content);
      newTotalChars += newChars;
      if (newChars < msgChars) {
        prunedCount += 1;
      }
      return optimized;
    }

    if (foldHistoricalMessages) {
      const optimized = optimizeMessageContent(
        msg,
        maxHistoricalMessageChars,
        headChars,
        tailChars
      );
      const newChars = messageContentChars(optimized?.content);
      newTotalChars += newChars;
      if (newChars < msgChars) {
        prunedCount += 1;
      }
      return optimized;
    }

    newTotalChars += msgChars;
    return msg;
  });

  return {
    messages: optimizedMessages,
    prunedCount,
    savedChars: Math.max(0, originalTotalChars - newTotalChars),
  };
}

module.exports = {
  optimizeContextMessages,
  truncateToolOutputText,
  isToolResponseMessage,
  messageContentChars,
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_MAX_TOOL_CHARS,
  DEFAULT_MAX_HISTORICAL_MESSAGE_CHARS,
};
