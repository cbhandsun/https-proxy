const { applyContextBudgetToMessages } = require('./context-budget-manager');
const { createSseBufferAppender, parseBoundedInteger } = require('./sse-buffer');
const {
  classifyResponsesWebSearchTools,
  hasResponsesNativeWebSearchTool,
} = require('./openai-web-search-tools');
const {
  appendChatToolCallsAsResponses,
  collectCustomToolNames,
  prepareToolCall,
  writeCustomToolCallResponsesEvents,
} = require('./responses-custom-tools');
const { createResponsesChatTerminalStateMachine } = require('./protocol-openai-responses-stream');
const {
  inspectOpenAIMultimodalPart,
  multimodalBlockToOpenAIChatPart,
} = require('./multimodal-content');
const {
  extractCanonicalReasoning,
  applyReasoningToClaude,
  applyReasoningToOpenAI,
} = require('./reasoning-adapter');
const messageNormalization = require('./protocol-openai-message-normalization');
const {
  createResponsesRequestConverter,
  inferToolNameFromArguments,
} = require('./protocol-openai-responses-request');

function createOpenAIProtocol(deps) {
  const {
    cleanToolArgs,
    fallbackId,
    stableCreated,
    isClaudeThinkingBlock,
    filterClaudeCompatibleBlocks,
    normalizeClaudeContent,
    normalizeClaudeSystem,
    geminiToolResponseText,
    parseClaudeSseEvent,
    deltaPartialJson,
    protocolOptions,
  } = deps;
  // Tool-name inference is injected by some callers and omitted by the production
  // wiring in openai-proxy.js. Prefer the injection, fall back to the shared
  // implementation so every call site in this module resolves identically.
  const resolveToolNameInference = deps.inferToolNameFromArguments || inferToolNameFromArguments;
  const DEFAULT_SSE_BUFFER_MAX_CHARS = 1024 * 1024;
  const MAX_SSE_BUFFER_MAX_CHARS = 4 * 1024 * 1024;
  const maxSseBufferChars = parseBoundedInteger(
    protocolOptions && protocolOptions.maxSseBufferChars,
    DEFAULT_SSE_BUFFER_MAX_CHARS,
    1,
    MAX_SSE_BUFFER_MAX_CHARS
  );

  const appendSseBuffer = createSseBufferAppender(maxSseBufferChars);
  const {
    mergeAdjacentAssistantMessages,
    mergeAdjacentClaudeMessages,
    responsesInputItemToChatMessage,
  } = messageNormalization.createOpenAIMessageNormalization({
    fallbackId,
    inferToolNameFromArguments: resolveToolNameInference,
    inspectOpenAIMultimodalPart,
    multimodalBlockToOpenAIChatPart,
  });

  function openAIContentToClaudeContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content);
    return content.map((part) => {
      if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
      if (part.type === 'text') return { type: 'text', text: part.text || '' };
      const media = inspectOpenAIMultimodalPart(part);
      if (media.recognized) {
        if (!media.ok) throw new TypeError(media.error);
        return media.block;
      }
      return { type: 'text', text: messageNormalization.describeResponsesPayload(part) };
    });
  }
  // inferToolNameFromArguments / openAIChatToResponsesRequest live in
  // protocol-openai-responses-request.js (see createResponsesRequestConverter).
  function openAIToolCallToClaudeBlock(toolCall) {
    const fn = toolCall && toolCall.function ? toolCall.function : {};
    let input = {};
    if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
      try {
        input = JSON.parse(fn.arguments);
      } catch (err) {
        input = { arguments: fn.arguments };
      }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      input = fn.arguments;
    }
    const toolName = fn.name || toolCall.name || resolveToolNameInference(input);
    if (!toolName) return null;
    const cleaned = cleanToolArgs(toolName, input);
    const id = toolCall.id || fallbackId('toolu_openai', { name: toolName, input: cleaned });
    return { type: 'tool_use', id, name: toolName, input: cleaned };
  }
  function openAIToolResultContentToClaude(content) {
    if (typeof content === 'string') return content;
    return openAIContentToClaudeContent(content);
  }
  function openAIChatToClaudeMessages(body, model) {
    const result = { model };
    if (body && body.__nativeWebSearch) result.__nativeWebSearch = body.__nativeWebSearch;
    if (body && body.__managedWebSearchHistoryAsText) {
      result.__managedWebSearchHistoryAsText = true;
    }
    const budgetedMessages = applyContextBudgetToMessages(
      body.messages || [],
      body,
      model,
      protocolOptions || {},
      {
        estimateMessageTokens: messageNormalization.estimatePayloadTokens,
        fixedInputTokens: messageNormalization.estimatePayloadTokens(body.tools || []),
      }
    );
    const bodyMessages = budgetedMessages.messages;

    if (body.max_tokens != null) result.max_tokens = body.max_tokens;
    else if (body.max_completion_tokens != null) result.max_tokens = body.max_completion_tokens;
    else result.max_tokens = 4096;
    if (body.temperature != null) result.temperature = body.temperature;
    if (body.top_p != null) result.top_p = body.top_p;
    if (body.stop != null)
      result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.stream === true) result.stream = true;

    const messages = [];
    const systemParts = [];
    for (const message of Array.isArray(bodyMessages) ? bodyMessages : []) {
      if (!message) continue;
      if (message.role === 'system' || message.role === 'developer') {
        const content = openAIContentToClaudeContent(message.content);
        if (typeof content === 'string') systemParts.push({ type: 'text', text: content });
        else systemParts.push(...content.filter((part) => part && part.type === 'text'));
        continue;
      }
      if (message.role === 'tool') {
        const toolResultBlock = {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: openAIToolResultContentToClaude(message.content),
        };
        if (message.is_error === true || message.status === 'error') {
          toolResultBlock.is_error = true;
        }
        messages.push({
          role: 'user',
          content: [toolResultBlock],
        });
        continue;
      }
      if (message.role === 'assistant') {
        const content = [];
        const textContent = openAIContentToClaudeContent(message.content);
        if (typeof textContent === 'string') {
          if (textContent) content.push({ type: 'text', text: textContent });
        } else {
          content.push(...textContent);
        }
        if (Array.isArray(message.tool_calls))
          content.push(...message.tool_calls.map(openAIToolCallToClaudeBlock).filter(Boolean));
        messages.push({ role: 'assistant', content: content.length > 0 ? content : '' });
        continue;
      }
      messages.push({ role: 'user', content: openAIContentToClaudeContent(message.content) });
    }
    if (systemParts.length === 1) result.system = systemParts[0].text;
    else if (systemParts.length > 1) result.system = systemParts;
    result.messages = mergeAdjacentClaudeMessages(messages);

    if (Array.isArray(body.tools)) {
      const seenToolNames = new Set();
      result.tools = body.tools
        .filter((tool) => {
          if (!tool || tool.type !== 'function' || !tool.function || !tool.function.name)
            return false;
          if (seenToolNames.has(tool.function.name)) return false;
          seenToolNames.add(tool.function.name);
          return true;
        })
        .map((tool) => ({
          name: tool.function.name,
          description: tool.function.description || '',
          input_schema: tool.function.parameters || { type: 'object', properties: {} },
        }));
      if (result.tools.length === 0) delete result.tools;
    }
    if (body.tool_choice) {
      if (body.tool_choice === 'none') result.tool_choice = { type: 'none' };
      else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
      else if (body.tool_choice && body.tool_choice.type === 'function')
        result.tool_choice = {
          type: 'tool',
          name: body.tool_choice.function && body.tool_choice.function.name,
        };
    }
    const canonical = extractCanonicalReasoning(body);
    applyReasoningToClaude(result, canonical);
    Object.defineProperty(result, '__hpmDiagnostics', {
      value: { contextBudget: budgetedMessages.diagnostics },
      enumerable: false,
      configurable: true,
    });
    return result;
  }

  function claudeContentBlockToOpenAIMessage(block) {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    if (block.type === 'image' && block.source && block.source.type === 'base64') {
      const mediaType = block.source.media_type || 'image/png';
      return `![generated image](data:${mediaType};base64,${block.source.data || ''})`;
    }
    return messageNormalization.describeResponsesPayload(block);
  }

  function claudeToolUseToOpenAIToolCall(block, index) {
    const args = cleanToolArgs(block.name, block.input || {});
    return {
      id: block.id || fallbackId('call', { index, name: block.name, input: args }),
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(args),
      },
    };
  }

  function claudeResponseToOpenAIChat(payload, model) {
    const rawContent = Array.isArray(payload && payload.content) ? payload.content : [];
    const content =
      typeof filterClaudeCompatibleBlocks === 'function'
        ? filterClaudeCompatibleBlocks(rawContent)
        : rawContent;

    const thinkingBlocks = content.filter(isClaudeThinkingBlock);
    const reasoningText = thinkingBlocks
      .map((block) => block.thinking || block.signature || '')
      .join('');

    const text = content
      .filter((block) => !block || (block.type !== 'tool_use' && !isClaudeThinkingBlock(block)))
      .map(claudeContentBlockToOpenAIMessage)
      .join('');
    const toolCalls = content
      .filter((block) => block && block.type === 'tool_use')
      .map(claudeToolUseToOpenAIToolCall);
    const message = { role: 'assistant', content: text || null };
    if (reasoningText) {
      message.reasoning_content = reasoningText;
    }
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    const id =
      payload && payload.id ? payload.id : fallbackId('chatcmpl', { model, content, toolCalls });
    return {
      id,
      object: 'chat.completion',
      created: stableCreated(id),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason:
            toolCalls.length > 0
              ? 'tool_calls'
              : payload && payload.stop_reason === 'max_tokens'
                ? 'length'
                : 'stop',
        },
      ],
      usage: {
        prompt_tokens: payload && payload.usage ? payload.usage.input_tokens || 0 : 0,
        completion_tokens: payload && payload.usage ? payload.usage.output_tokens || 0 : 0,
        total_tokens:
          payload && payload.usage
            ? (payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0)
            : 0,
      },
    };
  }

  function openAIChunkFinishReason(stopReason, hasToolCalls) {
    if (hasToolCalls) return 'tool_calls';
    if (stopReason === 'max_tokens') return 'length';
    return 'stop';
  }

  function thinkingPolicy(state) {
    const policy = state && state.thinkingPolicy;
    const fallback = protocolOptions && protocolOptions.thinkingPolicy;
    return policy || fallback || 'passthrough';
  }
  function writeOpenAIChatSseChunk(clientRes, state, delta, finishReason) {
    const chunk = {
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
    };
    clientRes.write('data: ' + JSON.stringify(chunk) + '\n\n');
  }

  function flushOpenAIStreamToolCall(clientRes, state) {
    const pending = state.pendingToolCall;
    if (!pending) return;
    state.pendingToolCall = null;
    let args = pending.input || {};
    if (pending.partialJson && pending.partialJson.trim()) {
      try {
        args = { ...args, ...JSON.parse(pending.partialJson) };
      } catch (err) {
        args = { ...args, arguments: pending.partialJson };
      }
    }
    const cleaned = cleanToolArgs(pending.name, args || {});
    const toolCall = {
      index: state.toolCallIndex++,
      id: pending.id,
      type: 'function',
      function: { name: pending.name, arguments: JSON.stringify(cleaned) },
    };
    writeOpenAIChatSseChunk(clientRes, state, { tool_calls: [toolCall] });
    state.hasToolCalls = true;
  }

  function processClaudeSseEventToOpenAI(clientRes, event, state) {
    const parsed = parseClaudeSseEvent(event);
    if (!parsed.dataText || parsed.dataText === '[DONE]') return;
    const data = parsed.data;
    if (!data) return;
    if (parsed.eventName === 'message_start') {
      writeOpenAIChatSseChunk(clientRes, state, { role: 'assistant', content: '' });
      return;
    }
    if (parsed.eventName === 'content_block_start' && data.content_block) {
      if (data.content_block.type === 'tool_use') {
        flushOpenAIStreamToolCall(clientRes, state);
        state.pendingToolCall = {
          id: data.content_block.id,
          name: data.content_block.name,
          input: data.content_block.input || {},
          partialJson: '',
        };
      } else if (data.content_block.type === 'thinking') {
        state.inThinking = true;
        const policy = thinkingPolicy(state);
        if (policy === 'inject') {
          writeOpenAIChatSseChunk(clientRes, state, { content: '<think>\n' });
        }
      }
      return;
    }
    if (parsed.eventName === 'content_block_delta' && data.delta) {
      if (state.pendingToolCall) {
        const partialJson = deltaPartialJson(data.delta);
        if (partialJson) state.pendingToolCall.partialJson += partialJson;
        return;
      }
      const thinkingText = data.delta.thinking || '';
      if (thinkingText) {
        const policy = thinkingPolicy(state);
        if (policy === 'passthrough') {
          writeOpenAIChatSseChunk(clientRes, state, { reasoning_content: thinkingText });
        } else if (policy === 'inject') {
          writeOpenAIChatSseChunk(clientRes, state, { content: thinkingText });
        }
        return;
      }
      if (data.delta.type === 'text_delta' && data.delta.text)
        writeOpenAIChatSseChunk(clientRes, state, { content: data.delta.text });
      return;
    }
    if (parsed.eventName === 'content_block_stop') {
      flushOpenAIStreamToolCall(clientRes, state);
      if (state.inThinking) {
        state.inThinking = false;
        const policy = thinkingPolicy(state);
        if (policy === 'inject') {
          writeOpenAIChatSseChunk(clientRes, state, { content: '\n</think>\n' });
        }
      }
      return;
    }
    if (parsed.eventName === 'message_delta') {
      if (data.delta && data.delta.stop_reason) state.stopReason = data.delta.stop_reason;
      return;
    }
    if (parsed.eventName === 'message_stop') {
      flushOpenAIStreamToolCall(clientRes, state);
      writeOpenAIChatSseChunk(
        clientRes,
        state,
        {},
        openAIChunkFinishReason(state.stopReason, state.hasToolCalls)
      );
      clientRes.write('data: [DONE]\n\n');
      state.done = true;
    }
  }

  function processClaudeSseChunkToOpenAI(clientRes, chunkText, state) {
    appendSseBuffer(state, chunkText, 'Claude');
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const event of events) processClaudeSseEventToOpenAI(clientRes, event, state);
  }

  function flushClaudeSseToOpenAI(clientRes, state) {
    if (state.buffer && state.buffer.trim())
      processClaudeSseEventToOpenAI(clientRes, state.buffer, state);
    state.buffer = '';
    if (!state.done) {
      flushOpenAIStreamToolCall(clientRes, state);
      writeOpenAIChatSseChunk(
        clientRes,
        state,
        {},
        openAIChunkFinishReason(state.stopReason, state.hasToolCalls)
      );
      clientRes.write('data: [DONE]\n\n');
      state.done = true;
    }
  }

  function claudeContentToOpenAIContent(content) {
    const blocks = filterClaudeCompatibleBlocks(content);
    if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text || '';
    return blocks
      .map((block) => {
        if (isClaudeThinkingBlock(block)) return null;
        if (!block || typeof block !== 'object') return { type: 'text', text: String(block || '') };
        if (block.type === 'text') return { type: 'text', text: block.text || '' };
        if (block.type === 'image' && block.source && block.source.type === 'base64') {
          return {
            type: 'image_url',
            image_url: {
              url:
                'data:' +
                (block.source.media_type || 'application/octet-stream') +
                ';base64,' +
                (block.source.data || ''),
            },
          };
        }
        return { type: 'text', text: messageNormalization.describeResponsesPayload(block) };
      })
      .filter(Boolean);
  }

  function claudeToolUseToOpenAIToolMessage(block) {
    const args = cleanToolArgs(block.name, block.input || {});
    return {
      id: block.id || fallbackId('call', { name: block.name, input: args }),
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(args),
      },
    };
  }

  function claudeToolToOpenAITool(tool) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    };
  }

  function claudeToolChoiceToOpenAI(toolChoice) {
    if (!toolChoice || toolChoice.type === 'auto') return undefined;
    if (toolChoice.type === 'none') return 'none';
    if (toolChoice.type === 'any') return 'required';
    if (toolChoice.type === 'tool' && toolChoice.name)
      return { type: 'function', function: { name: toolChoice.name } };
    return undefined;
  }

  function claudeMessagesToOpenAIChat(body, model) {
    const messages = [];
    const system = normalizeClaudeSystem(body.system);
    if (system)
      messages.push({
        role: 'system',
        content: system.parts.map((part) => part.text || '').join('\n'),
      });

    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const blocks = normalizeClaudeContent(message.content);
      const toolResults = blocks.filter((block) => block && block.type === 'tool_result');
      const toolUses = blocks.filter((block) => block && block.type === 'tool_use');
      const otherBlocks = blocks.filter(
        (block) =>
          !block ||
          (block.type !== 'tool_result' &&
            block.type !== 'tool_use' &&
            !isClaudeThinkingBlock(block))
      );

      if (message.role === 'assistant') {
        const next = {
          role: 'assistant',
          content: otherBlocks.length > 0 ? claudeContentToOpenAIContent(otherBlocks) : null,
        };
        if (toolUses.length > 0) next.tool_calls = toolUses.map(claudeToolUseToOpenAIToolMessage);
        messages.push(next);
        continue;
      }

      if (toolResults.length > 0) {
        for (const block of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: geminiToolResponseText(block.content),
          });
        }
        if (otherBlocks.length === 0) continue;
      }
      messages.push({ role: 'user', content: claudeContentToOpenAIContent(otherBlocks) });
    }

    const result = { model, messages };
    if (body.max_tokens != null) result.max_tokens = body.max_tokens;
    if (body.temperature != null) result.temperature = body.temperature;
    if (body.top_p != null) result.top_p = body.top_p;
    if (Array.isArray(body.stop_sequences)) result.stop = body.stop_sequences;
    if (body.stream === true) result.stream = true;
    if (Array.isArray(body.tools))
      result.tools = body.tools.filter((tool) => tool && tool.name).map(claudeToolToOpenAITool);
    const toolChoice = claudeToolChoiceToOpenAI(body.tool_choice);
    if (toolChoice) result.tool_choice = toolChoice;
    const canonical = extractCanonicalReasoning(body);
    applyReasoningToOpenAI(result, canonical);
    return result;
  }

  function openAIMessageToClaudeContent(message) {
    const content = [];
    const reasoning =
      message &&
      (typeof message.reasoning_content === 'string'
        ? message.reasoning_content
        : typeof message.reasoning === 'string'
          ? message.reasoning
          : typeof message.thought === 'string'
            ? message.thought
            : '');
    if (reasoning) {
      content.push({ type: 'thinking', thinking: reasoning, signature: 'deepseek-reasoning' });
    }
    const text = message && message.content;
    if (typeof text === 'string' && text) content.push({ type: 'text', text });
    if (Array.isArray(text)) content.push(...openAIContentToClaudeContent(text));
    if (Array.isArray(message && message.tool_calls))
      content.push(...message.tool_calls.map(openAIToolCallToClaudeBlock).filter(Boolean));
    return content;
  }

  function openAIResponseToClaudeMessage(payload, model) {
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = choice && choice.message ? choice.message : {};
    const content = openAIMessageToClaudeContent(message);
    const hasToolCalls =
      (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
      content.some((b) => b && b.type === 'tool_use') ||
      (choice && choice.finish_reason === 'tool_calls');
    const stopReason = hasToolCalls
      ? 'tool_use'
      : choice && choice.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn';
    return {
      id: payload && payload.id ? payload.id : fallbackId('msg_openai', { model, message }),
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: payload && payload.usage ? payload.usage.prompt_tokens || 0 : 0,
        output_tokens: payload && payload.usage ? payload.usage.completion_tokens || 0 : 0,
      },
    };
  }

  function responsesToolChoiceToChat(toolChoice) {
    if (!toolChoice || toolChoice === 'auto') return undefined;
    if (toolChoice === 'none' || toolChoice === 'required') return toolChoice;
    if (toolChoice.type === 'auto') return undefined;
    if (toolChoice.type === 'none') return 'none';
    if (toolChoice.type === 'required') return 'required';
    if (toolChoice.type === 'function' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } };
    }
    if (toolChoice.type === 'function' && toolChoice.function && toolChoice.function.name) {
      return { type: 'function', function: { name: toolChoice.function.name } };
    }
    return toolChoice;
  }

  function responsesTextFormatToChat(format) {
    if (!format || typeof format !== 'object') return undefined;
    if (format.type === 'json_schema') {
      const nested =
        format.json_schema && typeof format.json_schema === 'object' ? format.json_schema : format;
      return {
        type: 'json_schema',
        json_schema: {
          name: nested.name || format.name || 'response',
          schema: nested.schema || format.schema || { type: 'object' },
          strict: nested.strict === true || format.strict === true,
        },
      };
    }
    if (format.type === 'json_object') return { type: 'json_object' };
    if (format.type === 'text') return undefined;
    return format;
  }

  const { openAIChatToResponsesRequest, responsesFunctionCallItemId, responsesFunctionCallCallId } =
    createResponsesRequestConverter({
      fallbackId,
      chatToolContentToResponsesOutput: messageNormalization.chatToolContentToResponsesOutput,
    });

  function openAIResponsesToChat(body) {
    const rawMessages = [];
    if (body.instructions) rawMessages.push({ role: 'system', content: String(body.instructions) });
    if (typeof body.input === 'string') {
      rawMessages.push({ role: 'user', content: body.input });
    } else if (Array.isArray(body.input)) {
      rawMessages.push(...body.input.map(responsesInputItemToChatMessage).filter(Boolean));
    } else if (body.input != null) {
      rawMessages.push({ role: 'user', content: String(body.input) });
    }

    const messages = mergeAdjacentAssistantMessages(rawMessages);

    const result = {
      model: body.model,
      messages,
    };
    if (body.stream === true) result.stream = true;
    if (body.temperature != null) result.temperature = body.temperature;
    if (body.top_p != null) result.top_p = body.top_p;
    if (body.max_output_tokens != null) result.max_tokens = body.max_output_tokens;
    if (body.max_tokens != null) result.max_tokens = body.max_tokens;
    if (body.max_completion_tokens != null) result.max_tokens = body.max_completion_tokens;
    const isReasoningModel =
      typeof body.model === 'string' &&
      /^(?:o[1-9]|gpt-5)/i.test(body.model.replace(/^openai\//i, ''));
    if (isReasoningModel && result.max_tokens != null) {
      result.max_completion_tokens = result.max_tokens;
      delete result.max_tokens;
    }
    if (body.frequency_penalty != null) result.frequency_penalty = body.frequency_penalty;
    if (body.presence_penalty != null) result.presence_penalty = body.presence_penalty;
    if (body.seed != null) result.seed = body.seed;
    if (body.user != null) result.user = body.user;
    if (body.parallel_tool_calls != null) result.parallel_tool_calls = body.parallel_tool_calls;
    if (body.reasoning && body.reasoning.effort) result.reasoning_effort = body.reasoning.effort;
    const allTools = Array.isArray(body.tools) ? [...body.tools] : [];
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (item && item.type === 'additional_tools' && Array.isArray(item.tools)) {
          allTools.push(...item.tools);
        }
      }
    }
    if (allTools.length > 0) {
      const webSearchTools = classifyResponsesWebSearchTools(
        allTools,
        body.__disableManagedWebSearchPromotion === true,
        body
      );
      if (webSearchTools.useNativeSearch) result.__nativeWebSearch = 'gemini-google-search';
      if (webSearchTools.managedFallback)
        result.__managedWebSearchFallback = webSearchTools.managedFallback;
      if (
        webSearchTools.managedFallback ||
        webSearchTools.functionTools.some((tool) => {
          const name = String(tool?.name || tool?.function?.name || '').toLowerCase();
          return name === 'web_search';
        })
      ) {
        result.__managedWebSearchHistoryAsText = true;
      }
      const seenFunctionNames = new Set();
      result.tools = webSearchTools.functionTools
        .map((tool) => ({
          type: 'function',
          function: {
            name: tool.name || (tool.function && tool.function.name),
            description: tool.description || (tool.function && tool.function.description) || '',
            parameters: tool.parameters ||
              (tool.function && tool.function.parameters) ||
              (tool.input_schema && typeof tool.input_schema === 'object'
                ? tool.input_schema
                : null) || {
                type: 'object',
                properties: {
                  input: {
                    type: 'string',
                    description: 'Input argument or source code for the tool',
                  },
                },
              },
            strict: tool.strict != null ? tool.strict : tool.function && tool.function.strict,
          },
        }))
        .filter((tool) => {
          if (!tool.function.name) return false;
          if (seenFunctionNames.has(tool.function.name)) return false;
          seenFunctionNames.add(tool.function.name);
          if (tool.function.strict == null) delete tool.function.strict;
          return true;
        });
      if (result.tools.length === 0) delete result.tools;
    }
    const toolChoice = responsesToolChoiceToChat(body.tool_choice);
    if (toolChoice) result.tool_choice = toolChoice;
    if (body.response_format) {
      result.response_format =
        responsesTextFormatToChat(body.response_format) || body.response_format;
    }
    const responseFormat = responsesTextFormatToChat(body.text && body.text.format);
    if (responseFormat) result.response_format = responseFormat;
    return result;
  }

  function openAIChatToResponses(payload, model, options = {}) {
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = choice && choice.message ? choice.message : {};
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => part && (part.text || part.content || '')).join('')
          : '';
    const output = [];
    const reasoningText =
      typeof message.reasoning_content === 'string'
        ? message.reasoning_content
        : typeof message.reasoning === 'string'
          ? message.reasoning
          : typeof message.thought === 'string'
            ? message.thought
            : '';
    if (reasoningText) {
      output.push({
        id: fallbackId('rsn', { model, text: reasoningText }),
        type: 'reasoning',
        status: 'completed',
        summary: reasoningText,
      });
    }
    if (text) {
      output.push({
        id: fallbackId('msg', { model, text }),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    const customToolNames =
      options && options.customToolNames
        ? options.customToolNames
        : collectCustomToolNames(options && (options.responsesRequest || options));
    appendChatToolCallsAsResponses({
      output,
      toolCalls: message.tool_calls,
      customToolNames,
      fallbackId,
      resolveToolNameInference,
      functionCallItemId: responsesFunctionCallItemId,
      functionCallCallId: responsesFunctionCallCallId,
    });
    const usage =
      payload && payload.usage
        ? {
            input_tokens: payload.usage.prompt_tokens || 0,
            output_tokens: payload.usage.completion_tokens || 0,
            total_tokens:
              payload.usage.total_tokens ||
              (payload.usage.prompt_tokens || 0) + (payload.usage.completion_tokens || 0),
          }
        : undefined;
    const finishReason = choice && choice.finish_reason;
    const incompleteDetails =
      finishReason === 'length'
        ? { reason: 'max_output_tokens' }
        : finishReason === 'content_filter'
          ? { reason: 'content_filter' }
          : undefined;
    return {
      id:
        payload && payload.id
          ? payload.id.replace(/^chatcmpl/, 'resp')
          : fallbackId('resp', { model, output }),
      object: 'response',
      created_at: payload && payload.created ? payload.created : stableCreated({ model, output }),
      status: incompleteDetails ? 'incomplete' : 'completed',
      ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
      model,
      output,
      usage,
    };
  }

  function writeResponsesSseEvent(clientRes, eventName, payload) {
    clientRes.write('event: ' + eventName + '\n');
    clientRes.write('data: ' + JSON.stringify(payload) + '\n\n');
  }

  function ensureResponsesStreamStarted(clientRes, state) {
    if (state.started) return;
    state.started = true;
    writeResponsesSseEvent(clientRes, 'response.created', {
      type: 'response.created',
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        status: 'in_progress',
        model: state.model,
        output: [],
      },
    });
    writeResponsesSseEvent(clientRes, 'response.in_progress', {
      type: 'response.in_progress',
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        status: 'in_progress',
        model: state.model,
        output: [],
      },
    });
  }

  function ensureResponsesReasoningItem(clientRes, state) {
    ensureResponsesStreamStarted(clientRes, state);
    if (state.reasoningItemStarted) return;
    state.reasoningItemStarted = true;
    state.reasoningItemDone = false;
    state.reasoningId =
      state.reasoningId ||
      fallbackId('rsn', { response: state.id, model: state.model, outputIndex: state.outputIndex });
    state.reasoningText = '';
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item: {
        id: state.reasoningId,
        type: 'reasoning',
        status: 'in_progress',
        content: [],
      },
    });
  }

  function finishResponsesReasoningItem(clientRes, state) {
    if (!state.reasoningItemStarted || state.reasoningItemDone) return;
    state.reasoningItemDone = true;
    const completedItem = {
      id: state.reasoningId,
      type: 'reasoning',
      status: 'completed',
      summary: state.reasoningText || '',
    };
    writeResponsesSseEvent(clientRes, 'response.reasoning.done', {
      type: 'response.reasoning.done',
      response_id: state.id,
      item_id: state.reasoningId,
      output_index: state.outputIndex,
      text: state.reasoningText || '',
    });
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: state.id,
      output_index: state.outputIndex,
      item: completedItem,
    });
    if (!Array.isArray(state.completedOutputItems)) state.completedOutputItems = [];
    state.completedOutputItems.push(completedItem);
    state.outputIndex += 1;
    state.reasoningId = null;
    state.reasoningItemStarted = false;
    state.reasoningItemDone = false;
    state.reasoningText = '';
  }

  function ensureResponsesTextItem(clientRes, state) {
    ensureResponsesStreamStarted(clientRes, state);
    if (state.textItemStarted) return;
    state.textItemStarted = true;
    state.textItemDone = false;
    state.messageId =
      state.messageId ||
      fallbackId('msg', { response: state.id, model: state.model, outputIndex: state.outputIndex });
    state.text = '';
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item: {
        id: state.messageId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    writeResponsesSseEvent(clientRes, 'response.content_part.added', {
      type: 'response.content_part.added',
      response_id: state.id,
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  function finishResponsesTextItem(clientRes, state) {
    if (!state.textItemStarted || state.textItemDone) return;
    state.textItemDone = true;
    const completedItem = {
      id: state.messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: state.text || '', annotations: [] }],
    };
    writeResponsesSseEvent(clientRes, 'response.output_text.done', {
      type: 'response.output_text.done',
      response_id: state.id,
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: 0,
      text: state.text || '',
    });
    writeResponsesSseEvent(clientRes, 'response.content_part.done', {
      type: 'response.content_part.done',
      response_id: state.id,
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: state.text || '', annotations: [] },
    });
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: state.id,
      output_index: state.outputIndex,
      item: completedItem,
    });
    if (!Array.isArray(state.completedOutputItems)) state.completedOutputItems = [];
    state.completedOutputItems.push(completedItem);
    state.outputIndex += 1;
    state.messageId = null;
    state.textItemStarted = false;
    state.textItemDone = false;
    state.text = '';
  }

  function emitResponsesToolCall(clientRes, state, toolCall) {
    ensureResponsesStreamStarted(clientRes, state);
    finishResponsesTextItem(clientRes, state);
    const prepared = prepareToolCall(toolCall, resolveToolNameInference, {
      index: state.outputIndex,
    });
    if (!prepared) return;
    const { args, parsedArgs, name, seed } = prepared;
    if (
      writeCustomToolCallResponsesEvents({
        clientRes,
        state,
        toolCall,
        name,
        args,
        parsedArgs,
        seed,
        fallbackId,
        callId: responsesFunctionCallCallId(toolCall.id, seed),
        writeEvent: writeResponsesSseEvent,
      })
    ) {
      return;
    }
    const itemId = responsesFunctionCallItemId(toolCall.id, seed);
    const callId = responsesFunctionCallCallId(toolCall.id, seed);
    const item = {
      id: itemId,
      type: 'function_call',
      status: 'in_progress',
      call_id: callId,
      name,
      arguments: '',
    };
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item,
    });
    if (args) {
      writeResponsesSseEvent(clientRes, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        response_id: state.id,
        item_id: itemId,
        output_index: state.outputIndex,
        delta: args,
      });
    }
    writeResponsesSseEvent(clientRes, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      response_id: state.id,
      item_id: itemId,
      output_index: state.outputIndex,
      arguments: args || '{}',
    });
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: state.id,
      output_index: state.outputIndex,
      item: { ...item, status: 'completed', arguments: args || '{}' },
    });
    const completedItem = { ...item, status: 'completed', arguments: args || '{}' };
    if (!Array.isArray(state.completedOutputItems)) state.completedOutputItems = [];
    state.completedOutputItems.push(completedItem);
    state.toolCalls.push(completedItem);
    state.outputIndex += 1;
  }

  function bufferResponsesToolCallDelta(state, toolCall) {
    if (!toolCall) return;
    const index = toolCall.index != null ? toolCall.index : 0;
    if (!state.pendingToolCalls[index]) {
      state.pendingToolCalls[index] = {
        index,
        id: null,
        type: 'function',
        function: { name: '', arguments: '' },
      };
    }
    const pending = state.pendingToolCalls[index];
    if (toolCall.id) pending.id = toolCall.id;
    if (toolCall.type) pending.type = toolCall.type;
    const fn = toolCall.function || {};
    if (fn.name) pending.function.name = fn.name;
    if (typeof fn.arguments === 'string') pending.function.arguments += fn.arguments;
  }

  function flushResponsesToolCalls(clientRes, state) {
    if (!Array.isArray(state.pendingToolCalls)) return;
    for (const pending of state.pendingToolCalls) {
      if (!pending || pending.flushed) continue;
      emitResponsesToolCall(clientRes, state, pending);
      pending.flushed = true;
    }
    state.pendingToolCalls = [];
  }

  function failResponsesStream(clientRes, state, code) {
    if (state.done) return;
    ensureResponsesStreamStarted(clientRes, state);
    state.pendingToolCalls = [];
    finishResponsesReasoningItem(clientRes, state);
    finishResponsesTextItem(clientRes, state);
    state.done = true;
    state.failed = true;
    state.failure = { code, message: 'Upstream Chat stream could not be completed safely' };
    writeResponsesSseEvent(clientRes, 'response.failed', {
      type: 'response.failed',
      response: {
        id: state.id,
        object: 'response',
        status: 'failed',
        model: state.model,
        error: state.failure,
        output: Array.isArray(state.completedOutputItems) ? state.completedOutputItems : [],
        usage: state.usage,
      },
    });
  }

  function finishResponsesStream(clientRes, state) {
    if (state.done) return;
    ensureResponsesStreamStarted(clientRes, state);
    flushResponsesToolCalls(clientRes, state);
    finishResponsesReasoningItem(clientRes, state);
    finishResponsesTextItem(clientRes, state);
    const output = Array.isArray(state.completedOutputItems) ? state.completedOutputItems : [];
    const reason =
      state.finishReason === 'length'
        ? 'max_output_tokens'
        : state.finishReason === 'content_filter'
          ? 'content_filter'
          : null;
    const terminalType = reason ? 'response.incomplete' : 'response.completed';
    writeResponsesSseEvent(clientRes, terminalType, {
      type: terminalType,
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        status: reason ? 'incomplete' : 'completed',
        ...(reason ? { incomplete_details: { reason } } : {}),
        model: state.model,
        output,
        usage: state.usage,
      },
    });
    clientRes.write('data: [DONE]\n\n');
    state.done = true;
  }

  function processOpenAIChatSseEventToResponses(clientRes, event, state) {
    if (state.done) return;
    const lines = String(event || '').split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.indexOf('data:') === 0)
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return;
    const dataText = dataLines.join('\n');
    if (!dataText) return;
    if (dataText === '[DONE]') {
      if (state.finishReason) finishResponsesStream(clientRes, state);
      else failResponsesStream(clientRes, state, 'upstream_stream_incomplete');
      return;
    }
    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch (err) {
      failResponsesStream(clientRes, state, 'upstream_stream_invalid_event');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) {
      failResponsesStream(
        clientRes,
        state,
        payload?.error ? 'upstream_stream_error' : 'upstream_stream_invalid_event'
      );
      return;
    }
    if (payload && payload.usage) {
      state.usage = {
        input_tokens: payload.usage.prompt_tokens || 0,
        output_tokens: payload.usage.completion_tokens || 0,
        total_tokens:
          payload.usage.total_tokens ||
          (payload.usage.prompt_tokens || 0) + (payload.usage.completion_tokens || 0),
      };
    }
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (!choice) return;
    if (state.finishReason) return;
    const delta = choice.delta || {};
    const reasoningDelta =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : typeof delta.thought === 'string'
            ? delta.thought
            : '';
    if (reasoningDelta) {
      flushResponsesToolCalls(clientRes, state);
      ensureResponsesReasoningItem(clientRes, state);
      state.reasoningText = (state.reasoningText || '') + reasoningDelta;
      writeResponsesSseEvent(clientRes, 'response.reasoning.delta', {
        type: 'response.reasoning.delta',
        response_id: state.id,
        item_id: state.reasoningId,
        output_index: state.outputIndex,
        delta: reasoningDelta,
      });
    }
    if (typeof delta.content === 'string' && delta.content) {
      finishResponsesReasoningItem(clientRes, state);
      flushResponsesToolCalls(clientRes, state);
      ensureResponsesTextItem(clientRes, state);
      state.text = (state.text || '') + delta.content;
      writeResponsesSseEvent(clientRes, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        response_id: state.id,
        item_id: state.messageId,
        output_index: state.outputIndex,
        content_index: 0,
        delta: delta.content,
      });
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      finishResponsesReasoningItem(clientRes, state);
      finishResponsesTextItem(clientRes, state);
      for (const toolCall of delta.tool_calls) {
        if (
          !toolCall ||
          (toolCall.index != null &&
            (!Number.isSafeInteger(toolCall.index) || toolCall.index < 0 || toolCall.index > 4095))
        ) {
          failResponsesStream(clientRes, state, 'upstream_stream_invalid_tool_index');
          return;
        }
        bufferResponsesToolCallDelta(state, toolCall);
      }
    }
    if (choice.finish_reason === 'tool_calls') flushResponsesToolCalls(clientRes, state);
    if (choice.finish_reason) state.finishReason = choice.finish_reason;
  }

  function processOpenAIChatSseChunkToResponses(clientRes, chunkText, state) {
    if (state.done) return;
    try {
      appendSseBuffer(state, chunkText, 'OpenAI Chat');
    } catch (_error) {
      failResponsesStream(clientRes, state, 'upstream_stream_event_too_large');
      return;
    }
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const event of events) processOpenAIChatSseEventToResponses(clientRes, event, state);
  }

  function flushOpenAIChatSseToResponses(clientRes, state) {
    if (state.buffer && state.buffer.trim())
      processOpenAIChatSseEventToResponses(clientRes, state.buffer, state);
    state.buffer = '';
    if (!state.done) {
      if (state.invalidEvent || !state.finishReason) {
        failResponsesStream(
          clientRes,
          state,
          state.invalidEvent ? 'upstream_stream_invalid_event' : 'upstream_stream_incomplete'
        );
      } else finishResponsesStream(clientRes, state);
    }
    return {
      failed: state.failed === true,
      incomplete: ['length', 'content_filter'].includes(state.finishReason),
    };
  }

  function openAIResponsesToChatResponse(payload, model) {
    if (!payload || typeof payload !== 'object') return null;

    const choices = [];
    const output = Array.isArray(payload.output) ? payload.output : [];

    let assistantText = '';
    let assistantReasoning = '';
    const toolCalls = [];

    for (const item of output) {
      if (!item) continue;
      if (item.type === 'reasoning') {
        const reasoningText = messageNormalization.reasoningSummaryText(item);
        if (reasoningText) {
          assistantReasoning += reasoningText;
        }
      } else if (item.type === 'message' && item.role === 'assistant') {
        if (typeof item.content === 'string') {
          assistantText += item.content;
        } else if (Array.isArray(item.content)) {
          const text = item.content
            .filter((p) => p && (p.type === 'output_text' || p.type === 'text'))
            .map((p) => p.text || '')
            .join('');
          assistantText += text;
        }
      } else if (item.type === 'function_call') {
        const args =
          typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments || {});
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(args);
        } catch (err) {}
        const name = item.name || resolveToolNameInference(parsedArgs);
        if (!name) continue;
        toolCalls.push({
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name,
            arguments: args,
          },
        });
      }
    }

    const message = {
      role: 'assistant',
      content: assistantText || null,
    };
    if (assistantReasoning) {
      message.reasoning_content = assistantReasoning;
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    let finishReason = 'stop';
    if (toolCalls.length > 0) {
      finishReason = 'tool_calls';
    } else if (payload.status === 'incomplete') {
      finishReason = 'length';
    }

    choices.push({
      index: 0,
      message,
      finish_reason: finishReason,
    });

    const usage = payload.usage
      ? {
          prompt_tokens: payload.usage.input_tokens || 0,
          completion_tokens: payload.usage.output_tokens || 0,
          total_tokens:
            payload.usage.total_tokens ||
            (payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0),
        }
      : undefined;

    const id = payload.id
      ? payload.id.replace(/^resp/, 'chatcmpl')
      : fallbackId('chatcmpl', { model, output });

    return {
      id,
      object: 'chat.completion',
      created: payload.created_at || stableCreated({ model, output }),
      model: model || payload.model,
      choices,
      usage,
    };
  }

  function writeOpenAIChatSseChunkFromResponses(clientRes, state, delta, finishReason) {
    const chunk = {
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
    };
    if (state.usage) {
      chunk.usage = state.usage;
    }
    clientRes.write('data: ' + JSON.stringify(chunk) + '\n\n');
  }

  const responsesChatTerminal = createResponsesChatTerminalStateMachine({
    writeChatChunk: writeOpenAIChatSseChunkFromResponses,
  });

  function responseToolCallBuffer(state, itemId) {
    if (!state.responseToolCallBuffers) state.responseToolCallBuffers = new Map();
    const id = itemId || fallbackId('call', { index: state.responseToolCallBuffers.size });
    let entry = state.responseToolCallBuffers.get(id);
    if (!entry) {
      entry = { id, arguments: '', emitted: false };
      state.responseToolCallBuffers.set(id, entry);
    }
    return entry;
  }

  function emitBufferedResponseToolCall(clientRes, state, item) {
    const itemId = item.call_id || item.id;
    const entry = responseToolCallBuffer(state, itemId);
    const args = item.arguments != null ? item.arguments : entry.arguments;
    let parsedArgs = {};
    if (typeof args === 'string' && args.trim()) {
      try {
        parsedArgs = JSON.parse(args);
      } catch (err) {}
    } else if (args && typeof args === 'object') {
      parsedArgs = args;
    }
    const name = item.name || entry.name || resolveToolNameInference(parsedArgs);
    if (!name) return;

    let toolIndex = state.toolCalls.indexOf(entry.id);
    if (toolIndex === -1) {
      toolIndex = state.toolCalls.length;
      state.toolCalls.push(entry.id);
    }
    if (entry.emitted) return;
    entry.emitted = true;
    writeOpenAIChatSseChunkFromResponses(clientRes, state, {
      tool_calls: [
        {
          index: toolIndex,
          id: entry.id,
          type: 'function',
          function: {
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
          },
        },
      ],
    });
  }

  function processOpenAIResponsesSseEventToChat(clientRes, event, state) {
    if (state.done) return;
    const lines = String(event || '').split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.indexOf('data:') === 0)
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return;
    const dataText = dataLines.join('\n');
    if (!dataText || dataText === '[DONE]') {
      flushOpenAIResponsesSseToChat(clientRes, state);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch (err) {
      state.invalidEvent = true;
      return;
    }

    if (payload.type === 'response.created' || payload.type === 'response.in_progress') {
      const response = payload.response || {};
      if (response.id) state.id = String(response.id).replace(/^resp/, 'chatcmpl');
      if (response.created_at) state.created = response.created_at;
      if (!state.started) {
        state.started = true;
        writeOpenAIChatSseChunkFromResponses(clientRes, state, {
          role: 'assistant',
          content: '',
        });
      }
      return;
    }

    if (payload.type === 'response.output_item.added' && payload.item) {
      const item = payload.item;
      if (item.type === 'message' && item.role === 'assistant') {
        if (!state.started) {
          state.started = true;
          writeOpenAIChatSseChunkFromResponses(clientRes, state, {
            role: 'assistant',
            content: '',
          });
        }
      }
      return;
    }

    if (payload.type === 'response.output_text.delta' && payload.delta) {
      if (!state.started) {
        state.started = true;
        writeOpenAIChatSseChunkFromResponses(clientRes, state, { role: 'assistant', content: '' });
      }
      writeOpenAIChatSseChunkFromResponses(clientRes, state, { content: payload.delta });
      return;
    }

    if (
      (payload.type === 'response.reasoning.delta' ||
        payload.type === 'response.reasoning_text.delta') &&
      payload.delta
    ) {
      if (!state.started) {
        state.started = true;
        writeOpenAIChatSseChunkFromResponses(clientRes, state, { role: 'assistant', content: '' });
      }
      writeOpenAIChatSseChunkFromResponses(clientRes, state, { reasoning_content: payload.delta });
      return;
    }

    if (payload.type === 'response.function_call_arguments.delta' && payload.delta) {
      const item_id = payload.item_id;
      const entry = responseToolCallBuffer(state, item_id);
      entry.arguments += payload.delta;
      return;
    }

    if (payload.type === 'response.output_item.done' && payload.item) {
      const item = payload.item;
      if (item.type === 'function_call') {
        emitBufferedResponseToolCall(clientRes, state, item);
      }
      return;
    }

    responsesChatTerminal.handleTerminalEvent(clientRes, state, payload);
  }

  function processOpenAIResponsesSseChunkToChat(clientRes, chunkText, state) {
    appendSseBuffer(state, chunkText, 'OpenAI Responses');
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const event of events) processOpenAIResponsesSseEventToChat(clientRes, event, state);
  }

  function flushOpenAIResponsesSseToChat(clientRes, state, options = {}) {
    const pendingEvent = state.buffer;
    state.buffer = '';
    if (pendingEvent && pendingEvent.trim())
      processOpenAIResponsesSseEventToChat(clientRes, pendingEvent, state);
    const outcome = responsesChatTerminal.flush(clientRes, state, options);
    if (state.responseToolCallBuffers) state.responseToolCallBuffers.clear();
    return outcome;
  }

  return {
    openAIContentToClaudeContent,
    openAIToolCallToClaudeBlock,
    openAIToolResultContentToClaude,
    openAIChatToClaudeMessages,
    claudeContentBlockToOpenAIMessage,
    claudeToolUseToOpenAIToolCall,
    claudeResponseToOpenAIChat,
    openAIChunkFinishReason,
    writeOpenAIChatSseChunk,
    flushOpenAIStreamToolCall,
    processClaudeSseEventToOpenAI,
    processClaudeSseChunkToOpenAI,
    flushClaudeSseToOpenAI,
    claudeContentToOpenAIContent,
    claudeToolUseToOpenAIToolMessage,
    claudeToolToOpenAITool,
    claudeToolChoiceToOpenAI,
    claudeMessagesToOpenAIChat,
    openAIMessageToClaudeContent,
    openAIResponseToClaudeMessage,
    hasResponsesNativeWebSearchTool,
    openAIResponsesToChat,
    mergeAdjacentAssistantMessages,
    openAIChatToResponses,
    processOpenAIChatSseChunkToResponses,
    flushOpenAIChatSseToResponses,
    openAIChatToResponsesRequest,
    openAIResponsesToChatResponse,
    processOpenAIResponsesSseChunkToChat,
    flushOpenAIResponsesSseToChat,
  };
}

module.exports = { createOpenAIProtocol };
