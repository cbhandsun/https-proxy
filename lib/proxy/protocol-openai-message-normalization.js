'use strict';

const { estimateTokensForValue, stringifyWithoutInlineMedia } = require('./inline-media');
const { webSearchHistoryText } = require('./responses-web-search-history');

function createOpenAIMessageNormalization({
  fallbackId,
  inferToolNameFromArguments,
  inspectOpenAIMultimodalPart,
  multimodalBlockToOpenAIChatPart,
}) {
  function mergeAdjacentClaudeMessages(messages) {
    const merged = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!message) continue;
      const previous = merged[merged.length - 1];
      if (previous && previous.role === message.role) {
        const previousBlocks = toClaudeBlocks(previous.content);
        const currentBlocks = toClaudeBlocks(message.content);
        const combined = previousBlocks.concat(currentBlocks);
        previous.content = combined.length > 0 ? combined : '';
      } else {
        merged.push({ ...message });
      }
    }
    return merged;
  }

  function responsesInputItemToChatMessage(item) {
    if (typeof item === 'string') return { role: 'user', content: item };
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { role: 'user', content: String(item || '') };
    }
    if (item.type === 'additional_tools') {
      return null;
    }
    if (['function_call', 'tool_call', 'call', 'custom_tool_call'].includes(item.type)) {
      const args =
        item.type === 'custom_tool_call'
          ? customToolArgumentsFromInput(item.input)
          : typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments || {});
      const name = item.name || inferToolNameFromArguments(parseJsonObject(args));
      if (!name) return null;
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || fallbackId('call', item),
            type: 'function',
            function: { name, arguments: args },
          },
        ],
      };
    }
    if (
      item.type === 'function_call_output' ||
      item.type === 'custom_tool_call_output' ||
      item.type === 'tool_result'
    ) {
      const output = firstDefined(item.output, item.output_text, item.content);
      const isError = item.is_error === true || item.status === 'error';
      const resultMsg = {
        role: 'tool',
        tool_call_id: item.call_id || item.id || fallbackId('call', item),
        content: toolOutputToChatContent(output),
      };
      if (isError) resultMsg.is_error = true;
      return resultMsg;
    }
    if (item.type === 'web_search_call' || item.type === 'web_search') {
      return { role: 'assistant', content: `[Web Search: ${webSearchHistoryText(item)}]` };
    }
    if (item.type === 'web_search_result' || item.type === 'web_search_call_output') {
      const output = firstDefined(item.output, item.output_text, item.result, item.content);
      const text = output == null ? '' : describeResponsesPayload(output);
      return { role: 'user', content: `[Web Search Results: ${text}]` };
    }
    if (item.type === 'thought' || item.type === 'reasoning') {
      const summaryText = reasoningSummaryText(item);
      const text =
        summaryText ||
        describeResponsesPayload(firstDefined(item.text, item.content, item.thought, ''));
      return {
        role: 'assistant',
        content: null,
        reasoning_content: text,
      };
    }
    const role = ['assistant', 'system', 'developer', 'tool'].includes(item.role)
      ? item.role
      : 'user';
    if (typeof item.content === 'string') return { role, content: item.content };
    if (Array.isArray(item.content)) {
      return { role, content: item.content.map(responsesContentPartToChat) };
    }
    if (item.type === 'message') return { role, content: '' };
    return { role, content: describeResponsesPayload(item) };
  }

  function responsesContentPartToChat(part) {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
    if (['input_text', 'output_text', 'text'].includes(part.type)) {
      return { type: 'text', text: part.text || '' };
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      const rawUrl =
        typeof part.image_url === 'string'
          ? part.image_url
          : part.image_url && typeof part.image_url.url === 'string'
            ? part.image_url.url
            : typeof part.url === 'string'
              ? part.url
              : '';
      const detail =
        part.detail ||
        (part.image_url && typeof part.image_url === 'object' ? part.image_url.detail : undefined);
      if (typeof rawUrl === 'string' && rawUrl && !rawUrl.toLowerCase().startsWith('data:')) {
        return {
          type: 'image_url',
          image_url: {
            url: rawUrl,
            ...(detail ? { detail } : {}),
          },
        };
      }
    }
    const media = inspectOpenAIMultimodalPart(part);
    if (media.recognized) {
      if (!media.ok) throw new TypeError(media.error);
      return multimodalBlockToOpenAIChatPart(media.block);
    }
    // Unknown part types may still carry media in a field we do not model; redact so
    // the base64 never lands in a text field (which upstreams bill per character).
    return { type: 'text', text: stringifyWithoutInlineMedia(part) };
  }

  /**
   * Tool/function outputs may be an array of Responses content parts, e.g.
   * [{type:'input_text'}, {type:'input_image', image_url:'data:image/png;base64,...'}].
   * Serializing that array as JSON text turns the base64 into literal prompt text,
   * which upstream tokenizers bill as ordinary characters. A ~500 KB image becomes
   * ~125k tokens per copy instead of roughly a hundred image tokens, so a handful of
   * repeated tool outputs blows past the model context window. Keep multimodal parts
   * structured; only flatten when the output is already plain text or holds no media.
   */
  function toolOutputToChatContent(output) {
    if (typeof output === 'string') return output;
    if (!Array.isArray(output)) {
      if (output == null) return '';
      if (output && typeof output === 'object') {
        const media = inspectOpenAIMultimodalPart(output);
        if (media.recognized && media.ok) return [multimodalBlockToOpenAIChatPart(media.block)];
      }
      return stringifyWithoutInlineMedia(output);
    }
    const hasMedia = output.some((part) => {
      if (!part || typeof part !== 'object') return false;
      const media = inspectOpenAIMultimodalPart(part);
      return media.recognized;
    });
    if (!hasMedia) {
      return JSON.stringify(output);
    }
    return output.map((part) => responsesContentPartToChat(part));
  }

  function mergeAdjacentAssistantMessages(messages) {
    const merged = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!message) continue;
      const previous = merged[merged.length - 1];
      if (previous && previous.role === 'assistant' && message.role === 'assistant') {
        const combinedText = joinMessageText(previous.content, message.content);
        const combinedToolCalls = [
          ...(Array.isArray(previous.tool_calls) ? previous.tool_calls : []),
          ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
        ];
        const combinedReasoning = [previous.reasoning_content, message.reasoning_content]
          .filter(Boolean)
          .join('\n');
        previous.content = combinedText || null;
        if (combinedReasoning) previous.reasoning_content = combinedReasoning;
        if (combinedToolCalls.length > 0) previous.tool_calls = combinedToolCalls;
        else delete previous.tool_calls;
      } else {
        merged.push({ ...message });
      }
    }
    return merged;
  }

  return {
    mergeAdjacentAssistantMessages,
    mergeAdjacentClaudeMessages,
    responsesInputItemToChatMessage,
  };
}

function firstDefined(...values) {
  return values.find((value) => value != null);
}

function customToolArgumentsFromInput(input) {
  if (typeof input === 'string') return JSON.stringify({ input });
  if (input && typeof input === 'object' && !Array.isArray(input)) return JSON.stringify(input);
  return JSON.stringify({ input: input == null ? '' : String(input) });
}

/**
 * Flatten a Responses payload into text *without* expanding inline media base64.
 * Structures that hold media (image/audio/video parts, data URLs, inlineData/
 * b64_json) are replaced by a short placeholder, because serializing base64 into
 * a text field makes upstream tokenizers bill it per character. Text-only
 * structures keep their previous JSON shape so existing behaviour is unchanged.
 */
function describeResponsesPayload(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  return stringifyWithoutInlineMedia(value);
}

function joinMessageText(previous, current) {
  const previousText = messageText(previous);
  const currentText = messageText(current);
  return previousText && currentText
    ? `${previousText}\n${currentText}`
    : previousText || currentText;
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && part.text ? part.text : '')).join('');
}

/**
 * Normalize a Responses `reasoning` item into plain text.
 *
 * The Responses API ships two shapes for reasoning content and clients emit
 * both: a legacy `summary` string, and the newer `summary` array of
 * `{type:'summary_text', text}` parts. Reading `summary` as a string
 * unconditionally yields "[object Object]", which silently destroys the
 * model's chain of thought on every multi-turn request.
 */
function reasoningSummaryText(item) {
  if (!item || typeof item !== 'object') return '';
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string' && value) parts.push(value);
  };
  push(item.text);
  push(item.thought);
  const summary = item.summary;
  if (typeof summary === 'string') {
    push(summary);
  } else if (Array.isArray(summary)) {
    for (const entry of summary) {
      if (typeof entry === 'string') push(entry);
      else if (entry && typeof entry === 'object') push(entry.text);
    }
  } else if (summary && typeof summary === 'object') {
    push(summary.text);
  }
  if (parts.length === 0 && Array.isArray(item.content)) {
    for (const entry of item.content) {
      if (typeof entry === 'string') push(entry);
      else if (entry && typeof entry === 'object') push(entry.text);
    }
  }
  return parts.join('\n');
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

/**
 * Mirror of toolOutputToChatContent for the reverse direction (Chat entry -> Responses
 * upstream). A tool message whose content is an array of chat parts used to be
 * JSON.stringify'd, which turned inline image base64 into literal prompt text. Keep
 * media parts structured so upstream tokenizers bill an image, not its characters.
 */
function chatToolContentToResponsesOutput(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content || '');
  const hasMedia = content.some(
    (part) => part && typeof part === 'object' && part.type === 'image_url'
  );
  if (!hasMedia) return JSON.stringify(content);
  return content.map((part) => {
    if (part && typeof part === 'object') {
      // Mirrors the shapes Codex sends for function_call_output: input_text / input_image.
      if (part.type === 'text') return { type: 'input_text', text: part.text || '' };
      if (part.type === 'image_url') {
        const url =
          typeof part.image_url === 'string'
            ? part.image_url
            : part.image_url && part.image_url.url;
        if (typeof url === 'string' && url) return { type: 'input_image', image_url: url };
      }
    }
    return { type: 'input_text', text: JSON.stringify(part) };
  });
}

function toClaudeBlocks(content) {
  if (Array.isArray(content)) return content;
  return typeof content === 'string' && content.length > 0 ? [{ type: 'text', text: content }] : [];
}

module.exports = {
  createOpenAIMessageNormalization,
  chatToolContentToResponsesOutput,
  estimatePayloadTokens: estimateTokensForValue,
  describeResponsesPayload,
  reasoningSummaryText,
};
