'use strict';

const { createClaudeStreamDecoder } = require('./protocol-claude-chat-stream');
const { claudeUsageToResponsesUsage } = require('./protocol-usage-details');
const { createAnthropicProviderContextItem } = require('./provider-context-history');

function createClaudeResponsesStream({ emitter, responseState, deps }) {
  const state = { buffer: '', stopReason: 'end_turn', thinkingPolicy: 'passthrough' };
  const converter = createClaudeStreamDecoder({
    ...deps,
    output: {
      allowTools: (provider) =>
        provider.receivedStopReason &&
        ['end_turn', 'stop_sequence', 'tool_use'].includes(provider.stopReason),
      text: (sink, _state, value) => emitter.text(sink, responseState, value),
      reasoning: (sink, _state, value) => emitter.reasoning(sink, responseState, value),
      compaction: (_sink, _state, block) => {
        if (!Array.isArray(responseState.providerContextItems))
          responseState.providerContextItems = [];
        responseState.providerContextItems.push(
          createAnthropicProviderContextItem(block, responseState.completedOutputItems.length)
        );
      },
      tool: (sink, provider, call) => {
        emitter.finishResponsesReasoningItem(sink, responseState);
        emitter.finishResponsesTextItem(sink, responseState);
        emitter.bufferResponsesToolCallDelta(responseState, {
          ...call,
          index: provider.toolCallIndex || 0,
        });
      },
      fail: (sink, _state, code) => emitter.failResponsesStream(sink, responseState, code),
      finish: (sink, provider) => {
        if (
          !provider.receivedStopReason ||
          ![
            'end_turn',
            'stop_sequence',
            'tool_use',
            'max_tokens',
            'model_context_window_exceeded',
            'refusal',
            'pause_turn',
          ].includes(provider.stopReason)
        ) {
          provider.failed = true;
          provider.failureCode = 'upstream_stream_incomplete';
          emitter.failResponsesStream(sink, responseState, provider.failureCode);
          return;
        }
        responseState.usage = claudeUsageToResponsesUsage(provider.claudeUsage);
        responseState.finishReason =
          provider.stopReason === 'refusal'
            ? 'content_filter'
            : ['max_tokens', 'model_context_window_exceeded'].includes(provider.stopReason)
              ? 'length'
              : provider.hasToolCalls
                ? 'tool_calls'
                : 'stop';
        emitter.finishResponsesStream(sink, responseState);
        if (responseState.failed) {
          provider.failed = true;
          provider.failureCode = responseState.failure?.code;
        }
      },
    },
  });
  return { state, processChunk: converter.processChunk, flush: converter.flush };
}

module.exports = { createClaudeResponsesStream };
