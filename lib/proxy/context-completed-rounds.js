'use strict';

const { toolCallIds, toolResultIds } = require('./context-classifier');
const { CHECKPOINT_MARKER } = require('./context-checkpoint');

const DEFAULT_KEEP_COMPLETED_TOOL_ROUNDS = 8;

// Unlike generic history pruning, completed rounds need not include the previous
// result. Merge overlapping (parallel/interleaved) exchanges, never adjacent ones.
// Ambiguous IDs, mixed user content, and unfinished exchanges fail closed.
function boundCompletedToolRounds(messages, options = {}) {
  if (!Array.isArray(messages))
    return { messages, droppedMessages: [], completedRounds: 0, protectedIntervals: [] };
  const keep =
    Number.isSafeInteger(options.keepCompletedToolRounds) &&
    (options.keepCompletedToolRounds > 0 ||
      (options.keepCompletedToolRounds === 0 && options.allowEmptyCompletedRounds === true))
      ? Math.min(64, options.keepCompletedToolRounds)
      : DEFAULT_KEEP_COMPLETED_TOOL_ROUNDS;
  const calls = new Map();
  const intervals = [];
  const ambiguous = new Set();
  messages.forEach((message, index) => {
    for (const id of toolResultIds(message)) {
      const call = calls.get(id);
      if (!call || call.end >= 0) {
        ambiguous.add(id);
        continue;
      }
      call.end = index;
    }
    for (const id of toolCallIds(message)) {
      if (calls.has(id) || id.startsWith('gemini-name:')) ambiguous.add(id);
      const call = { id, start: index, end: -1 };
      calls.set(id, call);
      intervals.push(call);
    }
  });
  const merged = [];
  for (const interval of intervals) {
    const end = interval.end < 0 ? messages.length - 1 : interval.end;
    const previous = merged.at(-1);
    const unsafe = interval.end < 0 || ambiguous.has(interval.id);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.unsafe ||= unsafe;
    } else merged.push({ start: interval.start, end, unsafe });
  }
  const safe = merged.filter(
    (interval) =>
      !interval.unsafe &&
      messages.slice(interval.start, interval.end + 1).every(
        (message) =>
          !options.protectedMessages?.has(message) &&
          isExchangeMessage(message) &&
          toolResultIds(message).every((id) => {
            const call = calls.get(id);
            return (
              call &&
              !ambiguous.has(id) &&
              call.start >= interval.start &&
              call.end >= call.start &&
              call.end <= interval.end
            );
          })
      )
  );
  const evicted = safe.slice(0, Math.max(0, safe.length - keep));
  const protectedIntervals = merged
    .filter((interval) => !evicted.includes(interval))
    .map((interval) => {
      let end = interval.end;
      while (end + 1 < messages.length && isPlainAssistant(messages[end + 1])) end += 1;
      return { start: interval.start, end };
    });
  const droppedIndices = new Set();
  for (const interval of evicted) {
    for (let index = interval.start; index <= interval.end; index += 1) droppedIndices.add(index);
    // Retain latest progress; older inter-round narration rolls into the checkpoint.
    for (let index = interval.end + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (options.protectedMessages?.has(message) || !isPlainAssistant(message)) break;
      droppedIndices.add(index);
    }
  }
  return {
    messages: messages.filter((_message, index) => !droppedIndices.has(index)),
    droppedMessages: messages.filter((_message, index) => droppedIndices.has(index)),
    completedRounds: safe.length,
    evictedRounds: evicted.length,
    protectedIntervals,
    exchangeIntervals: merged.map((interval) => {
      let end = interval.end;
      while (end + 1 < messages.length && isPlainAssistant(messages[end + 1])) end += 1;
      return { start: interval.start, end };
    }),
  };
}

function isPlainAssistant(message) {
  return (
    message?.role === 'assistant' &&
    typeof message.content === 'string' &&
    !message.content.startsWith(`${CHECKPOINT_MARKER}\n`) &&
    toolCallIds(message).length === 0 &&
    !message.function_call
  );
}

function isExchangeMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.role === 'assistant')
    return (
      !message.function_call &&
      !(typeof message.content === 'string' && message.content.startsWith(`${CHECKPOINT_MARKER}\n`))
    );
  if (message.role === 'tool') return toolResultIds(message).length > 0;
  // Native result messages may also contain fresh user constraints or images.
  // Only result-only user messages are safe to archive as an exchange.
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((part) => part && (part.type === 'tool_result' || part.functionResponse))
  );
}

module.exports = { boundCompletedToolRounds, DEFAULT_KEEP_COMPLETED_TOOL_ROUNDS };
