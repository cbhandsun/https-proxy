'use strict';

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
    if (['function_call', 'tool_call', 'call', 'custom_tool_call'].includes(item.type)) {
      const args =
        typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {});
      const parsedArgs = parseJsonObject(args);
      const name = item.name || inferToolNameFromArguments(parsedArgs);
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
    if (item.type === 'function_call_output' || item.type === 'tool_result') {
      const output = firstDefined(item.output, item.output_text, item.content);
      return {
        role: 'tool',
        tool_call_id: item.call_id || item.id || fallbackId('call', item),
        content: typeof output === 'string' ? output : JSON.stringify(output || ''),
      };
    }
    if (item.type === 'web_search_call' || item.type === 'web_search') {
      return { role: 'assistant', content: `[Web Search: ${webSearchQuery(item)}]` };
    }
    if (item.type === 'web_search_result' || item.type === 'web_search_call_output') {
      const output = firstDefined(item.output, item.output_text, item.result, item.content);
      const text = typeof output === 'string' ? output : JSON.stringify(output || '');
      return { role: 'user', content: `[Web Search Results: ${text}]` };
    }
    if (item.type === 'thought' || item.type === 'reasoning') {
      const text = firstDefined(item.text, item.content, item.thought, '');
      return {
        role: 'assistant',
        content: null,
        reasoning_content: typeof text === 'string' ? text : JSON.stringify(text),
      };
    }
    const role = ['assistant', 'system', 'tool'].includes(item.role) ? item.role : 'user';
    if (typeof item.content === 'string') return { role, content: item.content };
    if (Array.isArray(item.content)) {
      return { role, content: item.content.map(responsesContentPartToChat) };
    }
    if (item.type === 'message') return { role, content: '' };
    return { role, content: JSON.stringify(item) };
  }

  function responsesContentPartToChat(part) {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
    if (['input_text', 'output_text', 'text'].includes(part.type)) {
      return { type: 'text', text: part.text || '' };
    }
    if (part.type === 'input_image') {
      const imageUrl = part.image_url || part.url || '';
      if (typeof imageUrl === 'string' && !imageUrl.toLowerCase().startsWith('data:')) {
        return { type: 'image_url', image_url: { url: imageUrl } };
      }
    }
    const media = inspectOpenAIMultimodalPart(part);
    if (media.recognized) {
      if (!media.ok) throw new TypeError(media.error);
      return multimodalBlockToOpenAIChatPart(media.block);
    }
    return { type: 'text', text: JSON.stringify(part) };
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
        previous.content = combinedText || null;
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

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function toClaudeBlocks(content) {
  if (Array.isArray(content)) return content;
  return typeof content === 'string' && content.length > 0 ? [{ type: 'text', text: content }] : [];
}

function webSearchQuery(item) {
  if (typeof item.arguments === 'string') {
    const parsed = parseJsonObject(item.arguments);
    return parsed.query || parsed.q || item.arguments || 'search';
  }
  if (item.arguments && typeof item.arguments === 'object') {
    return item.arguments.query || item.arguments.q || JSON.stringify(item.arguments);
  }
  return item.query ? String(item.query) : 'search';
}

module.exports = { createOpenAIMessageNormalization };
