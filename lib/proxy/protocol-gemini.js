const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_INLINE_NONSTREAM_WRITE_BYTES = 32 * 1024;

function createGeminiProtocol(deps) {
  const {
    stableHash,
    fallbackId,
    cleanToolArgs,
    geminiFunctionCallArgs,
    sanitizeGeminiToolCall,
    filterClaudeCompatibleBlocks,
    normalizeClaudeContent,
    isClaudeThinkingBlock,
    sampleGeminiToolEvent,
  } = deps;

  const GEMINI_TOOL_CALL_STATE = new Map();
  const GEMINI_TOOL_CALL_STATE_LIMIT = 500;
  const GEMINI_FALLBACK_THOUGHT_SIGNATURE = 'context_engineering_is_the_way_to_go';

  function geminiRoleFromClaude(role) {
    return role === 'assistant' ? 'model' : 'user';
  }

  function geminiMimeType(mediaType) {
    return mediaType || 'application/octet-stream';
  }

  function geminiClaudeToolId(call, fallbackIndex) {
    const raw =
      call && call.id
        ? String(call.id)
        : stableHash({
            index: fallbackIndex,
            name: call && call.name,
            args: geminiFunctionCallArgs(call),
          });
    return 'toolu_' + raw.replace(/[^A-Za-z0-9_]/g, '_');
  }

  function shellQuote(value) {
    return "'" + String(value || '').replace(/'/g, "'\\''") + "'";
  }

  function toMsysPath(value) {
    const normalized = String(value || '').replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (!match) return normalized;
    return '/' + match[1].toLowerCase() + '/' + match[2];
  }

  function hasDeclaredTool(tools, name) {
    const wanted = String(name || '').toLowerCase();
    return (
      Array.isArray(tools) &&
      tools.some((tool) => tool && String(tool.name || '').toLowerCase() === wanted)
    );
  }

  function stageLargeWriteAsBashTool(block, tools) {
    if (!block || block.type !== 'tool_use' || block.name !== 'Write') return block;
    const input = block.input || {};
    if (typeof input.content !== 'string' || typeof input.file_path !== 'string') return block;
    if (Buffer.byteLength(input.content, 'utf8') <= MAX_INLINE_NONSTREAM_WRITE_BYTES) return block;
    if (!hasDeclaredTool(tools, 'Bash')) {
      return {
        type: 'text',
        text: '[Gemini tool call needs retry: Write generated content that is too large for one non-stream response, and Bash is not available. Please use an available editing tool with smaller changes.]',
      };
    }

    const dir = path.join(os.tmpdir(), 'hpm-claude-tool-payloads');
    fs.mkdirSync(dir, { recursive: true });
    const payloadPath = path.join(
      dir,
      stableHash({ id: block.id, file_path: input.file_path, content: input.content }) + '.payload'
    );
    fs.writeFileSync(payloadPath, input.content, 'utf8');

    const targetPath = toMsysPath(input.file_path);
    const sourcePath = toMsysPath(payloadPath);
    const targetDir = targetPath.includes('/')
      ? targetPath.slice(0, targetPath.lastIndexOf('/'))
      : '.';
    return {
      type: 'tool_use',
      id: block.id,
      name: 'Bash',
      input: {
        command:
          'mkdir -p ' +
          shellQuote(targetDir) +
          ' && cp ' +
          shellQuote(sourcePath) +
          ' ' +
          shellQuote(targetPath) +
          ' && rm -f ' +
          shellQuote(sourcePath),
        description: 'Write large generated file content from staged payload',
      },
    };
  }

  function rememberGeminiToolCall(id, name, args, thoughtSignature) {
    if (!id || !name) return;
    if (GEMINI_TOOL_CALL_STATE.size >= GEMINI_TOOL_CALL_STATE_LIMIT) {
      const firstKey = GEMINI_TOOL_CALL_STATE.keys().next().value;
      if (firstKey) GEMINI_TOOL_CALL_STATE.delete(firstKey);
    }
    GEMINI_TOOL_CALL_STATE.set(id, { name, args: args || {}, thoughtSignature });
  }

  function geminiToolResponseText(content) {
    if (typeof content === 'string') return content;
    return normalizeClaudeContent(content)
      .map((item) => item.text || JSON.stringify(item))
      .join('\n');
  }

  function claudeBlockToGeminiPart(block) {
    if (!block) return null;
    if (typeof block === 'string') return { text: block };
    if (isClaudeThinkingBlock(block)) return null;
    if (block.type === 'text') return { text: block.text || '' };
    if (block.type === 'image' && block.source && block.source.type === 'base64') {
      return {
        inlineData: {
          mimeType: geminiMimeType(block.source.media_type),
          data: block.source.data || '',
        },
      };
    }
    return { text: JSON.stringify(block) };
  }

  function claudeContentToGeminiParts(content) {
    const parts = filterClaudeCompatibleBlocks(content)
      .map(claudeBlockToGeminiPart)
      .filter(Boolean);
    return parts.length > 0 ? parts : [{ text: '' }];
  }

  function normalizeClaudeSystem(system) {
    if (!system) return null;
    if (typeof system === 'string') return { parts: [{ text: system }] };
    const parts = filterClaudeCompatibleBlocks(system).map((block) => ({
      text: typeof block === 'string' ? block : block.text || JSON.stringify(block),
    }));
    return { parts: parts.length > 0 ? parts : [{ text: '' }] };
  }

  function geminiSchemaType(type) {
    if (Array.isArray(type)) {
      const nonNull = type.find((item) => item !== 'null');
      return nonNull ? geminiSchemaType(nonNull) : undefined;
    }
    const map = {
      object: 'OBJECT',
      array: 'ARRAY',
      string: 'STRING',
      integer: 'INTEGER',
      number: 'NUMBER',
      boolean: 'BOOLEAN',
    };
    return map[type] || type;
  }

  function sanitizeGeminiSchema(schema, keyName) {
    if (Array.isArray(schema)) {
      if (keyName === 'type') return schema;
      return keyName === 'propertyOrdering' || keyName === 'required' || keyName === 'enum'
        ? schema
        : schema.length > 0
          ? sanitizeGeminiSchema(schema[0], keyName)
          : schema;
    }
    if (!schema || typeof schema !== 'object') return schema;

    const allowedKeys = new Set([
      'type',
      'format',
      'description',
      'nullable',
      'enum',
      'items',
      'anyOf',
      'maxItems',
      'minItems',
      'properties',
      'required',
      'propertyOrdering',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'pattern',
    ]);
    const sanitized = {};
    Object.keys(schema).forEach((key) => {
      if (keyName !== 'properties' && !allowedKeys.has(key)) return;
      if (key === 'type') {
        const normalizedType = geminiSchemaType(schema[key]);
        if (normalizedType) sanitized.type = normalizedType;
        if (Array.isArray(schema[key]) && schema[key].includes('null')) sanitized.nullable = true;
        return;
      }
      sanitized[key] = sanitizeGeminiSchema(schema[key], key);
    });
    return sanitized;
  }

  function claudeToolToGeminiDeclaration(tool) {
    return {
      name: tool.name,
      description: tool.description || '',
      parameters: sanitizeGeminiSchema(tool.input_schema || { type: 'object', properties: {} }),
    };
  }

  function geminiToolsFromClaude(tools) {
    const declarations = Array.isArray(tools)
      ? tools.filter((tool) => tool && tool.name).map(claudeToolToGeminiDeclaration)
      : [];
    return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
  }

  function geminiNativeSearchToolsFromClaude(body, existingTools) {
    if (!body || body.__nativeWebSearch !== 'gemini-google-search') return existingTools;
    const tools = Array.isArray(existingTools) ? [...existingTools] : [];
    if (!tools.some((tool) => tool && tool.googleSearch)) tools.push({ googleSearch: {} });
    return tools;
  }

  function geminiToolsIncludeNativeAndFunction(tools) {
    if (!Array.isArray(tools)) return false;
    const hasNative = tools.some((tool) => tool && tool.googleSearch);
    const hasFunction = tools.some(
      (tool) =>
        tool && Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0
    );
    return hasNative && hasFunction;
  }

  function geminiToolConfigFromClaude(toolChoice) {
    if (!toolChoice || toolChoice.type === 'auto') return undefined;
    if (toolChoice.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (toolChoice.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
    if (toolChoice.type === 'tool' && toolChoice.name)
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name] } };
    return undefined;
  }

  function hasGeminiIncompatibleToolHistory(value) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(hasGeminiIncompatibleToolHistory);
    if (
      value.type === 'tool_use' ||
      value.type === 'tool_result' ||
      value.functionCall ||
      value.functionResponse
    )
      return true;
    return Object.values(value).some(hasGeminiIncompatibleToolHistory);
  }

  function claudeToolHistoryBlockToGeminiPart(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'tool_use') {
      const cached = GEMINI_TOOL_CALL_STATE.get(block.id) || {};
      const name = cached.name || block.name;
      return {
        functionCall: { name, args: cached.args || cleanToolArgs(name, block.input || {}) },
        thoughtSignature: cached.thoughtSignature || GEMINI_FALLBACK_THOUGHT_SIGNATURE,
      };
    }
    if (block.type === 'tool_result') {
      const cached = GEMINI_TOOL_CALL_STATE.get(block.tool_use_id) || {};
      return {
        functionResponse: {
          name: cached.name || block.name || block.tool_use_id || 'tool_result',
          response: { content: geminiToolResponseText(block.content) },
        },
      };
    }
    return null;
  }

  function claudeMessageToGeminiContent(message, hasTools, diagnosticsMeta) {
    if (message && typeof message === 'object' && diagnosticsMeta)
      message.__diagnosticsMeta = diagnosticsMeta;
    if (hasTools && hasGeminiIncompatibleToolHistory(message.content)) {
      const parts = filterClaudeCompatibleBlocks(message.content)
        .map((block) => claudeToolHistoryBlockToGeminiPart(block, message.__diagnosticsMeta))
        .filter(Boolean);
      return parts.length > 0 ? { role: geminiRoleFromClaude(message.role), parts } : null;
    }
    const parts = claudeContentToGeminiParts(message.content);
    return { role: geminiRoleFromClaude(message.role), parts };
  }

  function truncateGeminiMessages(messages, maxTokens) {
    if (!maxTokens || maxTokens <= 0) return messages;
    let currentTokens = 0;
    const result = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const tokens = Math.ceil(JSON.stringify(msg).length / 4);
      if (currentTokens + tokens > maxTokens && result.length > 0) break;
      result.unshift(msg);
      currentTokens += tokens;
    }
    return result;
  }

  function claudeMessagesToGemini(body, _model) {
    const generationConfig = {};
    const maxContext = (deps.protocolOptions && deps.protocolOptions.maxContextTokens) || 0;
    const contextPolicy =
      (deps.protocolOptions && deps.protocolOptions.contextWindowPolicy) || 'overflow-drop-oldest';

    if (body.max_tokens) generationConfig.maxOutputTokens = body.max_tokens;
    if (body.temperature != null) generationConfig.temperature = body.temperature;
    if (body.top_p != null) generationConfig.topP = body.top_p;
    if (body.top_k != null) generationConfig.topK = body.top_k;
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0)
      generationConfig.stopSequences = body.stop_sequences;

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    let contents = (Array.isArray(body.messages) ? body.messages : [])
      .map((message) => claudeMessageToGeminiContent(message, hasTools, body.__diagnosticsMeta))
      .filter(Boolean);

    if (maxContext > 0 && contextPolicy === 'overflow-drop-oldest') {
      contents = truncateGeminiMessages(contents, maxContext);
    }

    const request = {
      contents,
    };

    if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
    const systemInstruction = normalizeClaudeSystem(body.system);
    if (systemInstruction) request.systemInstruction = systemInstruction;
    const tools = geminiNativeSearchToolsFromClaude(body, geminiToolsFromClaude(body.tools));
    if (tools) request.tools = tools;
    const toolConfig = geminiToolConfigFromClaude(body.tool_choice);
    if (geminiToolsIncludeNativeAndFunction(tools)) {
      request.toolConfig = {
        ...(toolConfig || {}),
        includeServerSideToolInvocations: true,
      };
    } else if (toolConfig) {
      request.toolConfig = toolConfig;
    }
    return request;
  }

  function geminiPartToClaudeBlock(part, index, tools) {
    if (part.text != null) return { type: 'text', text: part.text };
    if (part.functionCall) {
      const sanitized = sanitizeGeminiToolCall(part.functionCall, tools);
      if (sanitized.error) {
        sampleGeminiToolEvent(sanitized.error, part);
        return { type: 'text', text: sanitized.text };
      }
      const id = geminiClaudeToolId(part.functionCall, index);
      rememberGeminiToolCall(id, sanitized.name, sanitized.args, part.thoughtSignature);
      return { type: 'tool_use', id, name: sanitized.name, input: sanitized.args };
    }
    return { type: 'text', text: JSON.stringify(part) };
  }

  function claudeStopReasonFromGemini(reason) {
    if (reason === 'MAX_TOKENS') return 'max_tokens';
    if (reason === 'STOP') return 'end_turn';
    if (
      reason === 'SAFETY' ||
      reason === 'RECITATION' ||
      reason === 'BLOCKLIST' ||
      reason === 'PROHIBITED_CONTENT'
    )
      return 'stop_sequence';
    return 'end_turn';
  }

  function geminiUsageToClaude(usage) {
    return {
      input_tokens: usage && usage.promptTokenCount ? usage.promptTokenCount : 0,
      output_tokens: usage && usage.candidatesTokenCount ? usage.candidatesTokenCount : 0,
    };
  }

  function geminiResponseToClaude(payload, model, tools) {
    const candidate = payload && Array.isArray(payload.candidates) ? payload.candidates[0] : null;
    const parts =
      candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];
    const content = parts
      .map((part, index) => geminiPartToClaudeBlock(part, index, tools))
      .filter(Boolean)
      .map((block) => stageLargeWriteAsBashTool(block, tools));
    const mappedStopReason = claudeStopReasonFromGemini(candidate && candidate.finishReason);
    const stopReason =
      mappedStopReason === 'end_turn' && content.some((block) => block && block.type === 'tool_use')
        ? 'tool_use'
        : mappedStopReason;
    return {
      id: fallbackId('msg_gemini', { model, parts }),
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: geminiUsageToClaude(payload && payload.usageMetadata),
    };
  }

  function geminiGeneratePath(basePath, model, stream) {
    const prefix = (basePath || '').replace(/\/$/, '').replace(/\/v1$/, '');
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    return prefix + '/v1beta/models/' + encodeURIComponent(model) + ':' + method;
  }

  return {
    geminiRoleFromClaude,
    geminiMimeType,
    geminiClaudeToolId,
    rememberGeminiToolCall,
    geminiToolResponseText,
    claudeBlockToGeminiPart,
    claudeContentToGeminiParts,
    normalizeClaudeSystem,
    geminiSchemaType,
    sanitizeGeminiSchema,
    claudeToolToGeminiDeclaration,
    geminiToolsFromClaude,
    geminiNativeSearchToolsFromClaude,
    geminiToolConfigFromClaude,
    hasGeminiIncompatibleToolHistory,
    claudeToolHistoryBlockToGeminiPart,
    claudeMessageToGeminiContent,
    claudeMessagesToGemini,
    geminiPartToClaudeBlock,
    claudeStopReasonFromGemini,
    geminiUsageToClaude,
    geminiResponseToClaude,
    geminiGeneratePath,
  };
}

module.exports = { createGeminiProtocol };
