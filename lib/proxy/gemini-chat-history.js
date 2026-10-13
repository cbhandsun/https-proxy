'use strict';

const { inspectOpenAIMultimodalPart } = require('./multimodal-content');
const { inferToolNameFromArguments } = require('./protocol-openai-responses-request');
const { stringifyWithoutInlineMedia } = require('./inline-media');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message) {
  const error = new TypeError(message);
  error.code = 'invalid_request_error';
  throw error;
}
function chatPartToGemini(part) {
  if (typeof part === 'string') return { text: part };
  if (!record(part)) invalid('Gemini Chat content parts must be objects or strings');
  if (part.type === 'text') {
    if (typeof part.text !== 'string') invalid('Gemini Chat text must be a string');
    return { text: part.text };
  }
  const media = inspectOpenAIMultimodalPart(part);
  if (!media.recognized) invalid('Chat content type is not supported by Gemini conversion');
  if (!media.ok) invalid('Invalid inline media for Gemini conversion');
  if (
    part.type === 'image_url' &&
    record(part.image_url) &&
    part.image_url.detail != null &&
    !['auto', 'low', 'high'].includes(part.image_url.detail)
  )
    invalid('Image detail must be auto, low, or high');
  return { inlineData: { mimeType: media.block.source.media_type, data: media.block.source.data } };
}
function chatContentToGemini(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) invalid('Gemini Chat content must be text or an array');
  return content.filter((part) => part != null).map(chatPartToGemini);
}
function parseCall(
  call,
  { cleanToolArgs, fallbackId, argumentsCache, cacheArguments = false } = {}
) {
  if (!record(call) || (call.type != null && call.type !== 'function') || !record(call.function))
    invalid('Gemini Chat history requires function tool calls');
  if (call.id != null && (typeof call.id !== 'string' || !call.id))
    invalid('Gemini Chat tool call ID must be a non-empty string');
  const fn = call.function;
  const source = fn.arguments ?? {};
  const cached = argumentsCache?.get(call);
  // Consume once: sanitizers may mutate parsed objects, and repeated call objects
  // must not inherit those mutations on their next conversion.
  argumentsCache?.delete(call);
  let args = cached?.source === source ? cached.parsed : source;
  if (typeof args === 'string') {
    if (!args.trim()) args = {};
    else {
      try {
        args = JSON.parse(args);
      } catch {
        invalid('Gemini Chat tool arguments must be valid JSON objects');
      }
    }
  }
  if (!record(args)) invalid('Gemini Chat tool arguments must be JSON objects');
  const name = fn.name || call.name || inferToolNameFromArguments(args);
  if (typeof name !== 'string' || !name.trim()) invalid('Gemini Chat tool call requires a name');
  if (cacheArguments && typeof source === 'string')
    argumentsCache?.set(call, { source, parsed: args });
  const input = cleanToolArgs ? cleanToolArgs(name, args) : args;
  return {
    id: call.id || (fallbackId ? fallbackId('toolu_openai', { name, input }) : ''),
    name,
    args: input,
  };
}
function validateGeminiChatHistory(messages, argumentsCache) {
  for (const message of messages) {
    if (
      message.reasoning_content != null &&
      (message.role !== 'assistant' || typeof message.reasoning_content !== 'string')
    )
      invalid('Gemini Chat reasoning history must be text');
    if (message.tool_calls != null) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls))
        invalid('Gemini Chat tool calls require an assistant array');
      for (const call of message.tool_calls)
        parseCall(call, { argumentsCache, cacheArguments: true });
    }
    // Generic Chat validation already checked ordinary Gemini parts. Tool
    // results bypass that loop and need the same media/text validation here.
    if (message.role === 'tool') chatContentToGemini(message.content);
    if (
      ['system', 'developer'].includes(message.role) &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part != null && typeof part !== 'string' && part.type !== 'text'
      )
    )
      invalid('Gemini system instructions only support text');
    if (
      message.role === 'tool' &&
      (typeof message.tool_call_id !== 'string' || !message.tool_call_id)
    )
      invalid('Gemini Chat tool result requires a call ID');
  }
}

function createGeminiChatHistoryAdapter({
  nativeToolHistory,
  mergeAdjacentGeminiTextParts,
  cleanToolArgs,
  fallbackId,
  argumentsCache,
}) {
  const deps = { cleanToolArgs, fallbackId, argumentsCache };
  function convertChatMessage(message, options, orphan, parsedCalls) {
    const contentParts = chatContentToGemini(message.content);
    if (message.role === 'tool') {
      const text = contentParts
        .filter((part) => !part.inlineData)
        .map((part) => part.text ?? stringifyWithoutInlineMedia(part))
        .join('\n');
      return {
        role: 'user',
        parts: nativeToolHistory.resultParts(
          {
            id: message.tool_call_id,
            name: message.name,
            text,
            mediaParts: contentParts.filter((part) => part.inlineData),
            error: message.is_error === true || message.status === 'error',
            orphan,
          },
          options
        ),
      };
    }
    const parts = [...contentParts];
    if (message.role === 'assistant' && message.reasoning_content)
      parts.unshift({ thought: true, text: message.reasoning_content });
    for (const call of parsedCalls) parts.push(...nativeToolHistory.callParts(call, options));
    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: parts.length ? mergeAdjacentGeminiTextParts(parts) : [{ text: '' }],
    };
  }
  function repairHistory(messages, options) {
    const nativeOptions = { ...options, preserveIds: true };
    let repairedCount = 0;
    let precedingCalls = new Set();
    let previousRole = null;
    const repaired = [];
    for (const message of messages) {
      // Reuse sanitized calls and generated IDs for wire output and budget groups.
      const parsedCalls = (message.tool_calls || []).map((call) => parseCall(call, deps));
      let orphan = false;
      if (message.role === 'assistant') {
        if (previousRole !== 'assistant') precedingCalls = new Set();
        for (const call of parsedCalls) precedingCalls.add(call.id);
      } else if (message.role === 'tool') {
        if (!precedingCalls.has(message.tool_call_id)) {
          repairedCount++;
          orphan = true;
        }
      }
      previousRole = message.role;
      const converted = convertChatMessage(message, nativeOptions, orphan, parsedCalls);
      const role = converted.role === 'model' ? 'assistant' : 'user';
      const calls = parsedCalls.map((call) => ({ id: call.id }));
      const results = message.role === 'tool' && !orphan ? [message.tool_call_id] : [];
      const previous = repaired.at(-1);
      if (previous?.role === role) {
        previous.content = mergeAdjacentGeminiTextParts([...previous.content, ...converted.parts]);
        previous.tool_calls.push(...calls);
        previous.tool_result_ids.push(...results);
      } else
        repaired.push({
          role,
          content: converted.parts,
          tool_calls: calls,
          tool_result_ids: results,
        });
    }
    return { messages: repaired, repairedCount };
  }
  function convertMessage(message) {
    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: typeof message.content === 'string' ? [{ text: message.content }] : message.content,
    };
  }
  return { convertMessage, repairHistory };
}

module.exports = {
  chatPartToGemini,
  chatContentToGemini,
  validateGeminiChatHistory,
  createGeminiChatHistoryAdapter,
};
