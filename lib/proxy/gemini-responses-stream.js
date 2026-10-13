'use strict';
const { createGeminiStreamDecoder } = require('./gemini-stream-decoder');
const { claudeUsageToResponsesUsage } = require('./protocol-usage-details');
function createGeminiResponsesStream({ deps, responseState, emitter, options = {} }) {
  return createGeminiStreamDecoder({
    deps,
    options,
    target: {
      text: (sink, value) => emitter.text(sink, responseState, value),
      reasoning: (sink, value) => emitter.reasoning(sink, responseState, value),
      fail: (sink, code) => emitter.failResponsesStream(sink, responseState, code),
      tool(sink, call, index) {
        emitter.finishResponsesReasoningItem(sink, responseState);
        emitter.finishResponsesTextItem(sink, responseState);
        emitter.bufferResponsesToolCallDelta(responseState, {
          id: call.id,
          index,
          function: { name: call.name, arguments: call.arguments },
        });
      },
      finish(sink, { usage, finishReason }) {
        responseState.usage = claudeUsageToResponsesUsage(usage);
        responseState.finishReason = finishReason;
        emitter.finishResponsesStream(sink, responseState);
      },
    },
  });
}
module.exports = { createGeminiResponsesStream };
