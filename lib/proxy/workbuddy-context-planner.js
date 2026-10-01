'use strict';

const { estimateTokensForValue } = require('./inline-media');
const { isToolResponseMessage } = require('./context-optimizer');
const { compactWorkBuddyTools, compactWorkBuddyWbipcBody } = require('./workbuddy-wbipc-payload');
const {
  buildHistoricalContinuation,
  compactProtectedMessages,
} = require('./workbuddy-context-summary');

const DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS = 96 * 1024;
const DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES = 680 * 1024;
const DEFAULT_WORKBUDDY_TARGET_BODY_BYTES = 384 * 1024;
const DEFAULT_WORKBUDDY_MAX_SELECTED_TOOLS = 24;
const DEFAULT_WORKBUDDY_ALWAYS_ON_TOOLS = 5;
const DEFAULT_RECENT_TOOL_REFERENCE_MESSAGES = 12;
const MAX_QUERY_TEXT_CHARS = 16 * 1024;
const MAX_SEARCH_TEXT_CHARS = 8 * 1024;
const CORE_TOOL_RE =
  /(?:^|[_-])(read|search|find|write|edit|patch|exec|shell|browser|computer|view)(?:[_-]|$)/i;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function jsonBytes(value) {
  const serialized = JSON.stringify(value);
  return typeof serialized === 'string' ? Buffer.byteLength(serialized) : 0;
}

function toolDefinition(tool) {
  if (!tool || typeof tool !== 'object') return null;
  return tool.function && typeof tool.function === 'object' ? tool.function : tool;
}

function toolName(tool) {
  const definition = toolDefinition(tool);
  return definition && typeof definition.name === 'string' ? definition.name : '';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'tool_result') return contentText(part.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function latestTaskText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user' || isToolResponseMessage(message)) continue;
    return contentText(message.content).slice(0, MAX_QUERY_TEXT_CHARS);
  }
  return '';
}

function queryTerms(value) {
  const normalized = String(value || '').toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,8}/g) || []);
  for (const sequence of normalized.match(/[\u3400-\u9fff]{3,}/g) || []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.add(sequence.slice(index, index + 2));
      if (terms.size >= 128) break;
    }
  }
  return [...terms].slice(0, 128);
}

function collectReferencedToolNames(
  messages,
  maxRecentMessages = DEFAULT_RECENT_TOOL_REFERENCE_MESSAGES
) {
  const names = new Set();
  if (!Array.isArray(messages)) return names;
  const recentCount = positiveInteger(maxRecentMessages, DEFAULT_RECENT_TOOL_REFERENCE_MESSAGES);
  for (const message of messages.slice(-recentCount)) {
    if (!message || typeof message !== 'object') continue;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = call && call.function && call.function.name;
      if (typeof name === 'string' && name) names.add(name);
    }
    const legacyName = message.function_call && message.function_call.name;
    if (typeof legacyName === 'string' && legacyName) names.add(legacyName);
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part && part.type === 'tool_use' && typeof part.name === 'string' && part.name) {
        names.add(part.name);
      }
    }
  }
  return names;
}

function schemaSearchText(value, output = [], depth = 0) {
  if (output.join(' ').length >= MAX_SEARCH_TEXT_CHARS || depth > 10) return output;
  if (Array.isArray(value)) {
    for (const item of value) schemaSearchText(item, output, depth + 1);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value)) {
    output.push(key);
    if (typeof item === 'string' && ['name', 'description', 'title'].includes(key)) {
      output.push(item.slice(0, 1024));
    } else {
      schemaSearchText(item, output, depth + 1);
    }
    if (output.join(' ').length >= MAX_SEARCH_TEXT_CHARS) break;
  }
  return output;
}

function rankTool(tool, index, terms, referencedNames) {
  const name = toolName(tool);
  const normalizedName = name.toLowerCase();
  const searchable = schemaSearchText(toolDefinition(tool)).join(' ').toLowerCase();
  let score = referencedNames.has(name) ? 100000 : 0;
  if (CORE_TOOL_RE.test(normalizedName)) score += 100;
  for (const term of terms) {
    if (normalizedName === term) score += 500;
    else if (normalizedName.includes(term)) score += 80;
    if (searchable.includes(term)) score += 10;
  }
  return { index, name, score, tool };
}

function selectWorkBuddyTools(tools, messages, options = {}) {
  if (!Array.isArray(tools)) {
    return { tools, changed: false, originalCount: 0, selectedCount: 0 };
  }
  const maxSelectedTools = positiveInteger(
    options.maxSelectedTools,
    DEFAULT_WORKBUDDY_MAX_SELECTED_TOOLS
  );
  if (tools.length <= maxSelectedTools) {
    return {
      tools,
      changed: false,
      originalCount: tools.length,
      selectedCount: tools.length,
    };
  }

  const alwaysOnTools = Math.min(
    maxSelectedTools,
    positiveInteger(options.alwaysOnTools, DEFAULT_WORKBUDDY_ALWAYS_ON_TOOLS)
  );
  const terms = queryTerms(latestTaskText(messages));
  const referencedNames = collectReferencedToolNames(messages);
  const ranked = tools
    .map((tool, index) => rankTool(tool, index, terms, referencedNames))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selectedIndexes = new Set();
  for (let index = 0; index < Math.min(alwaysOnTools, tools.length); index += 1) {
    selectedIndexes.add(index);
  }
  for (const entry of ranked) {
    if (selectedIndexes.size >= maxSelectedTools) break;
    selectedIndexes.add(entry.index);
  }
  const selected = tools.filter((_tool, index) => selectedIndexes.has(index));
  return {
    tools: selected,
    changed: selected.length < tools.length,
    originalCount: tools.length,
    selectedCount: selected.length,
  };
}

function planWorkBuddyWbipcRequest(chatBody, options = {}) {
  if (!chatBody || typeof chatBody !== 'object' || !Array.isArray(chatBody.messages)) {
    return {
      body: chatBody,
      changed: false,
      fits: false,
      diagnostics: { reason: 'invalid_body' },
    };
  }
  const operationalInputTokens = positiveInteger(
    options.operationalInputTokens,
    DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS
  );
  const preflightBodyBytes = positiveInteger(
    options.preflightBodyBytes,
    DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES
  );
  const targetBodyBytes = positiveInteger(
    options.targetBodyBytes,
    DEFAULT_WORKBUDDY_TARGET_BODY_BYTES
  );
  const originalBodyBytes = jsonBytes(chatBody);
  const originalEstimatedTokens = estimateTokensForValue(chatBody);
  const preflightApplied =
    options.force === true ||
    originalBodyBytes > preflightBodyBytes ||
    originalEstimatedTokens > operationalInputTokens;
  if (!preflightApplied) {
    return {
      body: chatBody,
      changed: false,
      fits: true,
      diagnostics: {
        preflightApplied: false,
        originalBodyBytes,
        finalBodyBytes: originalBodyBytes,
        originalEstimatedTokens,
        finalEstimatedTokens: originalEstimatedTokens,
        operationalInputTokens,
        originalToolCount: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0,
        selectedToolCount: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0,
      },
    };
  }

  const query = latestTaskText(chatBody.messages);
  const protectedContext = compactProtectedMessages(chatBody.messages, {
    maxTotalChars: options.maxProtectedMessageChars,
    query,
  });
  const sourceBody = protectedContext.changed
    ? { ...chatBody, messages: protectedContext.messages }
    : chatBody;
  const selected = selectWorkBuddyTools(sourceBody.tools, sourceBody.messages, options);
  const compactedTools = compactWorkBuddyTools(selected.tools);
  const withTools = {
    ...sourceBody,
    ...(Array.isArray(sourceBody.tools) ? { tools: compactedTools.tools } : {}),
  };
  let compacted = compactWorkBuddyWbipcBody(
    withTools,
    targetBodyBytes,
    options.maxMessageChars,
    options.maxProtectedMessageChars
  );
  let body = compacted.changed ? compacted.body : withTools;
  let continuationSummaryAdded = false;
  if (compacted.droppedCount > 0) {
    const continuation = buildHistoricalContinuation(chatBody.messages, options);
    if (continuation) {
      let insertionIndex = -1;
      for (let index = 0; index < body.messages.length; index += 1) {
        const message = body.messages[index];
        if (message && ['system', 'developer'].includes(message.role)) insertionIndex = index;
      }
      const messages = [...body.messages];
      messages.splice(insertionIndex + 1, 0, continuation);
      const withContinuation = { ...body, messages };
      const summarized = compactWorkBuddyWbipcBody(
        withContinuation,
        targetBodyBytes,
        options.maxMessageChars,
        options.maxProtectedMessageChars
      );
      if (summarized.fits) {
        body = summarized.body;
        compacted = {
          ...summarized,
          droppedCount: Math.max(compacted.droppedCount || 0, summarized.droppedCount || 0),
        };
        continuationSummaryAdded = true;
      }
    }
  }
  const finalBodyBytes = jsonBytes(body);
  const finalEstimatedTokens = estimateTokensForValue(body);
  const changed =
    protectedContext.changed || selected.changed || compactedTools.changed || compacted.changed;
  return {
    body,
    changed,
    fits: finalBodyBytes <= targetBodyBytes && finalEstimatedTokens <= operationalInputTokens,
    diagnostics: {
      preflightApplied: true,
      originalBodyBytes,
      finalBodyBytes,
      originalEstimatedTokens,
      finalEstimatedTokens,
      operationalInputTokens,
      originalToolCount: selected.originalCount,
      selectedToolCount: selected.selectedCount,
      originalToolsBytes: compactedTools.originalBytes,
      finalToolsBytes: compactedTools.bodyBytes,
      droppedMessages: compacted.droppedCount || 0,
      continuationSummaryAdded,
      foldedMessages: compacted.foldedMessages || 0,
      foldedProtectedMessages:
        protectedContext.foldedCount + (compacted.foldedProtectedMessages || 0),
      foldedToolOutputs: compacted.foldedToolOutputs || 0,
      originalProtectedMessageBytes: protectedContext.originalBytes,
      finalProtectedMessageBytes:
        compacted.retryProtectedMessageBytes || protectedContext.finalBytes,
    },
  };
}

module.exports = {
  DEFAULT_RECENT_TOOL_REFERENCE_MESSAGES,
  DEFAULT_WORKBUDDY_ALWAYS_ON_TOOLS,
  DEFAULT_WORKBUDDY_MAX_SELECTED_TOOLS,
  DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
  DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES,
  DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
  collectReferencedToolNames,
  planWorkBuddyWbipcRequest,
  selectWorkBuddyTools,
};
