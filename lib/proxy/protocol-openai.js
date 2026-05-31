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
  } = deps;

  function openAIContentToClaudeContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content);
    return content.map((part) => {
      if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
      if (part.type === 'text') return { type: 'text', text: part.text || '' };
      if (part.type === 'image_url') {
        const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
        const match = String(imageUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
        if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
        return { type: 'text', text: imageUrl || '' };
      }
      return { type: 'text', text: JSON.stringify(part) };
    });
  }

  function openAIToolCallToClaudeBlock(toolCall) {
    const fn = toolCall && toolCall.function ? toolCall.function : {};
    let input = {};
    if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
      try { input = JSON.parse(fn.arguments); } catch (err) { input = { arguments: fn.arguments }; }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      input = fn.arguments;
    }
    const toolName = fn.name || toolCall.name || 'tool';
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
    if (body.max_tokens != null) result.max_tokens = body.max_tokens;
    else if (body.max_completion_tokens != null) result.max_tokens = body.max_completion_tokens;
    else result.max_tokens = 4096;
    if (body.temperature != null) result.temperature = body.temperature;
    if (body.top_p != null) result.top_p = body.top_p;
    if (body.stop != null) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.stream === true) result.stream = true;

    const messages = [];
    const systemParts = [];
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      if (!message) continue;
      if (message.role === 'system') {
        const content = openAIContentToClaudeContent(message.content);
        if (typeof content === 'string') systemParts.push({ type: 'text', text: content });
        else systemParts.push(...content.filter((part) => part && part.type === 'text'));
        continue;
      }
      if (message.role === 'tool') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: openAIToolResultContentToClaude(message.content) }] });
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
        if (Array.isArray(message.tool_calls)) content.push(...message.tool_calls.map(openAIToolCallToClaudeBlock));
        messages.push({ role: 'assistant', content: content.length > 0 ? content : '' });
        continue;
      }
      messages.push({ role: 'user', content: openAIContentToClaudeContent(message.content) });
    }
    if (systemParts.length === 1) result.system = systemParts[0].text;
    else if (systemParts.length > 1) result.system = systemParts;
    result.messages = messages;

    if (Array.isArray(body.tools)) {
      result.tools = body.tools.filter((tool) => tool && tool.type === 'function' && tool.function).map((tool) => ({
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} },
      }));
    }
    if (body.tool_choice) {
      if (body.tool_choice === 'none') result.tool_choice = { type: 'none' };
      else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
      else if (body.tool_choice && body.tool_choice.type === 'function') result.tool_choice = { type: 'tool', name: body.tool_choice.function && body.tool_choice.function.name };
    }
    return result;
  }

  function claudeContentBlockToOpenAIMessage(block) {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    return JSON.stringify(block);
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
    const content = Array.isArray(payload && payload.content) ? payload.content : [];
    const text = content.filter((block) => !block || (block.type !== 'tool_use' && !isClaudeThinkingBlock(block))).map(claudeContentBlockToOpenAIMessage).join('');
    const toolCalls = content.filter((block) => block && block.type === 'tool_use').map(claudeToolUseToOpenAIToolCall);
    const message = { role: 'assistant', content: text || null };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    const id = payload && payload.id ? payload.id : fallbackId('chatcmpl', { model, content, toolCalls });
    return {
      id,
      object: 'chat.completion',
      created: stableCreated(id),
      model,
      choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : (payload && payload.stop_reason === 'max_tokens' ? 'length' : 'stop') }],
      usage: {
        prompt_tokens: payload && payload.usage ? payload.usage.input_tokens || 0 : 0,
        completion_tokens: payload && payload.usage ? payload.usage.output_tokens || 0 : 0,
        total_tokens: payload && payload.usage ? (payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0) : 0,
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
    clientRes.write('data: ' + JSON.stringify(chunk) + '\n\n');
  }

  function flushOpenAIStreamToolCall(clientRes, state) {
    const pending = state.pendingToolCall;
    if (!pending) return;
    state.pendingToolCall = null;
    let args = pending.input || {};
    if (pending.partialJson && pending.partialJson.trim()) {
      try { args = { ...args, ...JSON.parse(pending.partialJson) }; } catch (err) { args = { ...args, arguments: pending.partialJson }; }
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
    if (parsed.eventName === 'content_block_start' && data.content_block && data.content_block.type === 'tool_use') {
      flushOpenAIStreamToolCall(clientRes, state);
      state.pendingToolCall = {
        id: data.content_block.id,
        name: data.content_block.name,
        input: data.content_block.input || {},
        partialJson: '',
      };
      return;
    }
    if (parsed.eventName === 'content_block_delta' && data.delta) {
      if (state.pendingToolCall) {
        const partialJson = deltaPartialJson(data.delta);
        if (partialJson) state.pendingToolCall.partialJson += partialJson;
        return;
      }
      if (data.delta.type === 'text_delta' && data.delta.text) writeOpenAIChatSseChunk(clientRes, state, { content: data.delta.text });
      return;
    }
    if (parsed.eventName === 'content_block_stop') {
      flushOpenAIStreamToolCall(clientRes, state);
      return;
    }
    if (parsed.eventName === 'message_delta') {
      if (data.delta && data.delta.stop_reason) state.stopReason = data.delta.stop_reason;
      return;
    }
    if (parsed.eventName === 'message_stop') {
      flushOpenAIStreamToolCall(clientRes, state);
      writeOpenAIChatSseChunk(clientRes, state, {}, openAIChunkFinishReason(state.stopReason, state.hasToolCalls));
      clientRes.write('data: [DONE]\n\n');
      state.done = true;
    }
  }

  function processClaudeSseChunkToOpenAI(clientRes, chunkText, state) {
    state.buffer += chunkText;
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const event of events) processClaudeSseEventToOpenAI(clientRes, event, state);
  }

  function flushClaudeSseToOpenAI(clientRes, state) {
    if (state.buffer && state.buffer.trim()) processClaudeSseEventToOpenAI(clientRes, state.buffer, state);
    state.buffer = '';
    if (!state.done) {
      flushOpenAIStreamToolCall(clientRes, state);
      writeOpenAIChatSseChunk(clientRes, state, {}, openAIChunkFinishReason(state.stopReason, state.hasToolCalls));
      clientRes.write('data: [DONE]\n\n');
      state.done = true;
    }
  }

  function claudeContentToOpenAIContent(content) {
    const blocks = filterClaudeCompatibleBlocks(content);
    if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text || '';
    return blocks.map((block) => {
      if (isClaudeThinkingBlock(block)) return null;
      if (!block || typeof block !== 'object') return { type: 'text', text: String(block || '') };
      if (block.type === 'text') return { type: 'text', text: block.text || '' };
      if (block.type === 'image' && block.source && block.source.type === 'base64') {
        return { type: 'image_url', image_url: { url: 'data:' + (block.source.media_type || 'application/octet-stream') + ';base64,' + (block.source.data || '') } };
      }
      return { type: 'text', text: JSON.stringify(block) };
    }).filter(Boolean);
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
    if (toolChoice.type === 'tool' && toolChoice.name) return { type: 'function', function: { name: toolChoice.name } };
    return undefined;
  }

  function claudeMessagesToOpenAIChat(body, model) {
    const messages = [];
    const system = normalizeClaudeSystem(body.system);
    if (system) messages.push({ role: 'system', content: system.parts.map((part) => part.text || '').join('\n') });

    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const blocks = normalizeClaudeContent(message.content);
      const toolResults = blocks.filter((block) => block && block.type === 'tool_result');
      const toolUses = blocks.filter((block) => block && block.type === 'tool_use');
      const otherBlocks = blocks.filter((block) => !block || (block.type !== 'tool_result' && block.type !== 'tool_use' && !isClaudeThinkingBlock(block)));

      if (message.role === 'assistant') {
        const next = { role: 'assistant', content: otherBlocks.length > 0 ? claudeContentToOpenAIContent(otherBlocks) : null };
        if (toolUses.length > 0) next.tool_calls = toolUses.map(claudeToolUseToOpenAIToolMessage);
        messages.push(next);
        continue;
      }

      if (toolResults.length > 0) {
        for (const block of toolResults) {
          messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: geminiToolResponseText(block.content) });
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
    if (Array.isArray(body.tools)) result.tools = body.tools.filter((tool) => tool && tool.name).map(claudeToolToOpenAITool);
    const toolChoice = claudeToolChoiceToOpenAI(body.tool_choice);
    if (toolChoice) result.tool_choice = toolChoice;
    return result;
  }

  function openAIMessageToClaudeContent(message) {
    const content = [];
    const text = message && message.content;
    if (typeof text === 'string' && text) content.push({ type: 'text', text });
    if (Array.isArray(text)) content.push(...openAIContentToClaudeContent(text));
    if (Array.isArray(message && message.tool_calls)) content.push(...message.tool_calls.map(openAIToolCallToClaudeBlock));
    return content;
  }

  function openAIResponseToClaudeMessage(payload, model) {
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = choice && choice.message ? choice.message : {};
    return {
      id: payload && payload.id ? payload.id : fallbackId('msg_openai', { model, message }),
      type: 'message',
      role: 'assistant',
      model,
      content: openAIMessageToClaudeContent(message),
      stop_reason: choice && choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: payload && payload.usage ? payload.usage.prompt_tokens || 0 : 0,
        output_tokens: payload && payload.usage ? payload.usage.completion_tokens || 0 : 0,
      },
    };
  }

  function responsesContentPartToChat(part) {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      return { type: 'text', text: part.text || '' };
    }
    if (part.type === 'input_image') {
      const imageUrl = part.image_url || part.url || '';
      return { type: 'image_url', image_url: { url: imageUrl } };
    }
    return { type: 'text', text: JSON.stringify(part) };
  }

  function responsesInputItemToChatMessage(item) {
    if (typeof item === 'string') return { role: 'user', content: item };
    if (!item || typeof item !== 'object') return { role: 'user', content: String(item || '') };
    if (item.type === 'function_call') {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || fallbackId('call', item),
          type: 'function',
          function: {
            name: item.name || 'tool',
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
          },
        }],
      };
    }
    if (item.type === 'function_call_output') {
      const output = item.output != null ? item.output : (item.output_text != null ? item.output_text : item.content);
      return {
        role: 'tool',
        tool_call_id: item.call_id || item.id || fallbackId('call', item),
        content: typeof output === 'string' ? output : JSON.stringify(output || ''),
      };
    }
    const role = item.role === 'assistant' || item.role === 'system' || item.role === 'tool' ? item.role : 'user';
    if (typeof item.content === 'string') return { role, content: item.content };
    if (Array.isArray(item.content)) return { role, content: item.content.map(responsesContentPartToChat) };
    if (item.type === 'message') return { role, content: '' };
    return { role, content: JSON.stringify(item) };
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
      if (format.json_schema) return { type: 'json_schema', json_schema: format.json_schema };
      return {
        type: 'json_schema',
        json_schema: {
          name: format.name || 'response',
          schema: format.schema || { type: 'object' },
          strict: format.strict === true,
        },
      };
    }
    if (format.type === 'json_object') return { type: 'json_object' };
    if (format.type === 'text') return undefined;
    return format;
  }

  function openAIResponsesToChat(body) {
    const messages = [];
    if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
    if (typeof body.input === 'string') {
      messages.push({ role: 'user', content: body.input });
    } else if (Array.isArray(body.input)) {
      messages.push(...body.input.map(responsesInputItemToChatMessage));
    } else if (body.input != null) {
      messages.push({ role: 'user', content: String(body.input) });
    }

    const result = {
      model: body.model,
      messages,
    };
    if (body.stream === true) result.stream = true;
    if (body.temperature != null) result.temperature = body.temperature;
    if (body.top_p != null) result.top_p = body.top_p;
    if (body.max_output_tokens != null) result.max_tokens = body.max_output_tokens;
    if (body.max_tokens != null) result.max_tokens = body.max_tokens;
    if (body.frequency_penalty != null) result.frequency_penalty = body.frequency_penalty;
    if (body.presence_penalty != null) result.presence_penalty = body.presence_penalty;
    if (body.seed != null) result.seed = body.seed;
    if (body.user != null) result.user = body.user;
    if (body.parallel_tool_calls != null) result.parallel_tool_calls = body.parallel_tool_calls;
    if (body.reasoning && body.reasoning.effort) result.reasoning_effort = body.reasoning.effort;
    if (Array.isArray(body.tools)) {
      result.tools = body.tools.filter((tool) => tool && tool.type === 'function').map((tool) => ({
        type: 'function',
        function: {
          name: tool.name || (tool.function && tool.function.name),
          description: tool.description || (tool.function && tool.function.description) || '',
          parameters: tool.parameters || (tool.function && tool.function.parameters) || { type: 'object', properties: {} },
          strict: tool.strict != null ? tool.strict : (tool.function && tool.function.strict),
        },
      })).filter((tool) => {
        if (!tool.function.name) return false;
        if (tool.function.strict == null) delete tool.function.strict;
        return true;
      });
    }
    const toolChoice = responsesToolChoiceToChat(body.tool_choice);
    if (toolChoice) result.tool_choice = toolChoice;
    if (body.response_format) result.response_format = body.response_format;
    const responseFormat = responsesTextFormatToChat(body.text && body.text.format);
    if (responseFormat) result.response_format = responseFormat;
    return result;
  }

  function openAIChatToResponses(payload, model) {
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = choice && choice.message ? choice.message : {};
    const text = typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content.map((part) => part && (part.text || part.content || '')).join('') : '');
    const output = [];
    if (text) {
      output.push({
        id: fallbackId('msg', { model, text }),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call.function || {};
        output.push({
          id: call.id || fallbackId('fc', fn),
          type: 'function_call',
          call_id: call.id || fallbackId('call', fn),
          name: fn.name || 'tool',
          arguments: fn.arguments || '{}',
        });
      }
    }
    const usage = payload && payload.usage ? {
      input_tokens: payload.usage.prompt_tokens || 0,
      output_tokens: payload.usage.completion_tokens || 0,
      total_tokens: payload.usage.total_tokens || ((payload.usage.prompt_tokens || 0) + (payload.usage.completion_tokens || 0)),
    } : undefined;
    return {
      id: payload && payload.id ? payload.id.replace(/^chatcmpl/, 'resp') : fallbackId('resp', { model, output }),
      object: 'response',
      created_at: payload && payload.created ? payload.created : stableCreated({ model, output }),
      status: 'completed',
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

  function ensureResponsesTextItem(clientRes, state) {
    ensureResponsesStreamStarted(clientRes, state);
    if (state.textItemStarted) return;
    state.textItemStarted = true;
    state.textItemDone = false;
    state.messageId = state.messageId || fallbackId('msg', { response: state.id, model: state.model, outputIndex: state.outputIndex });
    state.text = '';
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item: { id: state.messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
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
    const completedItem = { id: state.messageId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: state.text || '', annotations: [] }] };
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
    const fn = toolCall && toolCall.function ? toolCall.function : {};
    const itemId = toolCall.id || fallbackId('fc', { index: state.outputIndex, name: fn.name, arguments: fn.arguments });
    const callId = toolCall.id || fallbackId('call', { index: state.outputIndex, name: fn.name, arguments: fn.arguments });
    const item = {
      id: itemId,
      type: 'function_call',
      status: 'in_progress',
      call_id: callId,
      name: fn.name || toolCall.name || 'tool',
      arguments: '',
    };
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item,
    });
    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
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
      state.pendingToolCalls[index] = { index, id: null, type: 'function', function: { name: '', arguments: '' } };
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

  function finishResponsesStream(clientRes, state) {
    if (state.done) return;
    ensureResponsesStreamStarted(clientRes, state);
    flushResponsesToolCalls(clientRes, state);
    finishResponsesTextItem(clientRes, state);
    const output = Array.isArray(state.completedOutputItems) ? state.completedOutputItems : [];
    writeResponsesSseEvent(clientRes, 'response.completed', {
      type: 'response.completed',
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        status: 'completed',
        model: state.model,
        output,
        usage: state.usage,
      },
    });
    clientRes.write('data: [DONE]\n\n');
    state.done = true;
  }

  function processOpenAIChatSseEventToResponses(clientRes, event, state) {
    const lines = String(event || '').split(/\r?\n/);
    const dataLines = lines.filter((line) => line.indexOf('data:') === 0).map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return;
    const dataText = dataLines.join('\n');
    if (!dataText || dataText === '[DONE]') {
      finishResponsesStream(clientRes, state);
      return;
    }
    let payload;
    try { payload = JSON.parse(dataText); } catch (err) { return; }
    if (payload && payload.usage) {
      state.usage = {
        input_tokens: payload.usage.prompt_tokens || 0,
        output_tokens: payload.usage.completion_tokens || 0,
        total_tokens: payload.usage.total_tokens || ((payload.usage.prompt_tokens || 0) + (payload.usage.completion_tokens || 0)),
      };
    }
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
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
    if (Array.isArray(delta.tool_calls)) {
      finishResponsesTextItem(clientRes, state);
      for (const toolCall of delta.tool_calls) bufferResponsesToolCallDelta(state, toolCall);
    }
    if (choice.finish_reason === 'tool_calls') flushResponsesToolCalls(clientRes, state);
    if (choice.finish_reason) finishResponsesStream(clientRes, state);
  }

  function processOpenAIChatSseChunkToResponses(clientRes, chunkText, state) {
    state.buffer += chunkText;
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const event of events) processOpenAIChatSseEventToResponses(clientRes, event, state);
  }

  function flushOpenAIChatSseToResponses(clientRes, state) {
    if (state.buffer && state.buffer.trim()) processOpenAIChatSseEventToResponses(clientRes, state.buffer, state);
    state.buffer = '';
    finishResponsesStream(clientRes, state);
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
    openAIResponsesToChat,
    openAIChatToResponses,
    processOpenAIChatSseChunkToResponses,
    flushOpenAIChatSseToResponses,
  };
}

module.exports = { createOpenAIProtocol };
