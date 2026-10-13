'use strict';

const { CHAT_STREAM_CHUNK } = require('./internal-stream-events');
const { openAIChatUsageToClaudeUsage } = require('./protocol-usage-details');

// Keep the existing Chat-shaped semantic mapping without reparsing its SSE frames.
// The Responses decoder owns input limits and the authoritative terminal state.
function createResponsesClaudeBridge(deps, clientRes, state) {
  const sink = {
    write: (wire) => deps.processOpenAISseChunkToClaude(clientRes, String(wire), state),
  };
  if (typeof deps.writeClaudeFromOpenAIStreamChunk === 'function') {
    sink[CHAT_STREAM_CHUNK] = (chunk) =>
      deps.writeClaudeFromOpenAIStreamChunk(clientRes, state, chunk);
  }
  let finished = false;
  function finish(outcome, usage) {
    if (finished) return;
    finished = true;
    if (!outcome || outcome.failed || !outcome.ok || state.finishReason === 'content_filter') {
      state.toolCalls = [];
      state.done = true;
      deps.writeClaudeSseEvent(clientRes, 'error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Upstream Responses stream could not be completed safely',
        },
      });
      return false;
    }
    if (outcome.incomplete) {
      state.toolCalls = [];
      state.finishReason = 'length';
    }
    if (usage) {
      state.usage = openAIChatUsageToClaudeUsage(usage);
    }
    deps.flushOpenAISseToClaude(clientRes, state);
    return true;
  }
  return { sink, finish };
}

module.exports = { createResponsesClaudeBridge };
