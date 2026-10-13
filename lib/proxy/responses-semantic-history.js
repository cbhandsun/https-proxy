'use strict';

const {
  inspectOpenAIMultimodalPart,
  validateClaudeMultimodalBlock,
  multimodalBlockToOpenAIChatPart,
} = require('./multimodal-content');
const {
  describeResponsesPayload,
  reasoningSummaryText,
} = require('./protocol-openai-message-normalization');
const { inferToolNameFromArguments } = require('./protocol-openai-responses-request');
const { webSearchHistoryText } = require('./responses-web-search-history');
const {
  PROVIDER_CONTEXT_ITEM_TYPE,
  normalizeProviderContextItem,
} = require('./provider-context-history');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalidHistory() {
  const error = new TypeError('Invalid Responses semantic history');
  error.code = 'invalid_request_error';
  throw error;
}
function argumentsObject(value) {
  let args = value ?? {};
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      invalidHistory();
    }
  }
  if (!record(args)) invalidHistory();
  function check(node, depth) {
    if (depth > 64) invalidHistory();
    if (node == null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) invalidHistory();
      return;
    }
    if (typeof node !== 'object') invalidHistory();
    if (
      !Array.isArray(node) &&
      Object.getPrototypeOf(node) !== Object.prototype &&
      Object.getPrototypeOf(node) !== null
    )
      invalidHistory();
    for (const [key, child] of Object.entries(node)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalidHistory();
      check(child, depth + 1);
    }
  }
  check(args, 0);
  return args;
}
function contentPart(part) {
  if (typeof part === 'string') return { kind: 'text', text: part };
  if (!record(part)) invalidHistory();
  if (['text', 'input_text', 'output_text', 'summary_text'].includes(part.type)) {
    if (typeof part.text !== 'string') invalidHistory();
    return { kind: 'text', text: part.text };
  }
  if (part.type === 'refusal' && typeof part.refusal === 'string')
    return { kind: 'text', text: part.refusal };
  if (['thought', 'reasoning'].includes(part.type))
    return { kind: 'reasoning', text: reasoningSummaryText(part) };
  const media = inspectOpenAIMultimodalPart(part);
  if (!media.recognized || !media.ok) invalidHistory();
  return {
    kind: 'media',
    mediaKind: media.kind,
    mediaType: media.block.source.media_type,
    data: media.block.source.data,
  };
}
function contentParts(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) invalidHistory();
  return content.filter((part) => part != null).map(contentPart);
}
function outputParts(output) {
  if (typeof output === 'string' || output == null) return contentParts(output ?? '');
  if (
    Array.isArray(output) &&
    output.every(
      (part) => typeof part === 'string' || (record(part) && typeof part.type === 'string')
    )
  )
    return contentParts(output);
  const media = inspectOpenAIMultimodalPart(output);
  return media.recognized
    ? [contentPart(output)]
    : [{ kind: 'text', text: describeResponsesPayload(output) }];
}
function id(value, fallback) {
  if (value == null) return fallback();
  if (typeof value !== 'string' || !value || value.length > 4096) invalidHistory();
  return value;
}
function parseResponsesHistory(input, { fallbackId }, instructions) {
  const history = [];
  if (instructions != null) {
    if (typeof instructions !== 'string') invalidHistory();
    if (instructions) history.push({ role: 'system', parts: contentParts(instructions) });
  }
  if (input == null) return history;
  const items = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(items)) invalidHistory();
  for (const item of items) {
    if (typeof item === 'string') {
      history.push({ role: 'user', parts: contentParts(item) });
      continue;
    }
    if (!record(item)) invalidHistory();
    const type = item.type || 'message';
    if (type === 'additional_tools') continue;
    if (['function_call', 'tool_call', 'call', 'custom_tool_call'].includes(type)) {
      const args =
        type === 'custom_tool_call'
          ? typeof item.input === 'string'
            ? { input: item.input }
            : argumentsObject(item.input)
          : argumentsObject(item.arguments);
      const name = item.name || inferToolNameFromArguments(args);
      if (typeof name !== 'string' || !name.trim()) invalidHistory();
      history.push({
        role: 'assistant',
        parts: [
          {
            kind: 'call',
            id: id(item.call_id ?? item.id, () => fallbackId('call', item)),
            name,
            args,
          },
        ],
      });
    } else if (['function_call_output', 'custom_tool_call_output', 'tool_result'].includes(type)) {
      history.push({
        role: 'user',
        parts: [
          {
            kind: 'result',
            id: id(item.call_id ?? item.id, () => fallbackId('call', item)),
            parts: outputParts(item.output ?? item.output_text ?? item.content),
            error: item.is_error === true || item.status === 'error',
          },
        ],
      });
    } else if (['reasoning', 'thought'].includes(type)) {
      if (item.encrypted_content != null && typeof item.encrypted_content !== 'string')
        invalidHistory();
      history.push({
        role: 'assistant',
        parts: [
          {
            kind: 'reasoning',
            text: reasoningSummaryText(item),
            ...(item.encrypted_content ? { encryptedContent: item.encrypted_content } : {}),
          },
        ],
      });
    } else if (type === PROVIDER_CONTEXT_ITEM_TYPE) {
      const normalized = normalizeProviderContextItem(item);
      history.push({
        role: 'assistant',
        parts: [
          {
            kind: 'provider_context',
            provider: normalized.provider,
            data: normalized.data,
          },
        ],
      });
    } else if (['web_search_call', 'web_search'].includes(type)) {
      history.push({
        role: 'assistant',
        parts: [{ kind: 'text', text: '[Web Search: ' + webSearchHistoryText(item) + ']' }],
      });
    } else if (['web_search_result', 'web_search_call_output'].includes(type)) {
      history.push({
        role: 'user',
        parts: [
          {
            kind: 'text',
            text:
              '[Web Search Results: ' +
              describeResponsesPayload(
                item.output ?? item.output_text ?? item.result ?? item.content ?? ''
              ) +
              ']',
          },
        ],
      });
    } else if (type === 'message') {
      const role = item.role || 'user';
      if (!['system', 'developer', 'user', 'assistant'].includes(role)) invalidHistory();
      history.push({ role, parts: contentParts(item.content) });
    } else invalidHistory();
  }
  return history;
}
function chatHistoryToSemantic(messages, deps) {
  if (!Array.isArray(messages)) invalidHistory();
  const history = [];
  for (const message of messages) {
    if (!record(message)) invalidHistory();
    if (message.role === 'tool') {
      history.push({
        role: 'user',
        parts: [
          {
            kind: 'result',
            id: id(message.tool_call_id, () => deps.fallbackId('call', message)),
            ...(typeof message.name === 'string' ? { name: message.name } : {}),
            parts: contentParts(message.content),
            error: message.is_error === true || message.status === 'error',
          },
        ],
      });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) invalidHistory();
    const parts = contentParts(message.content);
    if (message.reasoning_content != null) {
      if (typeof message.reasoning_content !== 'string') invalidHistory();
      parts.unshift({ kind: 'reasoning', text: message.reasoning_content });
    }
    if (message.tool_calls != null && !Array.isArray(message.tool_calls)) invalidHistory();
    for (const call of message.tool_calls || []) {
      if (!record(call) || !record(call.function)) invalidHistory();
      const args = argumentsObject(call.function.arguments);
      const name = call.function.name || inferToolNameFromArguments(args);
      if (typeof name !== 'string' || !name) invalidHistory();
      parts.push({
        kind: 'call',
        id: id(call.id, () => deps.fallbackId('toolu_openai', { name, input: args })),
        name,
        args,
      });
    }
    history.push({ role: message.role, parts });
  }
  return history;
}
function semanticMediaBlock(part) {
  return {
    type: part.mediaKind,
    source: { type: 'base64', media_type: part.mediaType, data: part.data },
  };
}
function semanticHistoryToChat(history) {
  const messages = [];
  const toContent = (parts) =>
    parts.map((part) =>
      part.kind === 'media'
        ? multimodalBlockToOpenAIChatPart(semanticMediaBlock(part))
        : { type: 'text', text: part.text || '' }
    );
  for (const message of history) {
    let parts = [];
    const flush = () => {
      if (parts.length) {
        messages.push({ role: message.role, content: toContent(parts) });
        parts = [];
      }
    };
    for (const part of message.parts) {
      if (part.kind === 'call') {
        flush();
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: part.id,
              type: 'function',
              function: { name: part.name, arguments: JSON.stringify(part.args) },
            },
          ],
        });
      } else if (part.kind === 'result') {
        flush();
        messages.push({
          role: 'tool',
          tool_call_id: part.id,
          content: toContent(part.parts),
          ...(part.error ? { is_error: true } : {}),
        });
      } else if (part.kind === 'reasoning') {
        flush();
        messages.push({ role: 'assistant', content: null, reasoning_content: part.text });
      } else if (part.kind === 'provider_context') {
        // OpenAI Chat has no safe opaque representation for provider context.
        // Refuse a lossy cross-provider replay rather than turning it into prompt text.
        invalidHistory();
      } else parts.push(part);
    }
    flush();
  }
  return messages;
}
function isSemanticEntry(value) {
  return record(value) && value.version === 2 && Array.isArray(value.history);
}
function sanitizeSemanticHistory(history) {
  validateSemanticHistory(history);
  return history.filter(
    (message) =>
      message.role !== 'assistant' ||
      message.parts.some((part) => {
        if (part.kind === 'text' || part.kind === 'reasoning')
          return Boolean(part.text.trim() || part.encryptedContent);
        return true;
      })
  );
}
function validateSemanticHistory(history) {
  if (!Array.isArray(history)) invalidHistory();
  function checkPart(part, resultDepth = 0) {
    if (!record(part)) invalidHistory();
    if (part.kind === 'text' || part.kind === 'reasoning') {
      if (
        typeof part.text !== 'string' ||
        (part.encryptedContent != null && typeof part.encryptedContent !== 'string')
      )
        invalidHistory();
    } else if (part.kind === 'media') {
      const media = validateClaudeMultimodalBlock(semanticMediaBlock(part));
      if (!media.recognized || !media.ok) invalidHistory();
    } else if (part.kind === 'call' && resultDepth === 0) {
      id(part.id, invalidHistory);
      if (typeof part.name !== 'string' || !part.name) invalidHistory();
      argumentsObject(part.args);
    } else if (part.kind === 'result' && resultDepth === 0) {
      id(part.id, invalidHistory);
      if (!Array.isArray(part.parts) || typeof part.error !== 'boolean') invalidHistory();
      for (const nested of part.parts) checkPart(nested, 1);
    } else if (part.kind === 'provider_context' && resultDepth === 0) {
      normalizeProviderContextItem({
        type: PROVIDER_CONTEXT_ITEM_TYPE,
        provider: part.provider,
        visible_output_index: 0,
        data: part.data,
      });
    } else invalidHistory();
  }
  for (const message of history) {
    if (
      !record(message) ||
      !['system', 'developer', 'user', 'assistant'].includes(message.role) ||
      !Array.isArray(message.parts)
    )
      invalidHistory();
    for (const part of message.parts) checkPart(part);
  }
  return history;
}
module.exports = {
  parseResponsesHistory,
  chatHistoryToSemantic,
  semanticHistoryToChat,
  semanticMediaBlock,
  validateSemanticHistory,
  sanitizeSemanticHistory,
  isSemanticEntry,
  invalidHistory,
};
