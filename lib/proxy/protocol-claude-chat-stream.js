'use strict';

const { checkInternalEventSize } = require('./internal-stream-events');
const { conversionFailureCode } = require('./conversion-stream-budget');
const {
  claudeUsageToOpenAIChatUsage,
  mergeClaudeStreamUsage,
} = require('./protocol-usage-details');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidArguments() {
  const error = new TypeError('Invalid upstream tool arguments');
  error.code = 'upstream_stream_invalid_tool_arguments';
  return error;
}

// Hold executable tools until the provider confirms the entire message ended.
function createClaudeStreamDecoder({
  parseClaudeSseEvent,
  deltaPartialJson,
  cleanToolArgs,
  protocolOptions,
  parseSseEvents,
  streamBudget,
  writeChunk,
  finishReason,
  output,
}) {
  function text(clientRes, state, value) {
    if (output) output.text(clientRes, state, value);
    else writeChunk(clientRes, state, { content: value });
  }
  function reasoning(clientRes, state, value) {
    if (output) output.reasoning(clientRes, state, value);
    else writeChunk(clientRes, state, { reasoning_content: value });
  }
  function fail(clientRes, state, code) {
    if (state.done) return;
    state.done = true;
    state.failed = true;
    state.failureCode = code;
    state.buffer = '';
    state.pendingToolCall = null;
    state.pendingCompaction = null;
    state.completedClaudeTools = [];
    if (output) {
      output.fail(clientRes, state, code);
      return;
    }
    clientRes.write(
      'data: ' +
        JSON.stringify({
          error: {
            type: 'upstream_error',
            code,
            message: 'Upstream Claude stream could not be completed safely',
          },
        }) +
        '\n\n'
    );
    clientRes.write('data: [DONE]\n\n');
  }

  function policy(state) {
    return state.thinkingPolicy || protocolOptions?.thinkingPolicy || 'passthrough';
  }

  function completeTool(state) {
    const pending = state.pendingToolCall;
    if (!pending) return;
    let input = pending.input;
    if (pending.arguments) {
      let parsed;
      try {
        parsed = JSON.parse(pending.arguments);
      } catch {
        throw invalidArguments();
      }
      if (!isRecord(parsed)) throw invalidArguments();
      input = { ...input, ...parsed };
    }
    const cleaned = cleanToolArgs(pending.name, input);
    if (!isRecord(cleaned)) throw invalidArguments();
    const args = JSON.stringify(cleaned);
    // Sanitization may expand input; apply the same cap to the executable output.
    streamBudget.appendArguments({}, args);
    if (!state.completedClaudeTools) state.completedClaudeTools = [];
    state.completedClaudeTools.push({
      id: pending.id,
      type: 'function',
      function: { name: pending.name, arguments: args },
    });
    state.pendingToolCall = null;
  }

  function processEvent(clientRes, event, state) {
    const parsed = parseClaudeSseEvent(event);
    if (!parsed.dataText || parsed.dataText === '[DONE]') return;
    processData(clientRes, parsed.eventName, parsed.data, state);
  }

  function processData(clientRes, name, data, state) {
    if (!isRecord(data)) {
      fail(clientRes, state, 'upstream_stream_invalid_event');
      return;
    }
    if (name === 'error') {
      fail(clientRes, state, 'upstream_stream_error');
      return;
    }
    if (name === 'message_start') {
      state.claudeUsage = mergeClaudeStreamUsage(state.claudeUsage, data.message?.usage);
      if (!output) {
        state.usage = claudeUsageToOpenAIChatUsage(state.claudeUsage);
        writeChunk(clientRes, state, { role: 'assistant', content: '' });
      }
    } else if (name === 'content_block_start') {
      if (state.pendingToolCall || state.pendingCompaction) throw invalidArguments();
      const block = data.content_block;
      if (!isRecord(block)) throw new TypeError('Invalid content block');
      if (block.type === 'tool_use') {
        if (
          typeof block.id !== 'string' ||
          !block.id.trim() ||
          typeof block.name !== 'string' ||
          !block.name.trim() ||
          !isRecord(block.input) ||
          (data.index != null && (!Number.isSafeInteger(data.index) || data.index < 0))
        )
          throw invalidArguments();
        streamBudget.addTool(state);
        const initial = JSON.stringify(block.input);
        streamBudget.appendArguments({}, initial);
        state.pendingToolCall = {
          id: block.id,
          name: block.name,
          input: block.input,
          index: data.index,
          arguments: '',
          argumentBytes: Buffer.byteLength(initial),
        };
      } else if (block.type === 'thinking') {
        state.inThinking = true;
        if (policy(state) === 'inject') text(clientRes, state, '<think>\n');
      } else if (block.type === 'compaction') {
        if (!output?.compaction) throw new TypeError('Unsupported compaction block');
        if (
          (block.content != null && typeof block.content !== 'string') ||
          (block.encrypted_content != null && typeof block.encrypted_content !== 'string') ||
          Object.keys(block).some((key) => !['type', 'content', 'encrypted_content'].includes(key))
        )
          throw new TypeError('Invalid compaction block');
        state.pendingCompaction = {
          index: data.index,
          type: 'compaction',
          content: block.content ?? null,
          encrypted_content: block.encrypted_content ?? null,
        };
      }
    } else if (name === 'content_block_delta') {
      if (!isRecord(data.delta)) throw new TypeError('Invalid content delta');
      if (state.pendingCompaction) {
        if (
          state.pendingCompaction.index !== data.index ||
          data.delta.type !== 'compaction_delta' ||
          (data.delta.content != null && typeof data.delta.content !== 'string') ||
          (data.delta.encrypted_content != null &&
            typeof data.delta.encrypted_content !== 'string') ||
          Object.keys(data.delta).some(
            (key) => !['type', 'content', 'encrypted_content'].includes(key)
          )
        )
          throw new TypeError('Invalid compaction delta');
        state.pendingCompaction.content = data.delta.content ?? null;
        state.pendingCompaction.encrypted_content = data.delta.encrypted_content ?? null;
      } else if (state.pendingToolCall) {
        const pending = state.pendingToolCall;
        if (pending.index !== data.index) throw invalidArguments();
        const partial = deltaPartialJson(data.delta);
        if (typeof partial !== 'string') throw invalidArguments();
        if (
          !partial &&
          data.delta.partial_json !== '' &&
          data.delta.input_json_delta?.partial_json !== ''
        )
          throw invalidArguments();
        pending.arguments = streamBudget.appendArguments(pending, partial);
      } else if (data.delta.type === 'input_json_delta') {
        throw invalidArguments();
      } else if (data.delta.thinking) {
        if (typeof data.delta.thinking !== 'string') throw new TypeError('Invalid thinking delta');
        if (policy(state) === 'passthrough') reasoning(clientRes, state, data.delta.thinking);
        else if (policy(state) === 'inject') text(clientRes, state, data.delta.thinking);
      } else if (data.delta.type === 'text_delta') {
        if (typeof data.delta.text !== 'string') throw new TypeError('Invalid text delta');
        if (data.delta.text) text(clientRes, state, data.delta.text);
      }
    } else if (name === 'content_block_stop') {
      if (state.pendingToolCall && state.pendingToolCall.index !== data.index)
        throw invalidArguments();
      completeTool(state);
      if (state.pendingCompaction) {
        if (state.pendingCompaction.index !== data.index)
          throw new TypeError('Invalid compaction block index');
        const block = { ...state.pendingCompaction };
        delete block.index;
        output.compaction(clientRes, state, block);
        state.pendingCompaction = null;
      }
      if (state.inThinking) {
        state.inThinking = false;
        if (policy(state) === 'inject') text(clientRes, state, '\n</think>\n');
      }
    } else if (name === 'message_delta') {
      if (data.delta?.stop_reason != null) {
        if (typeof data.delta.stop_reason !== 'string') throw new TypeError('Invalid stop reason');
        state.stopReason = data.delta.stop_reason;
        if (output) state.receivedStopReason = true;
      }
      state.claudeUsage = mergeClaudeStreamUsage(state.claudeUsage, data.usage);
      if (!output) state.usage = claudeUsageToOpenAIChatUsage(state.claudeUsage) || state.usage;
    } else if (name === 'message_stop') {
      if (state.pendingToolCall || state.pendingCompaction) {
        fail(clientRes, state, 'upstream_stream_incomplete');
        return;
      }
      if (
        state.stopReason !== 'max_tokens' &&
        state.stopReason !== 'refusal' &&
        (!output?.allowTools || output.allowTools(state))
      ) {
        for (const call of state.completedClaudeTools || []) {
          if (output) output.tool(clientRes, state, call);
          else
            writeChunk(clientRes, state, {
              tool_calls: [{ ...call, index: state.toolCallIndex || 0 }],
            });
          state.toolCallIndex = (state.toolCallIndex || 0) + 1;
          state.hasToolCalls = true;
        }
      }
      state.completedClaudeTools = [];
      if (output) {
        output.finish(clientRes, state);
        state.done = true;
        return;
      }
      writeChunk(
        clientRes,
        state,
        {},
        state.stopReason === 'refusal'
          ? 'content_filter'
          : finishReason(state.stopReason, state.hasToolCalls)
      );
      state.done = true;
      clientRes.write('data: [DONE]\n\n');
    }
  }

  function processClaudeSseEventToOpenAI(clientRes, event, state) {
    if (state.done) return;
    try {
      processEvent(clientRes, event, state);
    } catch (error) {
      fail(clientRes, state, conversionFailureCode(error));
    }
  }
  function processClaudeDataToOpenAI(clientRes, name, data, wire, state, maxChars) {
    if (state.done) return;
    try {
      // The wire fallback writes the event header and data separately. Preserve
      // the same accounting and failure boundary when either write hits a cap.
      if (typeof wire !== 'string') throw new TypeError('Invalid internal stream frame');
      const headerEnd = wire.indexOf('\n') + 1;
      const header = wire.slice(0, headerEnd);
      streamBudget.consume(state, header);
      checkInternalEventSize(header + '\n\n', maxChars);
      streamBudget.consume(state, wire.slice(headerEnd));
      checkInternalEventSize(wire, maxChars);
      processData(clientRes, name, data, state);
    } catch (error) {
      fail(clientRes, state, conversionFailureCode(error));
    }
  }
  function processClaudeSseChunkToOpenAI(clientRes, chunkText, state) {
    if (state.done) return;
    try {
      streamBudget.consume(state, chunkText);
      parseSseEvents(state, chunkText, 'Claude', (event) =>
        processClaudeSseEventToOpenAI(clientRes, event, state)
      );
    } catch (error) {
      fail(clientRes, state, conversionFailureCode(error));
    }
  }
  function flushClaudeSseToOpenAI(clientRes, state) {
    if (state.done) return;
    if (state.buffer?.trim()) processClaudeSseEventToOpenAI(clientRes, state.buffer, state);
    state.buffer = '';
    if (!state.done) fail(clientRes, state, 'upstream_stream_incomplete');
  }
  return {
    processChunk: processClaudeSseChunkToOpenAI,
    flush: flushClaudeSseToOpenAI,
    processClaudeDataToOpenAI,
    processClaudeSseEventToOpenAI,
    processClaudeSseChunkToOpenAI,
    flushClaudeSseToOpenAI,
  };
}

module.exports = {
  createClaudeStreamDecoder,
  createClaudeChatStreamConverter: createClaudeStreamDecoder,
};
