'use strict';

const { pruneMessagesToTokenBudget } = require('./context-budget-manager');
const { isToolResponseMessage } = require('./context-optimizer');
const { CONTEXT_CLASSES, classifyContextMessages } = require('./context-classifier');

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
const CHECKPOINT_MARKER = '[HPM_CONTEXT_CHECKPOINT_V1]';
const EVIDENCE_RECEIPT_MARKER = '[HPM_EVIDENCE_RECEIPT_V1]';

function isCheckpointMessage(message) {
  return !!(
    message &&
    typeof message.content === 'string' &&
    message.content.startsWith(`${CHECKPOINT_MARKER}\n`)
  );
}

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
  const safeMaxChars = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (safeMaxChars <= notice.length) return notice.slice(0, safeMaxChars);
  const available = safeMaxChars - notice.length;
  const headChars = Math.ceil(available / 2);
  const tailChars = available - headChars;
  return text.slice(0, headChars) + notice + (tailChars ? text.slice(-tailChars) : '');
}

function compactableTextLeaves(content) {
  if (typeof content === 'string') return 1;
  if (!Array.isArray(content)) return 0;
  return content.reduce((count, part) => {
    if (!part || typeof part !== 'object') return count;
    if (part.type === 'tool_result') return count + compactableTextLeaves(part.content);
    return (
      count +
      (['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string'
        ? 1
        : 0)
    );
  }, 0);
}

function compactToolContentWithBudget(content, state) {
  if (typeof content === 'string') {
    const budget = Math.floor(state.remainingChars / Math.max(1, state.remainingLeaves));
    state.remainingLeaves -= 1;
    const compacted = compactToolText(content, budget);
    state.remainingChars = Math.max(0, state.remainingChars - compacted.length);
    return { content: compacted, changed: compacted !== content };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const compacted = content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'tool_result') {
      const nested = compactToolContentWithBudget(part.content, state);
      if (!nested.changed) return part;
      changed = true;
      return { ...part, content: nested.content };
    }
    if (
      ['text', 'input_text', 'output_text'].includes(part.type) &&
      typeof part.text === 'string'
    ) {
      const budget = Math.floor(state.remainingChars / Math.max(1, state.remainingLeaves));
      state.remainingLeaves -= 1;
      const text = compactToolText(part.text, budget);
      state.remainingChars = Math.max(0, state.remainingChars - text.length);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    }
    return part;
  });
  return { content: changed ? compacted : content, changed };
}

function compactToolContent(content, maxChars) {
  return compactToolContentWithBudget(content, {
    remainingChars: Math.max(0, Math.floor(Number(maxChars) || 0)),
    remainingLeaves: compactableTextLeaves(content),
  });
}

function compactableTextChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((count, part) => {
    if (!part || typeof part !== 'object') return count;
    if (part.type === 'tool_result') return count + compactableTextChars(part.content);
    return (
      count +
      (['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string'
        ? part.text.length
        : 0)
    );
  }, 0);
}

function contentContainsMarker(content, marker) {
  if (typeof content === 'string') return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'tool_result') return contentContainsMarker(part.content, marker);
    return (
      ['text', 'input_text', 'output_text'].includes(part.type) &&
      typeof part.text === 'string' &&
      part.text.includes(marker)
    );
  });
}

function boundaryCompactionPriority(message) {
  if (isToolResponseMessage(message)) return 0;
  if (message && message.role === 'assistant') return 1;
  if (message && message.role === 'user') return 2;
  return 3;
}

function compactBodyToByteLimit(body, maxBodyBytes, options = {}) {
  const minimumChars = options.minimumChars || 0;
  let workingBody = body;
  let workingMessages = body.messages;
  let bodyBytes = jsonBytes(body);
  let foldedMessages = 0;
  let foldedToolOutputs = 0;
  const candidates = workingMessages
    .map((message, index) => ({ index, message }))
    .filter(({ message }) => {
      if (options.protectedMessages?.has(message)) return false;
      if (!message || ['system', 'developer'].includes(message.role)) return false;
      if (options.preserveUsers && message.role === 'user') return false;
      if (isCheckpointMessage(message)) return false;
      if (contentContainsMarker(message.content, EVIDENCE_RECEIPT_MARKER)) return false;
      return compactableTextChars(message.content) > minimumChars;
    })
    .sort(
      (left, right) =>
        boundaryCompactionPriority(left.message) - boundaryCompactionPriority(right.message) ||
        left.index - right.index
    );

  for (const candidate of candidates) {
    if (bodyBytes <= maxBodyBytes) break;
    const currentMessage = workingMessages[candidate.index];
    const currentChars = compactableTextChars(currentMessage.content);
    if (currentChars <= 0) continue;

    const buildCandidate = (budgetChars) => {
      const compacted = compactToolContent(currentMessage.content, budgetChars);
      if (!compacted.changed) return null;
      const messages = [...workingMessages];
      messages[candidate.index] = { ...currentMessage, content: compacted.content };
      const nextBody = { ...workingBody, messages };
      return { body: nextBody, bodyBytes: jsonBytes(nextBody), messages };
    };

    const smallest = buildCandidate(minimumChars);
    if (!smallest) continue;
    let selected = smallest;
    if (smallest.bodyBytes <= maxBodyBytes) {
      let low = minimumChars + 1;
      let high = currentChars - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const attempt = buildCandidate(middle);
        if (attempt && attempt.bodyBytes <= maxBodyBytes) {
          selected = attempt;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
    }

    workingBody = selected.body;
    workingMessages = selected.messages;
    bodyBytes = selected.bodyBytes;
    if (isToolResponseMessage(currentMessage)) foldedToolOutputs += 1;
    else foldedMessages += 1;
  }

  if (bodyBytes > maxBodyBytes) {
    return {
      body,
      bodyBytes: jsonBytes(body),
      changed: false,
      foldedMessages: 0,
      foldedToolOutputs: 0,
    };
  }

  return {
    body: workingBody,
    bodyBytes,
    changed: workingBody !== body,
    foldedMessages,
    foldedToolOutputs,
  };
}

function protectedMessageBytes(messages) {
  return messages
    .filter((message) => message && ['system', 'developer'].includes(message.role))
    .reduce((sum, message) => sum + jsonBytes(message), 0);
}

function compactOversizedMessages(
  messages,
  maxChars = DEFAULT_WBIPC_RETRY_TOOL_CHARS,
  maxProtectedChars = DEFAULT_WBIPC_RETRY_PROTECTED_MESSAGE_CHARS,
  options = {}
) {
  let foldedToolOutputs = 0;
  let foldedMessages = 0;
  const foldedProtectedMessages = 0;
  const compacted = messages.map((message) => {
    if (options.protectedMessages?.has(message)) return message;
    if (!message) return message;
    const isProtected =
      ['system', 'developer'].includes(message.role) ||
      (message.role === 'user' &&
        (!Array.isArray(message.content) ||
          !message.content.every(
            (part) => part && (part.type === 'tool_result' || part.functionResponse)
          ))) ||
      isCheckpointMessage(message) ||
      contentContainsMarker(message.content, EVIDENCE_RECEIPT_MARKER);
    if (isProtected) return message;
    const result = compactToolContent(message.content, isProtected ? maxProtectedChars : maxChars);
    if (!result.changed) return message;
    if (isToolResponseMessage(message)) foldedToolOutputs += 1;
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
  maxProtectedChars = DEFAULT_WBIPC_RETRY_PROTECTED_MESSAGE_CHARS,
  options = {}
) {
  if (!chatBody || typeof chatBody !== 'object' || !Array.isArray(chatBody.messages)) {
    return { changed: false, body: chatBody, bodyBytes: jsonBytes(chatBody) };
  }
  const safeMaxBytes = Math.max(1024, Math.trunc(Number(maxBodyBytes) || 0));
  const originalBytes = jsonBytes(chatBody);
  if (originalBytes <= safeMaxBytes) {
    return { changed: false, body: chatBody, bodyBytes: originalBytes };
  }

  const compactedTools =
    options.preserveToolSchemas === true
      ? {
          tools: chatBody.tools,
          changed: false,
          originalBytes: chatBody.tools === undefined ? 0 : jsonBytes(chatBody.tools),
          bodyBytes: chatBody.tools === undefined ? 0 : jsonBytes(chatBody.tools),
        }
      : compactWorkBuddyTools(chatBody.tools);
  const schemaBody = compactedTools.changed
    ? { ...chatBody, tools: compactedTools.tools }
    : chatBody;
  const originalProtectedMessageBytes = protectedMessageBytes(schemaBody.messages);
  const adaptive = options && options.adaptive === true;
  let toolChars = Math.max(256, Math.floor(Number(maxToolChars) || 0));
  let protectedChars = Math.max(1024, Math.floor(Number(maxProtectedChars) || 0));
  let folded;
  let pruned;
  let body;
  let bodyBytes;
  let compactionPasses = 0;
  const maxPasses = adaptive ? 7 : 1;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    compactionPasses = pass + 1;
    folded = compactOversizedMessages(schemaBody.messages, toolChars, protectedChars, options);
    const foldedBody = { ...schemaBody, messages: folded.messages };
    const classification = classifyContextMessages(foldedBody.messages, {
      keepRecentUserTurns: options.keepRecentUserTurns ?? 1,
    });
    const protectedWorkingSet = new Set(
      classification.items
        .filter((item) => item.contextClass === CONTEXT_CLASSES.RECENT_WORKING_SET)
        .map((item) => item.message)
    );
    const bodyWithoutMessages = { ...foldedBody, messages: [] };
    const fixedBytes = jsonBytes(bodyWithoutMessages);
    // `fixedBytes` already contains the two bytes for `messages: []`. Replacing
    // that empty array costs one comma per retained message after the first.
    // Charge every message one separator byte and add one byte back so the
    // aggregate exactly models the serialized array without an off-by-(n-1).
    const messageBudgetBytes = Math.max(0, safeMaxBytes - fixedBytes + 1);
    pruned = pruneMessagesToTokenBudget(
      foldedBody.messages,
      messageBudgetBytes,
      (message) => jsonBytes(message) + 1,
      {
        isProtectedMessage: (message) =>
          options.protectedMessages?.has(message) ||
          options.allowHistoryEviction === false ||
          protectedWorkingSet.has(message) ||
          (options.preserveUserMessages === true && message?.role === 'user'),
      }
    );
    body = { ...foldedBody, messages: pruned.messages };
    bodyBytes = jsonBytes(body);
    if (bodyBytes <= safeMaxBytes || !adaptive) break;
    const nextToolChars = Math.max(1024, Math.floor(toolChars / 2));
    const nextProtectedChars = protectedChars;
    if (nextToolChars === toolChars) break;
    toolChars = nextToolChars;
    protectedChars = nextProtectedChars;
  }
  const structuralOverflowBytes = Math.max(0, body.messages.length - 1);
  // A long tool loop can retain dozens of messages in the recent user window.
  // Even the final 1024-character per-message cap can then exceed the learned
  // aggregate capacity. Fit the actual serialized bytes, oldest evidence first,
  // without deleting calls/results or emptying their content. Keep user input,
  // trusted policy, checkpoints and artifact receipts intact in this last step.
  const needsByteBudgetCompaction = adaptive && bodyBytes > safeMaxBytes;
  const boundaryCompaction =
    needsByteBudgetCompaction ||
    (bodyBytes > safeMaxBytes && bodyBytes - safeMaxBytes <= structuralOverflowBytes)
      ? compactBodyToByteLimit(
          body,
          safeMaxBytes,
          needsByteBudgetCompaction
            ? {
                minimumChars: 256,
                preserveUsers: true,
                protectedMessages: options.protectedMessages,
              }
            : { preserveUsers: true, protectedMessages: options.protectedMessages }
        )
      : {
          body,
          bodyBytes,
          changed: false,
          foldedMessages: 0,
          foldedToolOutputs: 0,
        };
  body = boundaryCompaction.body;
  bodyBytes = boundaryCompaction.bodyBytes;
  return {
    changed:
      (compactedTools.changed ||
        folded.foldedMessages > 0 ||
        folded.foldedProtectedMessages > 0 ||
        folded.foldedToolOutputs > 0 ||
        pruned.droppedCount > 0 ||
        boundaryCompaction.changed) &&
      bodyBytes < originalBytes,
    body,
    bodyBytes,
    originalBytes,
    droppedCount: pruned.droppedCount,
    foldedMessages: folded.foldedMessages + boundaryCompaction.foldedMessages,
    foldedProtectedMessages: folded.foldedProtectedMessages,
    foldedToolOutputs: folded.foldedToolOutputs + boundaryCompaction.foldedToolOutputs,
    originalProtectedMessageBytes,
    retryProtectedMessageBytes: protectedMessageBytes(body.messages),
    compactionPasses,
    finalMessageChars: toolChars,
    finalProtectedMessageChars: protectedChars,
    boundaryCompactionApplied: boundaryCompaction.changed,
    byteBudgetCompactionApplied: needsByteBudgetCompaction && boundaryCompaction.changed,
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
