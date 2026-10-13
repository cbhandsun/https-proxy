const { createChatClaudeStream } = require('./chat-claude-stream');
const { resolveCreatedTimestamp } = require('./ids');
const { applyConvertedOutputFormat } = require('./converted-output-format');
const { applyConvertedServiceTier } = require('./converted-service-tier');
const { resolveConvertedOutputTokenLimit } = require('./converted-request-scalars');
const { assertJsonObjectCompletion } = require('./json-object-output-contract');
const { createClaudeResponsesRequestConverter } = require('./claude-responses-request');
const { createResponsesClaudeStream } = require('./responses-claude-stream');
const { createResponsesStreamDecoder } = require('./responses-stream-decoder');
const {
  createResponsesClaudeResponseConverter,
  claudeJsonStopReason,
} = require('./responses-claude-response');
const { createResponsesResponseBuilder } = require('./responses-response-builder');
const { createClaudeResponsesStream } = require('./claude-responses-stream');
const { createResponsesStreamEmitter } = require('./responses-stream-emitter');
const { createAnthropicProviderContextItem } = require('./provider-context-history');
const { CHAT_STREAM_CHUNK, checkInternalEventSize } = require('./internal-stream-events');
const { functionToolContract } = require('./function-tool-contract');
const { createClaudeChatStreamConverter } = require('./protocol-claude-chat-stream');
const { toolArgumentsComplete, chatResponseToolCalls } = require('./protocol-tool-completion');
const {
  createConversionStreamBudget,
  conversionFailureCode,
} = require('./conversion-stream-budget');
const { chatIncompleteReason } = require('./protocol-terminal');
const { createResponsesResponseConverter } = require('./protocol-openai-responses-response');
const { applyContextBudgetToMessages } = require('./context-budget-manager');
const { carryResponsesHistoryPolicy } = require('./responses-history-policy');
const { validateResponsesEndpointOptions } = require('./responses-endpoint-options');
const { applyProviderCacheHintsToRequest } = require('./context-cache-hints');
const { createSseEventParser, parseBoundedInteger } = require('./sse-buffer');
const {
  classifyResponsesWebSearchTools,
  hasResponsesNativeWebSearchTool,
} = require('./openai-web-search-tools');
const {
  appendChatToolCallsAsResponses,
  collectCustomToolNames,
} = require('./responses-custom-tools');
const { createResponsesChatTerminalStateMachine } = require('./protocol-openai-responses-stream');
const {
  inspectOpenAIMultimodalPart,
  multimodalBlockToOpenAIChatPart,
} = require('./multimodal-content');
const {
  extractCanonicalReasoning,
  parseOpenAIReasoningEffort,
  applyReasoningToClaude,
  applyReasoningToOpenAI,
} = require('./reasoning-adapter');
const messageNormalization = require('./protocol-openai-message-normalization');
const { normalizeClaudeModernOptions } = require('./claude-modern-options');
const { applyNativeGeminiReasoning } = require('./native-reasoning-controls');
const { applyConvertedParallelTools } = require('./converted-parallel-tools');
const { createResponsesClaudeRequestConverter } = require('./responses-claude-request');
const {
  convertUsageDetails,
  claudeUsageToOpenAIChatUsage,
  openAIChatUsageToClaudeUsage,
} = require('./protocol-usage-details');
const {
  createResponsesRequestConverter,
  inferToolNameFromArguments,
  normalizeServiceTier,
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

  const parseSseEvents = createSseEventParser(maxSseBufferChars);
  const streamBudget = createConversionStreamBudget(protocolOptions || {});
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

  const {
    responsesToolCallToChatToolCall,
    openAIResponsesToChatResponse,
    decodeResponsesResponse,
  } = createResponsesResponseConverter({
    fallbackId,
    stableCreated,
    resolveToolNameInference,
    messageNormalization,
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
  function openAIChatToClaudeMessages(body, model, options = {}) {
    const result = carryResponsesHistoryPolicy({ model }, body);
    applyConvertedOutputFormat(result, body, 'chat', 'Claude', model);
    applyConvertedServiceTier(result, body, 'openai', 'Claude');
    if (body && body.__nativeWebSearch) result.__nativeWebSearch = body.__nativeWebSearch;
    if (body && body.__managedWebSearchHistoryAsText) {
      result.__managedWebSearchHistoryAsText = true;
    }
    const contextProtocolOptions =
      options.nativeContextManagement === true
        ? { ...(protocolOptions || {}), contextWindowPolicy: 'disabled' }
        : protocolOptions || {};
    const budgetedMessages = applyContextBudgetToMessages(
      body.messages || [],
      body,
      model,
      contextProtocolOptions,
      {
        estimateMessageTokens: messageNormalization.estimatePayloadTokens,
        fixedInputTokens: messageNormalization.estimatePayloadTokens(body.tools || []),
        fixedInputValue: body.tools || [],
      }
    );
    const bodyMessages = budgetedMessages.messages;

    result.max_tokens = resolveConvertedOutputTokenLimit(body) ?? 4096;
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
          ...functionToolContract(tool.function, 'parameters', 'input_schema'),
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
    applyConvertedParallelTools(result, body, 'Claude');
    if (options.target === 'Gemini') applyNativeGeminiReasoning(result, body, model);
    else
      applyReasoningToClaude(result, extractCanonicalReasoning(body), {
        model,
        relativeEffort: Boolean(parseOpenAIReasoningEffort(body).effort),
        explicitOutputLimit: resolveConvertedOutputTokenLimit(body) !== undefined,
      });
    const diagnostics = { contextBudget: budgetedMessages.diagnostics };
    applyProviderCacheHintsToRequest(result, 'anthropic', diagnostics, protocolOptions || {});
    Object.defineProperty(result, '__hpmDiagnostics', {
      value: diagnostics,
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
      usage: claudeUsageToOpenAIChatUsage(payload && payload.usage) || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_input_tokens: 0,
      },
    };
  }

  function openAIChunkFinishReason(stopReason, hasToolCalls) {
    if (hasToolCalls) return 'tool_calls';
    if (stopReason === 'max_tokens') return 'length';
    return 'stop';
  }

  function writeOpenAIChatSseChunk(clientRes, state, delta, finishReason) {
    const chunk = {
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
    };
    if (state.usage && finishReason) chunk.usage = state.usage;
    const wire = 'data: ' + JSON.stringify(chunk) + '\n\n';
    if (typeof clientRes[CHAT_STREAM_CHUNK] === 'function')
      clientRes[CHAT_STREAM_CHUNK](chunk, wire);
    else clientRes.write(wire);
  }

  const {
    processClaudeDataToOpenAI,
    processClaudeSseEventToOpenAI,
    processClaudeSseChunkToOpenAI,
    flushClaudeSseToOpenAI,
  } = createClaudeChatStreamConverter({
    parseClaudeSseEvent,
    deltaPartialJson,
    cleanToolArgs,
    protocolOptions,
    parseSseEvents,
    streamBudget,
    writeChunk: writeOpenAIChatSseChunk,
    finishReason: openAIChunkFinishReason,
  });

  function processClaudeEventToOpenAI(clientRes, name, data, wire, state) {
    processClaudeDataToOpenAI(clientRes, name, data, wire, state, maxSseBufferChars);
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
        ...functionToolContract(tool, 'input_schema', 'parameters'),
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
    body = normalizeClaudeModernOptions(body, 'Chat', { model });
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
    applyConvertedServiceTier(result, body, 'claude', 'Chat');
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
    if (body.response_format != null) result.response_format = body.response_format;
    if (body.parallel_tool_calls != null) result.parallel_tool_calls = body.parallel_tool_calls;
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
    const reason = choice?.finish_reason;
    const stop = claudeJsonStopReason(reason, false);
    const content = openAIMessageToClaudeContent(
      reason === 'length' ? { ...message, tool_calls: [] } : message
    );
    const hasToolCalls =
      (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
      content.some((b) => b && b.type === 'tool_use') ||
      (choice && choice.finish_reason === 'tool_calls');
    const stopReason = reason === 'length' ? stop : claudeJsonStopReason(reason, hasToolCalls);
    return {
      id: payload && payload.id ? payload.id : fallbackId('msg_openai', { model, message }),
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: openAIChatUsageToClaudeUsage(payload?.usage),
    };
  }

  const responsesResponseToClaude = createResponsesClaudeResponseConverter({
    decodeResponsesResponse,
    toolToClaude: openAIToolCallToClaudeBlock,
    protocolOptions,
  });
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

  const { openAIChatToResponsesRequest, responsesFunctionCallItemId, responsesFunctionCallCallId } =
    createResponsesRequestConverter({
      fallbackId,
      chatToolContentToResponsesOutput: messageNormalization.chatToolContentToResponsesOutput,
      protocolOptions,
    });
  const claudeMessagesToResponsesRequest = createClaudeResponsesRequestConverter({
    cleanToolArgs,
    fallbackId,
    protocolOptions,
  });

  function openAIResponsesToChat(body, options = {}) {
    validateResponsesEndpointOptions(body, 'Chat', undefined, options);
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
    if (body.text?.verbosity != null) result.verbosity = body.text.verbosity;
    applyConvertedOutputFormat(result, body, 'responses', 'Chat', body.model);
    if (body.stream === true) result.stream = true;
    if (body.temperature != null) result.temperature = body.temperature;
    if (body.top_p != null) result.top_p = body.top_p;
    const outputLimit = resolveConvertedOutputTokenLimit(body);
    if (outputLimit !== undefined) result.max_tokens = outputLimit;
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
    const serviceTier = normalizeServiceTier(body.service_tier);
    if (serviceTier) result.service_tier = serviceTier;
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
    return result;
  }

  function openAIChatToResponses(payload, model, options = {}) {
    assertJsonObjectCompletion(payload, 'chat', options);
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = choice && choice.message ? choice.message : {};
    const toolCalls = chatResponseToolCalls(
      message,
      message.function_call
        ? fallbackId('call', { response: payload?.id, model, function: message.function_call })
        : undefined
    );
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
    if (typeof message.refusal === 'string' && message.refusal.trim()) {
      output.push({
        id: fallbackId('msg', { model, refusal: message.refusal }),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: message.refusal }],
      });
    }
    const customToolNames =
      options && options.customToolNames
        ? options.customToolNames
        : collectCustomToolNames(options && (options.responsesRequest || options));
    appendChatToolCallsAsResponses({
      output,
      toolCalls,
      customToolNames,
      fallbackId,
      inferToolNameFromArguments: resolveToolNameInference,
      functionCallItemId: responsesFunctionCallItemId,
      functionCallCallId: responsesFunctionCallCallId,
    });
    const invalidToolArguments =
      !chatIncompleteReason(choice?.finish_reason) &&
      Array.isArray(toolCalls) &&
      toolCalls.some((call) => !toolArgumentsComplete(call, customToolNames));
    if (chatIncompleteReason(choice?.finish_reason) || invalidToolArguments) {
      for (const item of output) {
        if (item.type === 'function_call' || item.type === 'custom_tool_call')
          item.status = 'incomplete';
      }
    }
    const usage =
      payload && payload.usage
        ? {
            input_tokens: payload.usage.prompt_tokens || 0,
            output_tokens: payload.usage.completion_tokens || 0,
            total_tokens:
              payload.usage.total_tokens ||
              (payload.usage.prompt_tokens || 0) + (payload.usage.completion_tokens || 0),
            ...convertUsageDetails(payload.usage, true),
          }
        : undefined;
    const finishReason = choice && choice.finish_reason;
    const incompleteReason = chatIncompleteReason(finishReason);
    const incompleteDetails = incompleteReason ? { reason: incompleteReason } : undefined;
    return {
      id:
        payload && payload.id
          ? payload.id.replace(/^chatcmpl/, 'resp')
          : fallbackId('resp', { model, output }),
      object: 'response',
      created_at: resolveCreatedTimestamp(payload && payload.created, () =>
        stableCreated({ model, output })
      ),
      status: invalidToolArguments ? 'failed' : incompleteDetails ? 'incomplete' : 'completed',
      ...(invalidToolArguments
        ? {
            error: {
              code: 'upstream_stream_invalid_tool_arguments',
              message: 'Upstream Chat tool arguments are incomplete or invalid',
            },
          }
        : {}),
      ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
      model,
      output,
      usage,
    };
  }

  const buildResponsesResponse = createResponsesResponseBuilder({
    fallbackId,
    stableCreated,
    cleanToolArgs,
    inferToolNameFromArguments: resolveToolNameInference,
    functionCallItemId: responsesFunctionCallItemId,
    functionCallCallId: responsesFunctionCallCallId,
    protocolOptions,
  });
  function claudeResponseToResponses(payload, model, options) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !Array.isArray(payload.content) ||
      typeof payload.id !== 'string' ||
      !payload.id
    )
      throw new TypeError('Invalid upstream Claude response');
    if (
      payload.content.some(
        (part) =>
          !part ||
          typeof part !== 'object' ||
          Array.isArray(part) ||
          ['text', 'thinking', 'signature'].some(
            (key) => part[key] != null && typeof part[key] !== 'string'
          )
      )
    )
      throw new TypeError('Invalid upstream Claude content');
    const compactionBlocks = payload.content.filter((part) => part?.type === 'compaction');
    if (
      compactionBlocks.length > 1 ||
      (compactionBlocks.length === 1 && payload.content[0] !== compactionBlocks[0])
    )
      throw new TypeError('Invalid upstream Claude compaction order');
    const visibleContent = payload.content.filter((part) => part?.type !== 'compaction');
    const parts =
      typeof filterClaudeCompatibleBlocks === 'function'
        ? filterClaudeCompatibleBlocks(visibleContent)
        : visibleContent;
    if (parts.some((part) => !part || typeof part !== 'object' || Array.isArray(part)))
      throw new TypeError('Invalid upstream Claude content');
    const response = buildResponsesResponse({
      parts,
      id: payload.id,
      model,
      stopReason: payload.stop_reason,
      usage: payload.usage,
      options,
      textForPart: claudeContentBlockToOpenAIMessage,
      isThinking: isClaudeThinkingBlock,
    });
    if (compactionBlocks.length) {
      const providerContextItems = compactionBlocks.map((block) =>
        createAnthropicProviderContextItem(block, 0)
      );
      Object.defineProperty(response, '__hpmProviderContextItems', {
        value: providerContextItems,
        enumerable: false,
        configurable: true,
      });
    }
    return response;
  }

  function createEmitter(boundOutput = false) {
    return createResponsesStreamEmitter({
      fallbackId,
      resolveToolNameInference,
      responsesFunctionCallItemId,
      responsesFunctionCallCallId,
      streamBudget,
      boundOutput,
    });
  }
  const responsesEmitter = createEmitter();
  const {
    finishResponsesStream,
    failResponsesStream,
    finishResponsesReasoningItem,
    finishResponsesTextItem,
    bufferResponsesToolCallDelta,
    flushResponsesToolCalls,
  } = responsesEmitter;

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
    processChatPayloadToResponses(clientRes, payload, state);
  }

  function processChatPayloadToResponses(clientRes, payload, state) {
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
        cached_input_tokens:
          payload.usage.cached_input_tokens || payload.usage.cachedInputTokens || 0,
        ...convertUsageDetails(payload.usage, true),
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
    responsesEmitter.reasoning(clientRes, state, reasoningDelta);
    if (state.done) return;
    if (typeof delta.content === 'string') responsesEmitter.text(clientRes, state, delta.content);
    if (state.done) return;
    if (typeof delta.refusal === 'string')
      responsesEmitter.refusal(clientRes, state, delta.refusal);
    if (state.done) return;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      if (state.legacyToolSeen) {
        failResponsesStream(clientRes, state, 'upstream_stream_invalid_tool_arguments');
        return;
      }
      state.modernToolSeen = true;
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
    if (delta.function_call != null) {
      const fn = delta.function_call;
      if (
        state.modernToolSeen ||
        !fn ||
        typeof fn !== 'object' ||
        Array.isArray(fn) ||
        (fn.name != null && typeof fn.name !== 'string') ||
        (fn.arguments != null && typeof fn.arguments !== 'string')
      ) {
        failResponsesStream(clientRes, state, 'upstream_stream_invalid_tool_arguments');
        return;
      }
      state.legacyToolSeen = true;
      state.legacyFunctionName = (state.legacyFunctionName || '') + (fn.name || '');
      finishResponsesReasoningItem(clientRes, state);
      finishResponsesTextItem(clientRes, state);
      bufferResponsesToolCallDelta(state, {
        index: 0,
        id: fallbackId('call', { response: state.id, legacy: true }),
        function: {
          name: state.legacyFunctionName,
          ...(fn.arguments != null ? { arguments: fn.arguments } : {}),
        },
      });
    }
    if (
      choice.finish_reason &&
      !chatIncompleteReason(choice.finish_reason) &&
      ((choice.finish_reason === 'function_call' && !state.legacyToolSeen) ||
        (state.legacyToolSeen && !state.legacyFunctionName?.trim()))
    ) {
      failResponsesStream(clientRes, state, 'upstream_stream_invalid_tool_arguments');
      return;
    }
    if (choice.finish_reason === 'tool_calls') flushResponsesToolCalls(clientRes, state);
    if (choice.finish_reason) state.finishReason = choice.finish_reason;
  }

  function processOpenAIChatChunkToResponses(clientRes, payload, wire, state) {
    if (state.done) return;
    try {
      streamBudget.consume(state, wire);
      checkInternalEventSize(wire, maxSseBufferChars);
      processChatPayloadToResponses(clientRes, payload, state);
    } catch (error) {
      state.buffer = '';
      failResponsesStream(clientRes, state, conversionFailureCode(error));
    }
  }

  function processOpenAIChatSseChunkToResponses(clientRes, chunkText, state) {
    if (state.done) return;
    try {
      streamBudget.consume(state, chunkText);
      parseSseEvents(state, chunkText, 'OpenAI Chat', (event) =>
        processOpenAIChatSseEventToResponses(clientRes, event, state)
      );
    } catch (error) {
      state.buffer = '';
      failResponsesStream(clientRes, state, conversionFailureCode(error));
    }
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
    const wire = 'data: ' + JSON.stringify(chunk) + '\n\n';
    if (typeof clientRes[CHAT_STREAM_CHUNK] === 'function')
      clientRes[CHAT_STREAM_CHUNK](chunk, wire);
    else clientRes.write(wire);
  }

  const responsesChatTerminal = createResponsesChatTerminalStateMachine({
    writeChatChunk: writeOpenAIChatSseChunkFromResponses,
  });

  const {
    processChunk: processOpenAIResponsesSseChunkToChat,
    flush: flushOpenAIResponsesSseToChat,
  } = createResponsesStreamDecoder({
    streamBudget,
    parseSseEvents,
    toolToSemantic: responsesToolCallToChatToolCall,
    terminal: responsesChatTerminal,
    target: {
      start: (sink, state) =>
        writeOpenAIChatSseChunkFromResponses(sink, state, { role: 'assistant', content: '' }),
      text: (sink, state, value) =>
        writeOpenAIChatSseChunkFromResponses(sink, state, { content: value }),
      refusal: (sink, state, value) =>
        writeOpenAIChatSseChunkFromResponses(sink, state, { refusal: value }),
      reasoning: (sink, state, value) =>
        writeOpenAIChatSseChunkFromResponses(sink, state, { reasoning_content: value }),
      tool: (sink, state, call, index) =>
        writeOpenAIChatSseChunkFromResponses(sink, state, { tool_calls: [{ index, ...call }] }),
    },
  });

  return {
    buildResponsesResponse,
    responsesHistoryToClaude: createResponsesClaudeRequestConverter({
      cleanToolArgs,
      mergeAdjacentClaudeMessages,
      protocolOptions,
    }),
    claudeResponseToResponses,
    createResponsesStreamEmitter: createEmitter,
    createChatClaudeStream: (options) =>
      createChatClaudeStream({
        options,
        deps: { protocolOptions, toolToClaude: openAIToolCallToClaudeBlock },
      }),
    createResponsesClaudeStream: (options) =>
      createResponsesClaudeStream({
        options,
        deps: {
          protocolOptions,
          toolToSemantic: responsesToolCallToChatToolCall,
          toolToClaude: openAIToolCallToClaudeBlock,
        },
      }),
    createClaudeResponsesStream: (responseState) =>
      createClaudeResponsesStream({
        responseState,
        emitter: createEmitter(true),
        deps: {
          parseClaudeSseEvent,
          deltaPartialJson,
          cleanToolArgs,
          protocolOptions,
          parseSseEvents,
          streamBudget,
        },
      }),
    openAIContentToClaudeContent,
    openAIToolCallToClaudeBlock,
    openAIToolResultContentToClaude,
    openAIChatToClaudeMessages,
    claudeContentBlockToOpenAIMessage,
    claudeToolUseToOpenAIToolCall,
    claudeResponseToOpenAIChat,
    openAIChunkFinishReason,
    writeOpenAIChatSseChunk,
    processClaudeEventToOpenAI,
    processClaudeSseEventToOpenAI,
    processClaudeSseChunkToOpenAI,
    flushClaudeSseToOpenAI,
    claudeContentToOpenAIContent,
    claudeToolUseToOpenAIToolMessage,
    claudeToolToOpenAITool,
    claudeToolChoiceToOpenAI,
    claudeMessagesToOpenAIChat,
    claudeMessagesToResponsesRequest,
    openAIMessageToClaudeContent,
    openAIResponseToClaudeMessage,
    responsesResponseToClaude,
    hasResponsesNativeWebSearchTool,
    openAIResponsesToChat,
    mergeAdjacentAssistantMessages,
    openAIChatToResponses,
    processOpenAIChatChunkToResponses,
    processOpenAIChatSseChunkToResponses,
    flushOpenAIChatSseToResponses,
    openAIChatToResponsesRequest,
    openAIResponsesToChatResponse,
    processOpenAIResponsesSseChunkToChat,
    flushOpenAIResponsesSseToChat,
  };
}

module.exports = { createOpenAIProtocol };
