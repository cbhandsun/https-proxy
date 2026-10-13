const { buildGeminiChatResponse } = require('./gemini-chat-response');
const { createGeminiRequestBuilder } = require('./gemini-request-builder');
const { createGeminiChatRequestAdapter } = require('./gemini-chat-request');
const { createResponsesGeminiRequestConverter } = require('./responses-gemini-request');
const { geminiToolId } = require('./gemini-tool-id');
const { createGeminiNativeToolHistory } = require('./gemini-native-tool-history');
const { normalizeCompletedGeminiFunctionInput } = require('./gemini-function-input');
const { geminiStreamTerminal } = require('./gemini-stream-terminal');
const { createConversionStreamBudget } = require('./conversion-stream-budget');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateClaudeMultimodalBlock } = require('./multimodal-content');
const { stringifyWithoutInlineMedia } = require('./inline-media');
const { geminiSafeToolName } = require('./tools');
const { geminiUsageToClaude } = require('./gemini-usage');

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
  const MAX_GEMINI_SCHEMA_DEPTH = 24;

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
    return geminiToolId(raw);
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

  function rememberGeminiToolCall(id, name, args, thoughtSignature, providerId) {
    if (!id || !name) return;
    if (
      !GEMINI_TOOL_CALL_STATE.has(id) &&
      GEMINI_TOOL_CALL_STATE.size >= GEMINI_TOOL_CALL_STATE_LIMIT
    ) {
      const firstKey = GEMINI_TOOL_CALL_STATE.keys().next().value;
      if (firstKey) GEMINI_TOOL_CALL_STATE.delete(firstKey);
    }
    const rawId =
      typeof providerId === 'string' && providerId
        ? providerId
        : GEMINI_TOOL_CALL_STATE.get(id)?.providerId;
    GEMINI_TOOL_CALL_STATE.set(id, {
      name,
      args: args || {},
      thoughtSignature,
      ...(rawId ? { providerId: rawId } : {}),
    });
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

  function mergeAdjacentGeminiTextParts(parts) {
    const merged = [];
    for (const part of parts) {
      if (
        part &&
        typeof part === 'object' &&
        Object.prototype.hasOwnProperty.call(part, 'text') &&
        typeof part.text === 'string' &&
        Object.keys(part).length === 1
      ) {
        const previous = merged[merged.length - 1];
        if (
          previous &&
          typeof previous === 'object' &&
          Object.prototype.hasOwnProperty.call(previous, 'text') &&
          typeof previous.text === 'string' &&
          Object.keys(previous).length === 1
        ) {
          previous.text =
            previous.text && part.text
              ? previous.text + '\n' + part.text
              : previous.text + part.text;
          continue;
        }
      }
      merged.push(part);
    }
    return merged;
  }

  function claudeContentToGeminiParts(content, toolHistoryOptions = {}) {
    const parts = mergeAdjacentGeminiTextParts(
      filterClaudeCompatibleBlocks(content)
        .flatMap((block) => {
          if (
            block &&
            typeof block === 'object' &&
            (block.type === 'tool_use' || block.type === 'tool_result')
          ) {
            return claudeToolHistoryBlockToGeminiParts(block, toolHistoryOptions);
          }
          return [claudeBlockToGeminiPart(block)];
        })
        .filter(Boolean)
    );
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

  // Tool schemas arrive from the client, so unbounded nesting is attacker
  // controllable: a deeply nested `properties` chain overflowed the JS stack and
  // crashed the proxy process (RangeError). Cap the walk and degrade the tail to
  // an opaque object instead of unwinding into a crash.
  function sanitizeGeminiSchema(rawSchema, keyName, depth = 0) {
    if (depth > MAX_GEMINI_SCHEMA_DEPTH) {
      return keyName === 'properties' ? { type: 'OBJECT' } : { type: 'OBJECT', properties: {} };
    }
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
      return rawSchema.length > 0
        ? sanitizeGeminiSchema(rawSchema[0], keyName, depth + 1)
        : rawSchema;
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
      if (isPropertiesMap && (!schema[key] || typeof schema[key] !== 'object')) {
        sanitized[key] = { type: 'STRING' };
        return;
      }
      if (key === 'type' && !isPropertiesMap) {
        const normalizedType = geminiSchemaType(schema[key]);
        if (normalizedType) sanitized.type = normalizedType;
        if (Array.isArray(schema[key]) && schema[key].includes('null')) sanitized.nullable = true;
        return;
      }
      const value = sanitizeGeminiSchema(schema[key], isPropertiesMap ? key : key, depth + 1);
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

    if (sanitized.enum && sanitized.type && sanitized.type !== 'STRING') {
      delete sanitized.enum;
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

  function geminiFunctionDeclarationNames(tools) {
    const names = new Set();
    if (!Array.isArray(tools)) return names;
    for (const tool of tools) {
      if (!tool || !Array.isArray(tool.functionDeclarations)) continue;
      for (const declaration of tool.functionDeclarations) {
        if (!declaration || !declaration.name) continue;
        names.add(geminiSafeToolName(declaration.name));
      }
    }
    return names;
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

  const nativeToolHistory = createGeminiNativeToolHistory({
    getCall: (id) => GEMINI_TOOL_CALL_STATE.get(id),
    rememberCall: rememberGeminiToolCall,
    cleanToolArgs,
    safeName: geminiSafeToolName,
    signature: GEMINI_FALLBACK_THOUGHT_SIGNATURE,
  });
  function toolDescriptor(block) {
    return block.type === 'tool_use'
      ? { id: block.id, name: block.name, args: block.input }
      : {
          id: block.tool_use_id,
          name: block.name,
          text: geminiToolResponseText(block.content),
          error: block.is_error === true,
        };
  }
  function claudeToolHistoryBlockToTextPart(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'tool_use') return nativeToolHistory.callText(toolDescriptor(block));
    if (block.type === 'tool_result') return nativeToolHistory.resultText(toolDescriptor(block));
    return null;
  }
  function claudeToolHistoryBlockToGeminiParts(block, options = {}) {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'tool_use')
      return nativeToolHistory.callParts(toolDescriptor(block), options);
    if (block.type === 'tool_result')
      return nativeToolHistory.resultParts(
        {
          ...toolDescriptor(block),
          mediaParts: geminiToolResultMediaParts(block.content),
        },
        options
      );
    return [];
  }
  function claudeToolHistoryBlockToGeminiPart(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'tool_use') return nativeToolHistory.callPart(toolDescriptor(block));
    if (block.type === 'tool_result') return nativeToolHistory.resultPart(toolDescriptor(block));
    return null;
  }

  function claudeMessageToGeminiContent(message, toolHistoryOptions) {
    const parts = claudeContentToGeminiParts(message.content, toolHistoryOptions);
    return { role: geminiRoleFromClaude(message.role), parts };
  }

  function repairOrphanedClaudeToolResults(messages) {
    let repairedCount = 0;
    const repairedMessages = messages.map((message, index) => {
      if (!message || !Array.isArray(message.content)) return message;
      const previous = index > 0 ? messages[index - 1] : null;
      const precedingToolIds = new Set(
        previous && Array.isArray(previous.content)
          ? previous.content
              .filter((block) => block && block.type === 'tool_use' && typeof block.id === 'string')
              .map((block) => block.id)
          : []
      );
      let changed = false;
      const content = message.content.map((block) => {
        if (!block || block.type !== 'tool_result' || precedingToolIds.has(block.tool_use_id)) {
          return block;
        }
        const textPart = claudeToolHistoryBlockToTextPart(block);
        changed = true;
        repairedCount += 1;
        return {
          type: 'text',
          text: textPart ? textPart.text : 'Previous tool result: [unavailable]',
        };
      });
      return changed ? { ...message, content } : message;
    });
    return { messages: repairedMessages, repairedCount };
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

  const buildGeminiRequest = createGeminiRequestBuilder({
    protocolOptions: deps.protocolOptions,
    rejectsLegacySamplingParameters,
    isGeminiImageGenerationModel,
    geminiNativeSearchToolsFromClaude,
    geminiToolsFromClaude,
    geminiFunctionDeclarationNames,
    normalizeClaudeSystem,
    geminiToolsIncludeFunctionDeclarations,
    claudeMessageToGeminiContent,
    repairOrphanedClaudeToolResults,
    geminiToolConfigFromClaude,
    geminiToolsIncludeNativeAndFunction,
    RESPONSES_TOOL_PREAMBLE_INSTRUCTION,
  });
  const tryOpenAIChatToGemini = createGeminiChatRequestAdapter({
    buildGeminiRequest,
    nativeToolHistory,
    mergeAdjacentGeminiTextParts,
    cleanToolArgs,
    fallbackId,
    protocolOptions: deps.protocolOptions,
  });
  function claudeMessagesToGemini(body, model, outputOptions = {}) {
    return buildGeminiRequest(body, model, outputOptions);
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
      if (part.functionCall.partialArgs != null || part.functionCall.willContinue === true) {
        part = {
          ...part,
          functionCall: normalizeCompletedGeminiFunctionInput(
            part.functionCall,
            deps.protocolOptions
          ),
        };
      }
      const sanitized = sanitizeGeminiToolCall(part.functionCall, tools);
      if (sanitized.error) {
        sampleGeminiToolEvent(sanitized.error, part);
        return { type: 'text', text: sanitized.text };
      }
      const id = geminiClaudeToolId(part.functionCall, index);
      rememberGeminiToolCall(
        id,
        sanitized.name,
        sanitized.args,
        part.thoughtSignature,
        part.functionCall.id
      );
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

  function geminiResponseToClaude(payload, model, tools, options = {}) {
    try {
      if (geminiStreamTerminal(payload?.candidates?.[0]?.finishReason).reason === 'error')
        throw new TypeError('Upstream Gemini response did not complete safely');
      return geminiResponseToNative(payload, model, tools, {
        responsesToolPreambleText: options.responsesToolPreambleText,
        buildResponse: (data) => {
          if (data.failureCode)
            throw new TypeError('Upstream Gemini response did not complete safely');
          const response = {
            id: data.id,
            type: 'message',
            role: 'assistant',
            model: data.model,
            content: data.parts,
            stop_reason:
              data.stopReason === 'refusal'
                ? 'stop_sequence'
                : data.stopReason === 'end_turn' &&
                    data.parts.some((part) => part.type === 'tool_use')
                  ? 'tool_use'
                  : data.stopReason,
            stop_sequence: null,
            usage: data.usage,
          };
          createConversionStreamBudget(deps.protocolOptions).consume({}, JSON.stringify(response));
          return response;
        },
      });
    } catch {
      throw new TypeError('Upstream Gemini response could not be converted safely');
    }
  }

  function geminiResponseToNative(payload, model, tools, options) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.error != null ||
      !Array.isArray(payload.candidates)
    )
      throw new TypeError('Invalid upstream Gemini response');
    const candidate = payload.candidates[0];
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      (candidate.content != null &&
        (typeof candidate.content !== 'object' || Array.isArray(candidate.content)))
    )
      throw new TypeError('Invalid upstream Gemini candidate');
    const parts = candidate.content?.parts ?? [];
    if (
      !Array.isArray(parts) ||
      parts.some((part) => !part || typeof part !== 'object' || Array.isArray(part))
    )
      throw new TypeError('Invalid upstream Gemini parts');
    const terminal = geminiStreamTerminal(candidate?.finishReason);
    const budget = createConversionStreamBudget(deps.protocolOptions);
    const budgetState = {};
    const content = withResponsesToolPreamble(
      parts
        .map((part, index) => {
          if (
            (part.text != null && typeof part.text !== 'string') ||
            (part.thought != null && typeof part.thought !== 'boolean') ||
            (part.thoughtSignature != null && typeof part.thoughtSignature !== 'string')
          )
            throw new TypeError('Invalid upstream Gemini part');
          if (part.functionCall != null) {
            const call = normalizeCompletedGeminiFunctionInput(
              part.functionCall,
              deps.protocolOptions
            );
            part = { ...part, functionCall: call };
            for (const key of ['args', 'arguments', 'parameters', 'input']) {
              if (call[key] == null) continue;
              let value = call[key];
              if (typeof value === 'string') value = JSON.parse(value);
              const args = JSON.stringify(value);
              budget.appendArguments({}, args);
              budget.consume(budgetState, args);
            }
            budget.addTool(budgetState);
            if (terminal.reason !== 'end_turn') return null;
          }
          try {
            return geminiPartToClaudeBlock(part, index, tools);
          } catch {
            throw new TypeError('Upstream Gemini response conversion failed');
          }
        })
        .filter(Boolean)
        .map((block) => {
          try {
            return stageLargeWriteAsBashTool(block, tools);
          } catch {
            throw new TypeError('Upstream Gemini response conversion failed');
          }
        }),
      options.responsesToolPreambleText
    );
    return options.buildResponse({
      parts: content,
      id: fallbackId('msg_gemini', { model, parts }),
      model: options.clientModel || model,
      stopReason: terminal.reason,
      failureCode: terminal.code,
      usage: geminiUsageToClaude(payload.usageMetadata),
      options: options.request,
      isThinking: (part) => part.type === 'thinking' || part.type === 'redacted_thinking',
      textForPart: (part) =>
        part.type === 'image'
          ? '![generated image](data:' +
            part.source.media_type +
            ';base64,' +
            part.source.data +
            ')'
          : part.text || '',
    });
  }

  function geminiResponseToResponses(payload, model, tools, options) {
    return geminiResponseToNative(payload, model, tools, options);
  }
  function geminiResponseToChat(payload, model, tools, options) {
    try {
      return geminiResponseToNative(payload, model, tools, {
        ...options,
        buildResponse: (data) => buildGeminiChatResponse(data, deps, options),
      });
    } catch {
      throw new TypeError('Upstream Gemini response could not be converted safely');
    }
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
    tryOpenAIChatToGemini,
    responsesHistoryToGemini: createResponsesGeminiRequestConverter({
      buildGeminiRequest,
      nativeToolHistory,
      mergeAdjacentGeminiTextParts,
    }),
    isGeminiImageGenerationModel,
    geminiInlineImageToClaudeBlock,
    geminiPartToClaudeBlock,
    claudeStopReasonFromGemini,
    geminiUsageToClaude,
    geminiResponseToClaude,
    geminiResponseToResponses,
    geminiResponseToChat,
    geminiGeneratePath,
  };
}

module.exports = { createGeminiProtocol };
