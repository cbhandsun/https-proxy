'use strict';
const { createGeminiStreamDecoder } = require('./gemini-stream-decoder');
const { createResponsesClaudeStreamTarget } = require('./responses-claude-stream-target');
const { claudeUsageToOpenAIChatUsage } = require('./protocol-usage-details');

function createGeminiClaudeStream({ deps, options }) {
  const target = createResponsesClaudeStreamTarget({
    ...options,
    protocolOptions: deps.protocolOptions,
    errorMessage: 'Upstream Gemini stream could not be completed safely',
    toolToClaude: (call) => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: JSON.parse(call.arguments),
    }),
  });
  const decoder = createGeminiStreamDecoder({
    deps,
    options,
    target: {
      text: (sink, value) => target.text(sink, decoder.state, value),
      reasoning: (sink, value) => target.reasoning(sink, decoder.state, value),
      tool: (sink, call) => target.tool(sink, decoder.state, call),
      finish(sink, { usage, finishReason }) {
        if (!target.finish(sink, claudeUsageToOpenAIChatUsage(usage), finishReason))
          decoder.state.failed = true;
      },
      fail: (sink) => target.fail(sink),
    },
  });
  function abort(sink) {
    decoder.abort(sink);
  }
  return {
    ...decoder,
    abort,
    start(sink) {
      try {
        target.start(sink);
      } catch {
        abort(sink);
      }
    },
    finish(sink) {
      decoder.finish(sink);
      return !decoder.state.failed && !decoder.state.disposed;
    },
  };
}
module.exports = { createGeminiClaudeStream };
