'use strict';

const { pruneMessagesToTokenBudget } = require('./context-budget-manager');
const { isToolResponseMessage } = require('./context-optimizer');

const WORKBUDDY_WBIPC_PAYLOAD_TOO_LARGE = 'E_PAYLOAD_TOO_LARGE';
const DEFAULT_WBIPC_RETRY_BODY_BYTES = 384 * 1024;
const DEFAULT_WBIPC_RETRY_TOOL_CHARS = 64 * 1024;
const DEFAULT_WBIPC_RETRY_PROTECTED_MESSAGE_CHARS = 256 * 1024;
const MAX_TOOL_DESCRIPTION_CHARS = 512;
const MAX_SCHEMA_DESCRIPTION_CHARS = 160;
const OMITTED_TOOL_SCHEMA_KEYS = new Set(['examples', 'example', 'externalDocs', '$comment']);
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function isWorkBuddyWbipcPayloadTooLarge(result) {
  return !!(
    result &&
    result.ok !== true &&
    String(result.status || '').toUpperCase() === WORKBUDDY_WBIPC_PAYLOAD_TOO_LARGE
  );
}

function compactToolText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  const notice =
    '\n[...WorkBuddy request fallback folded this oversized message; reread smaller slices if needed...]\n';
  const available = Math.max(0, maxChars - notice.length);
  const headChars = Math.ceil(available / 2);
  const tailChars = available - headChars;
  return text.slice(0, headChars) + notice + (tailChars ? text.slice(-tailChars) : '');
}

function compactToolContent(content, maxChars) {
  if (typeof content === 'string') {
    const compacted = compactToolText(content, maxChars);
    return { content: compacted, changed: compacted !== content };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const compacted = content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'tool_result') {
      const nested = compactToolContent(part.content, maxChars);
      if (!nested.changed) return part;
      changed = true;
      return { ...part, content: nested.content };
    }
    if (
      ['text', 'input_text', 'output_text'].includes(part.type) &&
      typeof part.text === 'string'
    ) {
      const text = compactToolText(part.text, maxChars);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    }
    return part;
  });
  return { content: changed ? compacted : content, changed };
}

function protectedMessageBytes(messages) {
  return messages
    .filter((message) => message && ['system', 'developer'].includes(message.role))
    .reduce((sum, message) => sum + jsonBytes(message), 0);
}

function compactOversizedMessages(
  messages,
  maxChars = DEFAULT_WBIPC_RETRY_TOOL_CHARS,
  maxProtectedChars = DEFAULT_WBIPC_RETRY_PROTECTED_MESSAGE_CHARS
) {
  let foldedToolOutputs = 0;
  let foldedMessages = 0;
  let foldedProtectedMessages = 0;
  const compacted = messages.map((message) => {
    if (!message) return message;
    const isProtected = ['system', 'developer'].includes(message.role);
    const result = compactToolContent(message.content, isProtected ? maxProtectedChars : maxChars);
    if (!result.changed) return message;
    if (isProtected) foldedProtectedMessages += 1;
    else if (isToolResponseMessage(message)) foldedToolOutputs += 1;
    else foldedMessages += 1;
    return { ...message, content: result.content };
  });
  return { messages: compacted, foldedMessages, foldedProtectedMessages, foldedToolOutputs };
}

function setOwnValue(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function compactToolSchemaValue(value, depth = 0, preserveEntryKeys = false) {
  if (Array.isArray(value)) {
    let changed = false;
    const compacted = value.map((item) => {
      const nested = compactToolSchemaValue(item, depth, preserveEntryKeys);
      changed = changed || nested.changed;
      return nested.value;
    });
    return { value: changed ? compacted : value, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const compacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (!preserveEntryKeys && OMITTED_TOOL_SCHEMA_KEYS.has(key)) {
      changed = true;
      continue;
    }
    if (key === 'description' && typeof item === 'string') {
      const maxChars = depth <= 1 ? MAX_TOOL_DESCRIPTION_CHARS : MAX_SCHEMA_DESCRIPTION_CHARS;
      const description = item.length > maxChars ? item.slice(0, maxChars) : item;
      setOwnValue(compacted, key, description);
      changed = changed || description !== item;
      continue;
    }
    const nested = compactToolSchemaValue(item, depth + 1, SCHEMA_MAP_KEYS.has(key));
    setOwnValue(compacted, key, nested.value);
    changed = changed || nested.changed;
  }
  return { value: changed ? compacted : value, changed };
}

function compactWorkBuddyTools(tools) {
  if (!Array.isArray(tools)) return { tools, changed: false, originalBytes: 0, bodyBytes: 0 };
  const compacted = compactToolSchemaValue(tools);
  return {
    tools: compacted.value,
    changed: compacted.changed,
    originalBytes: jsonBytes(tools),
    bodyBytes: jsonBytes(compacted.value),
  };
}

function compactWorkBuddyWbipcBody(
  chatBody,
  maxBodyBytes = DEFAULT_WBIPC_RETRY_BODY_BYTES,
  maxToolChars = DEFAULT_WBIPC_RETRY_TOOL_CHARS,
  maxProtectedChars = DEFAULT_WBIPC_RETRY_PROTECTED_MESSAGE_CHARS
) {
  if (!chatBody || typeof chatBody !== 'object' || !Array.isArray(chatBody.messages)) {
    return { changed: false, body: chatBody, bodyBytes: jsonBytes(chatBody) };
  }
  const safeMaxBytes = Math.max(1024, Math.trunc(Number(maxBodyBytes) || 0));
  const originalBytes = jsonBytes(chatBody);
  if (originalBytes <= safeMaxBytes) {
    return { changed: false, body: chatBody, bodyBytes: originalBytes };
  }

  const compactedTools = compactWorkBuddyTools(chatBody.tools);
  const schemaBody = compactedTools.changed
    ? { ...chatBody, tools: compactedTools.tools }
    : chatBody;
  const originalProtectedMessageBytes = protectedMessageBytes(schemaBody.messages);
  const folded = compactOversizedMessages(schemaBody.messages, maxToolChars, maxProtectedChars);
  const foldedBody = { ...schemaBody, messages: folded.messages };
  const bodyWithoutMessages = { ...foldedBody, messages: [] };
  const fixedBytes = jsonBytes(bodyWithoutMessages);
  const messageBudgetBytes = Math.max(0, safeMaxBytes - fixedBytes);
  const pruned = pruneMessagesToTokenBudget(foldedBody.messages, messageBudgetBytes, (message) =>
    jsonBytes(message)
  );
  const body = { ...foldedBody, messages: pruned.messages };
  const bodyBytes = jsonBytes(body);
  return {
    changed:
      (compactedTools.changed ||
        folded.foldedMessages > 0 ||
        folded.foldedProtectedMessages > 0 ||
        folded.foldedToolOutputs > 0 ||
        pruned.droppedCount > 0) &&
      bodyBytes < originalBytes,
    body,
    bodyBytes,
    originalBytes,
    droppedCount: pruned.droppedCount,
    foldedMessages: folded.foldedMessages,
    foldedProtectedMessages: folded.foldedProtectedMessages,
    foldedToolOutputs: folded.foldedToolOutputs,
    originalProtectedMessageBytes,
    retryProtectedMessageBytes: protectedMessageBytes(body.messages),
    originalToolsBytes: compactedTools.originalBytes,
    retryToolsBytes: compactedTools.bodyBytes,
    fits: bodyBytes <= safeMaxBytes,
  };
}

module.exports = {
  DEFAULT_WBIPC_RETRY_BODY_BYTES,
  DEFAULT_WBIPC_RETRY_PROTECTED_MESSAGE_CHARS,
  DEFAULT_WBIPC_RETRY_TOOL_CHARS,
  WORKBUDDY_WBIPC_PAYLOAD_TOO_LARGE,
  compactWorkBuddyTools,
  compactWorkBuddyWbipcBody,
  isWorkBuddyWbipcPayloadTooLarge,
};
