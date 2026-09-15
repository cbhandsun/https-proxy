'use strict';

const DEFAULT_KEEP_RECENT_TURNS = 2;
const DEFAULT_MAX_TOOL_CHARS = 800;
const DEFAULT_HEAD_CHARS = 300;
const DEFAULT_TAIL_CHARS = 200;

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
  const originalLength = text.length;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omittedLength = originalLength - headChars - tailChars;
  const notice = `\n[...代理已折叠历史执行回显: 省略 ${omittedLength} 字符，保留首尾关键信息...]\n`;
  return head + notice + tail;
}

/**
 * Checks whether a message looks like a tool output / command execution result.
 */
function isToolResponseMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.role === 'tool' || msg.role === 'function') return true;
  if (msg.tool_call_id || msg.tool_call_ids) return true;
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

  if (typeof content === 'string') {
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

  // 1. Identify turn boundaries working backwards.
  // Count user messages starting from the end to find the cutoff index for recent turns.
  let userTurnsSeen = 0;
  let recentCutoffIndex = messages.length;

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
    const msgChars = typeof msg?.content === 'string' ? msg.content.length : 0;
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
      const newChars = typeof optimized?.content === 'string' ? optimized.content.length : 0;
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
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_MAX_TOOL_CHARS,
};
