const { createLogger } = require('./logger');

const safeLog = createLogger('stream-claude');

function createClaudeStream(deps) {
  const {
    cleanToolArgs,
    stripEmptyOptionalToolArgs,
    sanitizeGeminiToolCall,
    sampleGeminiToolEvent,
    auditToolCall,
    sampleOutboundSse,
    parseClaudeSseEvent,
    resolveSseBlockIndex,
    deltaPartialJson,
    geminiFunctionCallArgs,
    geminiClaudeToolId,
    rememberGeminiToolCall,
    claudeStopReasonFromGemini,
    geminiUsageToClaude,
    geminiInlineImageToClaudeBlock,
    fallbackId,
    protocolOptions,
  } = deps;
  const DEFAULT_SSE_BUFFER_MAX_CHARS = 1024 * 1024;
  const MAX_SSE_BUFFER_MAX_CHARS = 4 * 1024 * 1024;
  const maxSseBufferChars = boundedInteger(
    protocolOptions && protocolOptions.maxSseBufferChars,
    DEFAULT_SSE_BUFFER_MAX_CHARS,
    1,
    MAX_SSE_BUFFER_MAX_CHARS
  );

  function boundedInteger(value, defaultValue, min, max) {
    const parsed =
      typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
    const fallback = Number.isFinite(defaultValue) ? Math.trunc(defaultValue) : min;
    const integer = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    return Math.min(max, Math.max(min, integer));
  }

  function appendSseBuffer(state, chunkText, label) {
    state.buffer = (state.buffer || '') + chunkText;
    if (state.buffer.length > maxSseBufferChars) {
      state.buffer = '';
      throw new Error(label + ' SSE event too large; max ' + maxSseBufferChars + ' chars');
    }
  }

  function mergeGeminiToolArgs(current, next) {
    if (!next || typeof next !== 'object') return current || {};
    return { ...(current || {}), ...next };
  }

  function makeSafeClaudeToolUseContentBlock(id, name, input) {
    const sanitized = sanitizeGeminiToolCall({ name, args: input }, []);
    if (sanitized.error) return { type: 'text', text: sanitized.text };
    return { type: 'tool_use', id, name: sanitized.name, input: sanitized.args };
  }

  function writeClaudeInputJsonDeltaChunks(clientRes, index, input, options) {
    const json = JSON.stringify(input || {});
    const chunkSize = 8192;
    for (let offset = 0; offset < json.length; offset += chunkSize) {
      writeClaudeSseEvent(
        clientRes,
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: json.slice(offset, offset + chunkSize) },
        },
        options
      );
    }
  }

  function writeClaudeSseEvent(clientRes, event, data, options) {
    if (
      (!options || options.safeToolUse !== false) &&
      event === 'content_block_start' &&
      data &&
      data.content_block &&
      data.content_block.type === 'tool_use'
    ) {
      const safe = makeSafeClaudeToolUseContentBlock(
        data.content_block.id,
        data.content_block.name,
        data.content_block.input
      );
      if (safe.type === 'text') {
        sampleGeminiToolEvent('write guard rejected tool_use', data.content_block);
        auditToolCall('gemini-sse-write', data.content_block.name, data.content_block.input, {
          event,
        });
        data = { ...data, content_block: safe };
      } else {
        data = {
          ...data,
          content_block: {
            type: 'tool_use',
            id: data.content_block.id,
            name: safe.name,
            input: {},
          },
        };
      }
    }
    sampleOutboundSse(clientRes, event, data);
    clientRes.write('event: ' + event + '\n');
    clientRes.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  function writeClaudeToolUseBlock(clientRes, index, id, name, input) {
    const cleaned = cleanToolArgs(name, input || {});
    writeClaudeSseEvent(
      clientRes,
      'content_block_start',
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name, input: {} },
      },
      { safeToolUse: false }
    );
    writeClaudeInputJsonDeltaChunks(clientRes, index, cleaned);
    writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index });
  }

  function writeOpenAIToolUseBlock(clientRes, index, id, name, input) {
    const cleaned = stripEmptyOptionalToolArgs(name, input || {});
    writeClaudeSseEvent(
      clientRes,
      'content_block_start',
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name, input: {} },
      },
      { safeToolUse: false }
    );
    writeClaudeInputJsonDeltaChunks(clientRes, index, cleaned, { safeToolUse: false });
    writeClaudeSseEvent(
      clientRes,
      'content_block_stop',
      { type: 'content_block_stop', index },
      { safeToolUse: false }
    );
  }

  function processOpenAISanitizedSseEvent(clientRes, event, state) {
    const parsed = parseClaudeSseEvent(event);
    if (!parsed.dataText || parsed.dataText === '[DONE]') {
      clientRes.write(event + '\n\n');
      return;
    }

    const data = parsed.data;
    if (!data) {
      clientRes.write(event + '\n\n');
      return;
    }

    if (
      parsed.eventName === 'content_block_start' &&
      data.content_block &&
      data.content_block.type === 'tool_use'
    ) {
      state.pendingOpenAITool = {
        index: resolveSseBlockIndex(data),
        id: data.content_block.id,
        name: data.content_block.name,
        input: data.content_block.input || {},
        partialJson: '',
      };
      return;
    }

    if (state.pendingOpenAITool && resolveSseBlockIndex(data) === state.pendingOpenAITool.index) {
      if (parsed.eventName === 'content_block_delta' && data.delta) {
        const partialJson = deltaPartialJson(data.delta);
        if (partialJson) state.pendingOpenAITool.partialJson += partialJson;
        return;
      }
      if (parsed.eventName === 'content_block_stop') {
        const pending = state.pendingOpenAITool;
        state.pendingOpenAITool = null;
        let input = pending.input;
        if (pending.partialJson.trim()) {
          try {
            input = { ...input, ...JSON.parse(pending.partialJson) };
          } catch (err) {}
        }
        writeOpenAIToolUseBlock(clientRes, pending.index, pending.id, pending.name, input);
        return;
      }
    }

    writeClaudeSseEvent(clientRes, parsed.eventName, data, { safeToolUse: false });
  }

  function rewriteClaudeToolEvent(clientRes, eventName, data, transformInput, state) {
    if (
      eventName === 'content_block_start' &&
      data &&
      data.content_block &&
      data.content_block.type === 'tool_use'
    ) {
      if (!state.toolNamesByIndex) state.toolNamesByIndex = {};
      if (data.index != null) state.toolNamesByIndex[data.index] = data.content_block.name;
      const nextInput = transformInput(data.content_block.name, data.content_block.input || {});
      if (nextInput !== data.content_block.input) {
        data = { ...data, content_block: { ...data.content_block, input: nextInput } };
      }
    }
    if (
      eventName === 'content_block_delta' &&
      data &&
      data.delta &&
      data.delta.type === 'input_json_delta' &&
      typeof data.delta.partial_json === 'string'
    ) {
      try {
        const input = JSON.parse(data.delta.partial_json);
        const name =
          state.toolNamesByIndex && data.index != null
            ? state.toolNamesByIndex[data.index]
            : undefined;
        const nextInput = transformInput(name, input || {});
        if (JSON.stringify(nextInput) !== JSON.stringify(input)) {
          data = { ...data, delta: { ...data.delta, partial_json: JSON.stringify(nextInput) } };
        }
      } catch (err) {}
    }
    writeClaudeSseEvent(clientRes, eventName, data, { safeToolUse: false });
  }

  function processClaudeSseEvent(clientRes, event, state) {
    const parsed = parseClaudeSseEvent(event);
    if (!parsed.dataText || parsed.dataText === '[DONE]') {
      clientRes.write(event + '\n\n');
      return;
    }

    let data = parsed.data;
    if (!data) {
      clientRes.write(event + '\n\n');
      return;
    }

    if (state.mode === 'strip-empty-optionals') {
      processOpenAISanitizedSseEvent(clientRes, event, state);
      return;
    }

    if (shouldDropDirectClaudeThinking()) {
      const inputIndex = resolveSseBlockIndex(data);
      ensureDirectClaudeIndexState(state);
      if (
        parsed.eventName === 'content_block_start' &&
        isClaudeThinkingContentBlock(data.content_block)
      ) {
        if (inputIndex != null) state.directClaudeDroppedIndexes[String(inputIndex)] = true;
        return;
      }
      if (inputIndex != null && state.directClaudeDroppedIndexes[String(inputIndex)]) {
        if (parsed.eventName === 'content_block_stop')
          delete state.directClaudeDroppedIndexes[String(inputIndex)];
        return;
      }
      if (inputIndex != null) data = remapDirectClaudeIndexedEvent(state, data);
    }

    if (
      parsed.eventName === 'content_block_start' &&
      data.content_block &&
      data.content_block.type === 'tool_use'
    ) {
      state.pendingClaudeTool = {
        index: resolveSseBlockIndex(data),
        id: data.content_block.id,
        name: data.content_block.name,
        input: data.content_block.input || {},
        partialJson: '',
      };
      return;
    }

    if (state.pendingClaudeTool && resolveSseBlockIndex(data) === state.pendingClaudeTool.index) {
      if (parsed.eventName === 'content_block_delta' && data.delta) {
        const partialJson = deltaPartialJson(data.delta);
        if (partialJson) state.pendingClaudeTool.partialJson += partialJson;
        return;
      }
      if (parsed.eventName === 'content_block_stop') {
        const pending = state.pendingClaudeTool;
        state.pendingClaudeTool = null;
        let input = pending.input;
        if (pending.partialJson.trim()) {
          try {
            input = { ...input, ...JSON.parse(pending.partialJson) };
          } catch (err) {}
        }
        const sanitized = sanitizeGeminiToolCall({ name: pending.name, args: input }, []);
        if (sanitized.error) {
          writeClaudeReplacementTextBlock(clientRes, pending.index, sanitized.text);
        } else {
          writeClaudeToolUseBlock(
            clientRes,
            pending.index,
            pending.id,
            sanitized.name,
            sanitized.args
          );
        }
        return;
      }
    }

    writeClaudeSseEvent(clientRes, parsed.eventName, data);
  }

  function writeClaudeTextBlock(clientRes, state, text) {
    state.textIndex += 1;
    writeClaudeSseEvent(clientRes, 'content_block_start', {
      type: 'content_block_start',
      index: state.textIndex,
      content_block: { type: 'text', text: '' },
    });
    writeClaudeSseEvent(clientRes, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.textIndex,
      delta: { type: 'text_delta', text },
    });
    writeClaudeSseEvent(clientRes, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.textIndex,
    });
  }

  function writeClaudeReplacementTextBlock(clientRes, index, text) {
    writeClaudeSseEvent(clientRes, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    writeClaudeSseEvent(clientRes, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    });
    writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index });
  }

  function shouldDropDirectClaudeThinking() {
    const policy = protocolOptions && protocolOptions.thinkingPolicy;
    return !policy || policy === 'drop';
  }

  function isClaudeThinkingContentBlock(block) {
    return block && (block.type === 'thinking' || block.type === 'redacted_thinking');
  }

  function ensureDirectClaudeIndexState(state) {
    if (!state.directClaudeIndexMap) state.directClaudeIndexMap = {};
    if (!state.directClaudeDroppedIndexes) state.directClaudeDroppedIndexes = {};
    if (state.directClaudeNextIndex == null) state.directClaudeNextIndex = 0;
  }

  function nextDirectClaudeOutputIndex(state, inputIndex) {
    ensureDirectClaudeIndexState(state);
    const key = String(inputIndex);
    if (state.directClaudeIndexMap[key] == null) {
      state.directClaudeIndexMap[key] = state.directClaudeNextIndex;
      state.directClaudeNextIndex += 1;
    }
    return state.directClaudeIndexMap[key];
  }

  function remapDirectClaudeIndexedEvent(state, data) {
    const inputIndex = resolveSseBlockIndex(data);
    if (inputIndex == null) return data;
    const outputIndex = nextDirectClaudeOutputIndex(state, inputIndex);
    return outputIndex === inputIndex ? data : { ...data, index: outputIndex };
  }

  function flushPendingGeminiToolCall(clientRes, state, tools) {
    const pending = state.pendingToolCall;
    if (!pending) return;
    state.pendingToolCall = null;
    const sanitized = sanitizeGeminiToolCall({ name: pending.name, args: pending.args }, tools);
    if (sanitized.error) {
      safeLog.warn('!! gemini invalid tool call converted to retry text: ' + sanitized.error);
      sampleGeminiToolEvent(sanitized.error, pending);
      writeClaudeTextBlock(clientRes, state, sanitized.text);
      return;
    }
    state.textIndex += 1;
    const id = geminiClaudeToolId(pending, state.textIndex);
    rememberGeminiToolCall(id, sanitized.name, sanitized.args, pending.thoughtSignature);
    state.hasToolUse = true;
    writeClaudeToolUseBlock(clientRes, state.textIndex, id, sanitized.name, sanitized.args);
  }

  function geminiClaudeStopReason(state) {
    const stopReason = state && state.stopReason ? state.stopReason : 'end_turn';
    return state && state.hasToolUse && stopReason === 'end_turn' ? 'tool_use' : stopReason;
  }

  function streamGeminiChunkToClaude(clientRes, payload, state, model, tools) {
    const candidate = payload && Array.isArray(payload.candidates) ? payload.candidates[0] : null;
    const parts =
      candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];
    for (const part of parts) {
      const imageBlock =
        typeof geminiInlineImageToClaudeBlock === 'function'
          ? geminiInlineImageToClaudeBlock(part)
          : null;
      const imageText = imageBlock
        ? imageBlock.type === 'image'
          ? `![generated image](data:${imageBlock.source.media_type};base64,${imageBlock.source.data})`
          : imageBlock.text
        : '';
      if (part.thought === true && part.text) {
        if (state.textOpen) {
          writeClaudeSseEvent(clientRes, 'content_block_stop', {
            type: 'content_block_stop',
            index: state.textIndex,
          });
          state.textOpen = false;
        }
        if (!state.thinkingOpen) {
          state.textIndex += 1;
          state.thinkingOpen = true;
          state.thinkingIndex = state.textIndex;
          writeClaudeSseEvent(clientRes, 'content_block_start', {
            type: 'content_block_start',
            index: state.thinkingIndex,
            content_block: {
              type: 'thinking',
              thinking: '',
              signature: part.thoughtSignature || 'gemini-thought',
            },
          });
        }
        writeClaudeSseEvent(clientRes, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.thinkingIndex,
          delta: { type: 'thinking_delta', thinking: part.text },
        });
      } else if (part.text || imageText) {
        if (state.thinkingOpen) {
          writeClaudeSseEvent(clientRes, 'content_block_stop', {
            type: 'content_block_stop',
            index: state.thinkingIndex,
          });
          state.thinkingOpen = false;
        }
        if (!state.textOpen) {
          state.textIndex += 1;
          state.textOpen = true;
          writeClaudeSseEvent(clientRes, 'content_block_start', {
            type: 'content_block_start',
            index: state.textIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        writeClaudeSseEvent(clientRes, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.textIndex,
          delta: { type: 'text_delta', text: part.text || imageText },
        });
      } else if (part.functionCall) {
        if (state.thinkingOpen) {
          writeClaudeSseEvent(clientRes, 'content_block_stop', {
            type: 'content_block_stop',
            index: state.thinkingIndex,
          });
          state.thinkingOpen = false;
        }
        if (state.textOpen) {
          writeClaudeSseEvent(clientRes, 'content_block_stop', {
            type: 'content_block_stop',
            index: state.textIndex,
          });
          state.textOpen = false;
        }
        const call = part.functionCall;
        if (
          state.pendingToolCall &&
          state.pendingToolCall.name &&
          call.name &&
          state.pendingToolCall.name !== call.name
        ) {
          flushPendingGeminiToolCall(clientRes, state, tools);
        }
        state.pendingToolCall = {
          id: call.id || (state.pendingToolCall && state.pendingToolCall.id),
          name: call.name || (state.pendingToolCall && state.pendingToolCall.name),
          args: mergeGeminiToolArgs(
            state.pendingToolCall && state.pendingToolCall.args,
            geminiFunctionCallArgs(call)
          ),
          thoughtSignature:
            part.thoughtSignature ||
            (state.pendingToolCall && state.pendingToolCall.thoughtSignature),
        };
      }
    }
    if (candidate && candidate.finishReason)
      state.stopReason = claudeStopReasonFromGemini(candidate.finishReason);
    if (payload && payload.usageMetadata) state.usage = geminiUsageToClaude(payload.usageMetadata);
  }

  function processGeminiSseEvent(clientRes, event, state, targetModel) {
    const lines = event.split(/\r?\n/).filter((line) => line.indexOf('data:') === 0);
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '');
      if (!data || data === '[DONE]') continue;
      try {
        streamGeminiChunkToClaude(clientRes, JSON.parse(data), state, targetModel, state.tools);
      } catch (err) {
        safeLog.warn(
          '!! gemini stream parse skipped: ' + err.message + ' data=' + data.slice(0, 500)
        );
      }
    }
  }

  function processClaudeSseChunk(clientRes, chunkText, state) {
    appendSseBuffer(state, chunkText, 'Claude');
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const event of events) processClaudeSseEvent(clientRes, event, state);
  }

  function flushClaudeSseFilter(clientRes, state) {
    if (state.buffer && state.buffer.trim()) processClaudeSseEvent(clientRes, state.buffer, state);
    state.buffer = '';
    if (state.pendingOpenAITool) {
      const pending = state.pendingOpenAITool;
      state.pendingOpenAITool = null;
      let input = pending.input;
      if (pending.partialJson && pending.partialJson.trim()) {
        try {
          input = { ...input, ...JSON.parse(pending.partialJson) };
        } catch (err) {}
      }
      writeOpenAIToolUseBlock(clientRes, pending.index, pending.id, pending.name, input);
      return;
    }
    if (!state.pendingClaudeTool) return;
    const pending = state.pendingClaudeTool;
    state.pendingClaudeTool = null;
    let input = pending.input;
    if (pending.partialJson && pending.partialJson.trim()) {
      try {
        input = { ...input, ...JSON.parse(pending.partialJson) };
      } catch (err) {}
    }
    const sanitized = sanitizeGeminiToolCall({ name: pending.name, args: input }, []);
    if (sanitized.error) {
      writeClaudeReplacementTextBlock(clientRes, pending.index, sanitized.text);
    } else {
      writeClaudeToolUseBlock(clientRes, pending.index, pending.id, sanitized.name, sanitized.args);
    }
  }

  function writeClaudeFromOpenAIStreamChunk(clientRes, state, chunk) {
    const choice = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    const delta = choice && choice.delta ? choice.delta : {};

    const reasoningDelta =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : typeof delta.thought === 'string'
            ? delta.thought
            : '';

    // Reasoning support (DeepSeek, etc.): map to Claude thinking blocks
    if (reasoningDelta) {
      if (state.textOpen) {
        writeClaudeSseEvent(clientRes, 'content_block_stop', {
          type: 'content_block_stop',
          index: state.textIndex,
        });
        state.textOpen = false;
      }
      if (!state.thinkingOpen) {
        state.textIndex += 1;
        state.thinkingOpen = true;
        state.thinkingIndex = state.textIndex;
        writeClaudeSseEvent(clientRes, 'content_block_start', {
          type: 'content_block_start',
          index: state.thinkingIndex,
          content_block: { type: 'thinking', thinking: '', signature: 'deepseek-reasoning' },
        });
      }
      writeClaudeSseEvent(clientRes, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.thinkingIndex,
        delta: { type: 'thinking_delta', thinking: reasoningDelta },
      });
    } else if (
      state.thinkingOpen &&
      (delta.content ||
        (choice && choice.finish_reason) ||
        (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0))
    ) {
      writeClaudeSseEvent(clientRes, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.thinkingIndex,
      });
      state.thinkingOpen = false;
    }

    if (delta.content) {
      if (!state.textOpen) {
        state.textIndex += 1;
        state.textOpen = true;
        writeClaudeSseEvent(clientRes, 'content_block_start', {
          type: 'content_block_start',
          index: state.textIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      writeClaudeSseEvent(clientRes, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.textIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index != null ? toolCall.index : 0;
        if (!state.toolCalls[index]) {
          state.toolCalls[index] = {
            id: toolCall.id,
            name: toolCall.function && toolCall.function.name,
            arguments: '',
          };
        }
        if (toolCall.id) state.toolCalls[index].id = toolCall.id;
        if (toolCall.function && toolCall.function.name)
          state.toolCalls[index].name = toolCall.function.name;
        if (toolCall.function && toolCall.function.arguments)
          state.toolCalls[index].arguments += toolCall.function.arguments;
      }
    }
    if (choice && choice.finish_reason) state.finishReason = choice.finish_reason;
  }

  function flushOpenAIStreamToolCallsToClaude(clientRes, state) {
    for (const item of state.toolCalls) {
      if (!item || item.flushed) continue;
      let input = {};
      if (item.arguments && item.arguments.trim()) {
        try {
          input = JSON.parse(item.arguments);
        } catch (err) {
          input = { arguments: item.arguments };
        }
      }
      state.textIndex += 1;
      const id =
        item.id || fallbackId('call', { index: state.textIndex, name: item.name || 'tool', input });
      writeClaudeToolUseBlock(clientRes, state.textIndex, id, item.name || 'tool', input);
      item.flushed = true;
    }
  }

  function processOpenAISseEventToClaude(clientRes, event, state) {
    const lines = event.split(/\r?\n/).filter((line) => line.indexOf('data:') === 0);
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '');
      if (!data) continue;
      if (data === '[DONE]') {
        state.done = true;
        return;
      }
      try {
        writeClaudeFromOpenAIStreamChunk(clientRes, state, JSON.parse(data));
      } catch (err) {}
    }
  }

  function processOpenAISseChunkToClaude(clientRes, chunkText, state) {
    appendSseBuffer(state, chunkText, 'OpenAI');
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const event of events) processOpenAISseEventToClaude(clientRes, event, state);
  }

  function flushOpenAISseToClaude(clientRes, state) {
    if (state.buffer && state.buffer.trim())
      processOpenAISseEventToClaude(clientRes, state.buffer, state);
    state.buffer = '';
    if (state.textOpen) {
      writeClaudeSseEvent(clientRes, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.textIndex,
      });
      state.textOpen = false;
    }
    if (state.thinkingOpen) {
      writeClaudeSseEvent(clientRes, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.thinkingIndex,
      });
      state.thinkingOpen = false;
    }
    flushOpenAIStreamToolCallsToClaude(clientRes, state);
    const hasToolCalls =
      (Array.isArray(state.toolCalls) && state.toolCalls.some((t) => t && t.flushed)) ||
      state.finishReason === 'tool_calls';
    const stopReason = hasToolCalls
      ? 'tool_use'
      : state.finishReason === 'length'
        ? 'max_tokens'
        : 'end_turn';
    writeClaudeSseEvent(clientRes, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: state.usage,
    });
    writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
  }

  return {
    mergeGeminiToolArgs,
    makeSafeClaudeToolUseContentBlock,
    writeClaudeSseEvent,
    writeClaudeToolUseBlock,
    writeOpenAIToolUseBlock,
    processOpenAISanitizedSseEvent,
    rewriteClaudeToolEvent,
    processClaudeSseEvent,
    writeClaudeTextBlock,
    writeClaudeReplacementTextBlock,
    flushPendingGeminiToolCall,
    geminiClaudeStopReason,
    streamGeminiChunkToClaude,
    processGeminiSseEvent,
    processClaudeSseChunk,
    flushClaudeSseFilter,
    writeClaudeFromOpenAIStreamChunk,
    flushOpenAIStreamToolCallsToClaude,
    processOpenAISseEventToClaude,
    processOpenAISseChunkToClaude,
    flushOpenAISseToClaude,
  };
}

module.exports = { createClaudeStream };
