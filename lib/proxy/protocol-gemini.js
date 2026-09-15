const fs = require('fs');
const os = require('os');
const path = require('path');
const { geminiThinkingConfigFromOpenAI } = require('./gemini-reasoning');
const { validateClaudeMultimodalBlock } = require('./multimodal-content');
const { estimateTokensForValue, stringifyWithoutInlineMedia } = require('./inline-media');
const { geminiSafeToolName } = require('./tools');

const MAX_INLINE_NONSTREAM_WRITE_BYTES = 32 * 1024;
const MAX_GEMINI_IMAGE_OUTPUT_BASE64_CHARS = 32 * 1024 * 1024;
const RESPONSES_TOOL_PREAMBLE_INSTRUCTION =
  'For OpenAI Responses clients, when you need to call a function tool, first emit one concise user-visible text update in the same response as a normal text part, then emit the functionCall part. Match the user language and keep the update brief.';

function withResponsesToolPreamble(content, text) {
  if (!text || !Array.isArray(content)) return content;
  let sawVisibleText = false;
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      sawVisibleText = true;
    }
    if (block.type === 'image') sawVisibleText = true;
    if (block.type === 'tool_use' && !sawVisibleText) {
      return [...content.slice(0, index), { type: 'text', text }, ...content.slice(index)];
    }
  }
  return content;
}

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
        text: '[Gemini tool call error: Write generated content is too large for one non-stream response, and Bash is not available. Please use an available editing tool with smaller changes.]',
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
      .filter((item) => !isMediaBlock(item))
      .map((item) =>
        typeof item === 'string' ? item : item.text || stringifyWithoutInlineMedia(item)
      )
      .join('\n');
  }

  // Media inside a tool result cannot travel through functionResponse.response:
  // serializing it there turns base64 into literal prompt text that upstream
  // tokenizers bill per character. Emit it as sibling inlineData parts instead.
  function geminiToolResultMediaParts(content) {
    if (typeof content === 'string') return [];
    const parts = [];
    for (const block of normalizeClaudeContent(content)) {
      if (!isMediaBlock(block)) continue;
      try {
        const part = claudeBlockToGeminiPart(block);
        if (part && part.inlineData) parts.push(part);
      } catch (error) {
        // Invalid media is dropped rather than expanded into prompt text.
      }
    }
    return parts;
  }

  function isMediaBlock(block) {
    return (
      block &&
      typeof block === 'object' &&
      (block.type === 'image' || block.type === 'audio' || block.type === 'video')
    );
  }

  function claudeBlockToGeminiPart(block) {
    if (!block) return null;
    if (typeof block === 'string') return { text: block };
    if (isClaudeThinkingBlock(block)) return null;
    if (block.type === 'text') return { text: block.text || '' };
    const media = validateClaudeMultimodalBlock(block);
    if (media.recognized) {
      if (!media.ok) throw new TypeError(media.error);
      return {
        inlineData: {
          mimeType: geminiMimeType(media.block.source.media_type),
          data: media.block.source.data,
        },
      };
    }
    return { text: stringifyWithoutInlineMedia(block) };
  }

  function claudeContentToGeminiParts(content) {
    const parts = filterClaudeCompatibleBlocks(content)
      .flatMap((block) => {
        if (block && typeof block === 'object' && block.type === 'tool_result') {
          return claudeToolHistoryBlockToGeminiParts(block);
        }
        return [claudeBlockToGeminiPart(block)];
      })
      .filter(Boolean);
    return parts.length > 0 ? parts : [{ text: '' }];
  }

  function normalizeClaudeSystem(system) {
    if (!system) return null;
    if (typeof system === 'string') return { parts: [{ text: system }] };
    const parts = filterClaudeCompatibleBlocks(system).map((block) => ({
      text: typeof block === 'string' ? block : block.text || stringifyWithoutInlineMedia(block),
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

  function sanitizeGeminiSchema(rawSchema, keyName) {
    if (Array.isArray(rawSchema)) {
      if (keyName === 'type') return rawSchema;
      if (keyName === 'propertyOrdering' || keyName === 'required') {
        return rawSchema.filter((item) => typeof item === 'string' && item);
      }
      if (keyName === 'enum') {
        return rawSchema
          .filter(
            (item) =>
              item == null ||
              typeof item === 'string' ||
              typeof item === 'number' ||
              typeof item === 'boolean'
          )
          .map((item) => String(item));
      }
      return rawSchema.length > 0 ? sanitizeGeminiSchema(rawSchema[0], keyName) : rawSchema;
    }
    if (keyName === 'propertyOrdering' || keyName === 'required' || keyName === 'enum') {
      return [];
    }
    if (!rawSchema || typeof rawSchema !== 'object') {
      if (keyName === 'properties') return {};
      return rawSchema;
    }

    const schema = { ...rawSchema };

    const variants = Array.isArray(schema.anyOf)
      ? schema.anyOf
      : Array.isArray(schema.oneOf)
        ? schema.oneOf
        : Array.isArray(schema.allOf)
          ? schema.allOf
          : null;

    if (variants && variants.length > 0) {
      if (variants.some((v) => v && (v.type === 'null' || v.nullable === true))) {
        schema.nullable = true;
      }
      const candidates = variants.filter((v) => v && v.type !== 'null' && typeof v === 'object');
      const primary =
        candidates.find((c) => c.type === 'array' || c.items) ||
        candidates.find((c) => c.type === 'object' || c.properties) ||
        candidates.find((c) => c.type && c.type !== 'null') ||
        candidates[0] ||
        {};
      for (const [k, v] of Object.entries(primary)) {
        if (schema[k] === undefined) {
          schema[k] = v;
        }
      }
      delete schema.anyOf;
      delete schema.oneOf;
      delete schema.allOf;
    }

    const allowedKeys = new Set([
      'type',
      'format',
      'description',
      'nullable',
      'enum',
      'items',
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
    const isPropertiesMap = keyName === 'properties';
    const sanitized = {};
    Object.keys(schema).forEach((key) => {
      if (!isPropertiesMap && !allowedKeys.has(key)) return;
      if (key === 'type' && !isPropertiesMap) {
        const normalizedType = geminiSchemaType(schema[key]);
        if (normalizedType) sanitized.type = normalizedType;
        if (Array.isArray(schema[key]) && schema[key].includes('null')) sanitized.nullable = true;
        return;
      }
      const value = sanitizeGeminiSchema(schema[key], isPropertiesMap ? key : key);
      if (
        (key === 'propertyOrdering' || key === 'required' || key === 'enum') &&
        Array.isArray(value) &&
        value.length === 0
      ) {
        return;
      }
      sanitized[key] = value;
    });

    if (isPropertiesMap) {
      return sanitized;
    }

    if (sanitized.items !== undefined) {
      if (Array.isArray(sanitized.items)) {
        sanitized.items = sanitized.items[0] || { type: 'STRING' };
      }
      sanitized.type = 'ARRAY';
      if (
        sanitized.items &&
        typeof sanitized.items === 'object' &&
        !sanitized.items.type &&
        !sanitized.items.properties
      ) {
        sanitized.items.type = 'STRING';
      }
    } else if (sanitized.type === 'ARRAY') {
      sanitized.items = { type: 'STRING' };
    }

    if (!sanitized.type && (sanitized.properties || sanitized.required)) {
      sanitized.type = 'OBJECT';
    }

    if (sanitized.properties && typeof sanitized.properties === 'object') {
      const propertyNames = new Set(Object.keys(sanitized.properties));
      if (Array.isArray(sanitized.required)) {
        sanitized.required = sanitized.required.filter((name) => propertyNames.has(name));
        if (sanitized.required.length === 0) delete sanitized.required;
      }
      if (Array.isArray(sanitized.propertyOrdering)) {
        sanitized.propertyOrdering = sanitized.propertyOrdering.filter((name) =>
          propertyNames.has(name)
        );
        if (sanitized.propertyOrdering.length === 0) delete sanitized.propertyOrdering;
      }
    }

    return sanitized;
  }

  function claudeToolToGeminiDeclaration(tool) {
    const rawSchema = tool.input_schema || tool.parameters || { type: 'object', properties: {} };
    const sanitized = sanitizeGeminiSchema(rawSchema) || {};
    if (!sanitized.type) sanitized.type = 'OBJECT';
    if (!sanitized.properties && sanitized.type === 'OBJECT') sanitized.properties = {};
    return {
      name: geminiSafeToolName(tool.name),
      description: tool.description || '',
      parameters: sanitized,
    };
  }

  function geminiToolsFromClaude(tools) {
    const seenNames = new Set();
    const declarations = Array.isArray(tools)
      ? tools
          .filter((tool) => {
            if (!tool || !tool.name) return false;
            const safe = geminiSafeToolName(tool.name);
            if (seenNames.has(safe)) return false;
            seenNames.add(safe);
            return true;
          })
          .map(claudeToolToGeminiDeclaration)
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

  function geminiToolsIncludeFunctionDeclarations(tools) {
    return (
      Array.isArray(tools) &&
      tools.some(
        (tool) =>
          tool && Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0
      )
    );
  }

  function geminiToolConfigFromClaude(toolChoice) {
    if (!toolChoice || toolChoice.type === 'auto') return undefined;
    if (toolChoice.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (toolChoice.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
    if (toolChoice.type === 'tool' && toolChoice.name)
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [geminiSafeToolName(toolChoice.name)],
        },
      };
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
      const rawName = cached.name || block.name;
      const safeName = geminiSafeToolName(rawName);
      return {
        functionCall: {
          name: safeName,
          args: cached.args || cleanToolArgs(rawName, block.input || {}),
        },
        thoughtSignature: cached.thoughtSignature || GEMINI_FALLBACK_THOUGHT_SIGNATURE,
      };
    }
    if (block.type === 'tool_result') {
      const cached = GEMINI_TOOL_CALL_STATE.get(block.tool_use_id) || {};
      const rawName = cached.name || block.name || block.tool_use_id || 'tool_result';
      const safeName = geminiSafeToolName(rawName);
      const text = geminiToolResponseText(block.content);
      const response = block.is_error === true ? { error: text } : { content: text };
      return {
        functionResponse: {
          name: safeName,
          response,
        },
      };
    }
    return null;
  }

  function claudeToolHistoryBlockToGeminiParts(block, diagnosticsMeta) {
    const primary = claudeToolHistoryBlockToGeminiPart(block, diagnosticsMeta);
    if (!primary) return [];
    if (!block || block.type !== 'tool_result') return [primary];
    const mediaParts = geminiToolResultMediaParts(block.content);
    return mediaParts.length > 0 ? [primary, ...mediaParts] : [primary];
  }

  function claudeMessageToGeminiContent(message, hasTools, diagnosticsMeta) {
    if (message && typeof message === 'object' && diagnosticsMeta)
      message.__diagnosticsMeta = diagnosticsMeta;
    if (hasTools && hasGeminiIncompatibleToolHistory(message.content)) {
      const parts = filterClaudeCompatibleBlocks(message.content).flatMap((block) =>
        claudeToolHistoryBlockToGeminiParts(block, message.__diagnosticsMeta)
      );
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
      const tokens = estimateTokensForValue(msg);
      if (currentTokens + tokens > maxTokens && result.length > 0) break;
      result.unshift(msg);
      currentTokens += tokens;
    }
    return result;
  }

  function rejectsLegacySamplingParameters(model) {
    const match = String(model || '')
      .replace(/^models\//, '')
      .trim()
      .toLowerCase()
      .match(/^gemini-(\d+)\.(\d+)(?:-|$)/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 3 || (major === 3 && minor >= 6);
  }

  function isGeminiImageGenerationModel(model) {
    const normalized = String(model || '')
      .replace(/^google\//, '')
      .replace(/^models\//, '')
      .trim()
      .toLowerCase();
    return normalized === 'gemini-3.1-flash-image' || normalized === 'gemini 3.1 flash image';
  }

  function geminiInlineImageToClaudeBlock(part) {
    if (!part || typeof part !== 'object') return null;
    const inlineData = part.inlineData || part.inline_data;
    if (!inlineData || typeof inlineData !== 'object') return null;
    const mediaType = String(inlineData.mimeType || inlineData.mime_type || '')
      .trim()
      .toLowerCase();
    const data = typeof inlineData.data === 'string' ? inlineData.data.replace(/\s+/g, '') : '';
    const supportedMediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const validBase64 =
      data.length > 0 &&
      data.length <= MAX_GEMINI_IMAGE_OUTPUT_BASE64_CHARS &&
      /^[a-z0-9+/]+={0,2}$/i.test(data);
    if (!supportedMediaTypes.has(mediaType) || !validBase64) {
      return { type: 'text', text: '[Gemini returned an invalid or unsupported image output.]' };
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data },
    };
  }

  function claudeMessagesToGemini(body, model) {
    const generationConfig = {};
    const maxContext = (deps.protocolOptions && deps.protocolOptions.maxContextTokens) || 0;
    const contextPolicy =
      (deps.protocolOptions && deps.protocolOptions.contextWindowPolicy) || 'overflow-drop-oldest';

    if (body.max_tokens) generationConfig.maxOutputTokens = body.max_tokens;
    if (!rejectsLegacySamplingParameters(model)) {
      if (body.temperature != null) generationConfig.temperature = body.temperature;
      if (body.top_p != null) generationConfig.topP = body.top_p;
      if (body.top_k != null) generationConfig.topK = body.top_k;
    }
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0)
      generationConfig.stopSequences = body.stop_sequences;
    const thinkingConfig = geminiThinkingConfigFromOpenAI(body, model);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    if (isGeminiImageGenerationModel(model)) {
      generationConfig.responseModalities = ['TEXT', 'IMAGE'];
    }

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
    const tools = geminiNativeSearchToolsFromClaude(body, geminiToolsFromClaude(body.tools));
    const systemInstruction = normalizeClaudeSystem(body.system);
    const shouldAddResponsesToolPreamble =
      body.__responsesToolPreamble === true && geminiToolsIncludeFunctionDeclarations(tools);
    if (systemInstruction) {
      request.systemInstruction = systemInstruction;
      if (shouldAddResponsesToolPreamble) {
        request.systemInstruction = {
          ...systemInstruction,
          parts: [...systemInstruction.parts, { text: RESPONSES_TOOL_PREAMBLE_INSTRUCTION }],
        };
      }
    } else if (shouldAddResponsesToolPreamble) {
      request.systemInstruction = {
        parts: [{ text: RESPONSES_TOOL_PREAMBLE_INSTRUCTION }],
      };
    }
    if (tools) request.tools = tools;
    const toolConfig = geminiToolConfigFromClaude(body.tool_choice);
    if (geminiToolsIncludeNativeAndFunction(tools)) {
      request.toolConfig = {
        ...(toolConfig || {}),
        includeServerSideToolInvocations: true,
        include_server_side_tool_invocations: true,
      };
      request.tool_config = request.toolConfig;
    } else if (toolConfig) {
      request.toolConfig = toolConfig;
      request.tool_config = toolConfig;
    }
    return request;
  }

  function geminiPartToClaudeBlock(part, index, tools) {
    if (part.thought === true && part.text != null) {
      return {
        type: 'thinking',
        thinking: part.text,
        signature: part.thoughtSignature || GEMINI_FALLBACK_THOUGHT_SIGNATURE,
      };
    }
    if (part.text != null) return { type: 'text', text: part.text };
    const imageBlock = geminiInlineImageToClaudeBlock(part);
    if (imageBlock) return imageBlock;
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
    return { type: 'text', text: stringifyWithoutInlineMedia(part) };
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
    const cached =
      usage && (usage.cachedContentTokenCount || usage.cached_content_token_count)
        ? usage.cachedContentTokenCount || usage.cached_content_token_count
        : 0;
    return {
      input_tokens: usage && usage.promptTokenCount ? usage.promptTokenCount : 0,
      output_tokens: usage && usage.candidatesTokenCount ? usage.candidatesTokenCount : 0,
      cached_input_tokens: cached,
    };
  }

  function geminiResponseToClaude(payload, model, tools, options = {}) {
    const candidate = payload && Array.isArray(payload.candidates) ? payload.candidates[0] : null;
    const parts =
      candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];
    const convertedContent = parts
      .map((part, index) => geminiPartToClaudeBlock(part, index, tools))
      .filter(Boolean)
      .map((block) => stageLargeWriteAsBashTool(block, tools));
    const content = withResponsesToolPreamble(convertedContent, options.responsesToolPreambleText);
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
    isGeminiImageGenerationModel,
    geminiInlineImageToClaudeBlock,
    geminiPartToClaudeBlock,
    claudeStopReasonFromGemini,
    geminiUsageToClaude,
    geminiResponseToClaude,
    geminiGeneratePath,
  };
}

module.exports = { createGeminiProtocol };
