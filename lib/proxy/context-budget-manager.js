'use strict';

const { optimizeContextMessages } = require('./context-optimizer');
const { createContextCachePlan } = require('./context-cache-planner');
const { createMessageTokenEstimator } = require('./context-message-estimator');
const { estimateTokensForValue } = require('./inline-media');
const { preservesResponsesHistory, responsesTruncation } = require('./responses-history-policy');

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
const DEFAULT_OUTPUT_RESERVE_TOKENS = 8192;
const DEFAULT_TOOL_RESERVE_TOKENS = 4096;
const DEFAULT_REASONING_RESERVE_TOKENS = 8192;
const DEFAULT_SAFETY_MARGIN_TOKENS = 4096;
const DEFAULT_COMPACTION_MIN_SAVINGS_TOKENS = 2048;
const DEFAULT_COMPACTION_TARGET_RATIO = 0.9;
const MIN_EFFECTIVE_INPUT_TOKENS = 4096;

const CONTEXT_OVERFLOW_MESSAGE =
  'The latest tool exchange and fixed instructions exceed the estimated input budget. Shorten the input, tool definitions, or requested output limit.';

function positiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

function boundedRatio(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0.5 && numeric <= 1 ? numeric : fallback;
}

function inferModelContextWindow(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('gemini-3.8') || normalized.includes('gemini-3.7')) {
    return 1000000;
  }
  if (normalized.includes('gemini')) {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  return 0;
}

function requestedOutputTokens(body) {
  if (!body || typeof body !== 'object') return 0;
  return (
    positiveInteger(body.max_tokens) ||
    positiveInteger(body.max_output_tokens) ||
    positiveInteger(body.max_completion_tokens)
  );
}

function hasDeclaredTools(body) {
  return !!(body && Array.isArray(body.tools) && body.tools.length > 0);
}

function messageContentBlocks(message) {
  if (!message || typeof message !== 'object') return [];
  return Array.isArray(message.content) ? message.content : [];
}

function claudeToolUseIds(message) {
  return messageContentBlocks(message)
    .filter((block) => block && block.type === 'tool_use' && typeof block.id === 'string')
    .map((block) => block.id);
}

function claudeToolResultIds(message) {
  return messageContentBlocks(message)
    .filter(
      (block) => block && block.type === 'tool_result' && typeof block.tool_use_id === 'string'
    )
    .map((block) => block.tool_use_id);
}

function hasToolCall(message) {
  if (!message || typeof message !== 'object') return false;
  if (claudeToolUseIds(message).length > 0) return true;
  if (
    Array.isArray(message.tool_calls) &&
    message.tool_calls.some((call) => call && typeof call === 'object')
  ) {
    return true;
  }
  return !!(
    message.role === 'assistant' &&
    message.function_call &&
    typeof message.function_call === 'object'
  );
}

function canPrecedeToolCall(message) {
  return !!(
    message &&
    typeof message === 'object' &&
    ['user', 'tool', 'function'].includes(message.role)
  );
}

function isAdjacentLegacyFunctionResult(message, previous) {
  if (!message || !previous || message.role !== 'function') return false;
  if (!previous.function_call || typeof previous.function_call !== 'object') return false;
  const callName =
    typeof previous.function_call.name === 'string' ? previous.function_call.name : '';
  const resultName = typeof message.name === 'string' ? message.name : '';
  return !callName || !resultName || callName === resultName;
}

// Keep the user/function-response predecessor, every call, and all results in one
// indivisible interval. Recursively merging adjacent intervals preserves an entire
// chained tool turn, including parallel results and both Chat and Claude shapes.
function messageGroups(messages) {
  const calls = new Map();
  const starts = messages.map((message, index) => {
    let start = index;
    const results = [...claudeToolResultIds(message)];
    if (Array.isArray(message?.tool_result_ids)) results.push(...message.tool_result_ids);
    if (message && typeof message.tool_call_id === 'string') results.push(message.tool_call_id);
    for (const id of results) if (calls.has(id)) start = Math.min(start, calls.get(id));
    if (index > 0 && isAdjacentLegacyFunctionResult(message, messages[index - 1])) {
      start = Math.min(start, index - 1);
    }
    const ids = [...claudeToolUseIds(message)];
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      if (call && typeof call.id === 'string') ids.push(call.id);
    }
    if (index > 0 && hasToolCall(message) && canPrecedeToolCall(messages[index - 1])) {
      start = Math.min(start, index - 1);
    }
    for (const id of ids) calls.set(id, index);
    return start;
  });
  const groups = [];
  for (let end = messages.length - 1; end >= 0; ) {
    let start = starts[end];
    for (let i = end; i >= start; i -= 1) start = Math.min(start, starts[i]);
    groups.push(messages.slice(start, end + 1));
    end = start - 1;
  }
  return groups;
}

function reserveTokens(body, options = {}) {
  const outputReserve =
    positiveInteger(options.outputReserveTokens) ||
    requestedOutputTokens(body) ||
    DEFAULT_OUTPUT_RESERVE_TOKENS;
  const toolReserve = hasDeclaredTools(body)
    ? positiveInteger(options.toolReserveTokens) || DEFAULT_TOOL_RESERVE_TOKENS
    : 0;
  const reasoningReserve =
    body && body.reasoning_effort
      ? positiveInteger(options.reasoningReserveTokens) || DEFAULT_REASONING_RESERVE_TOKENS
      : 0;
  const safetyMargin = positiveInteger(options.safetyMarginTokens) || DEFAULT_SAFETY_MARGIN_TOKENS;
  return outputReserve + toolReserve + reasoningReserve + safetyMargin;
}

function resolveContextBudget(body, model, protocolOptions = {}) {
  const policy = responsesTruncation(body)
    ? 'overflow-drop-oldest'
    : String(protocolOptions.contextWindowPolicy || 'overflow-drop-oldest');
  if (policy === 'disabled' || policy === 'none') {
    return {
      enabled: false,
      policy,
      source: 'disabled',
      inputBudgetTokens: 0,
      reservedTokens: 0,
      contextWindowTokens: 0,
    };
  }

  const configuredWindow = positiveInteger(protocolOptions.maxContextTokens);
  const clientWindow = positiveInteger(protocolOptions.clientContextTokens);
  const inferredWindow = inferModelContextWindow(model);
  const modelWindow = configuredWindow || inferredWindow;
  const contextWindowTokens =
    modelWindow && clientWindow ? Math.min(modelWindow, clientWindow) : modelWindow || clientWindow;
  if (!contextWindowTokens) {
    return {
      enabled: false,
      policy,
      source: 'unknown',
      inputBudgetTokens: 0,
      reservedTokens: 0,
      contextWindowTokens: 0,
    };
  }

  const reservedTokens = reserveTokens(body, protocolOptions);
  const inputBudgetTokens = Math.max(0, contextWindowTokens - reservedTokens);

  return {
    enabled: policy === 'overflow-drop-oldest',
    policy,
    source: configuredWindow
      ? clientWindow && clientWindow < configuredWindow
        ? 'configured-client-min'
        : 'configured'
      : clientWindow && (!inferredWindow || clientWindow < inferredWindow)
        ? 'client-default'
        : 'model-default',
    inputBudgetTokens,
    reservedTokens,
    contextWindowTokens,
    clientContextTokens: clientWindow || 0,
    modelContextTokens: modelWindow || 0,
  };
}

function pruneMessagesToTokenBudget(
  messages,
  inputBudgetTokens,
  estimateMessageTokens,
  options = {}
) {
  if (!Array.isArray(messages) || !Number.isFinite(inputBudgetTokens) || inputBudgetTokens < 0) {
    return {
      messages,
      droppedMessages: [],
      droppedCount: 0,
      estimatedInputTokens: estimateTokensForValue(messages),
    };
  }
  const estimate =
    typeof estimateMessageTokens === 'function' ? estimateMessageTokens : estimateTokensForValue;
  const isProtectedMessage =
    typeof options.isProtectedMessage === 'function' ? options.isProtectedMessage : () => false;
  const groups = messageGroups(messages).map((messages) => {
    const policyProtected = messages.some(
      (message) => message && ['system', 'developer'].includes(message.role)
    );
    const workingSetProtected = messages.some((message) => isProtectedMessage(message));
    return {
      messages,
      tokens: messages.reduce((sum, message) => sum + estimate(message), 0),
      protected: policyProtected || workingSetProtected,
      workingSetProtected,
    };
  });
  let currentTokens = groups
    .filter((group) => group.protected)
    .reduce((sum, group) => sum + group.tokens, 0);
  let droppedCount = 0;
  let keptLatest = false;
  let dropping = false;
  const retained = [];
  const droppedGroups = [];
  for (const group of groups) {
    if (group.protected) {
      retained.push(group.messages);
      if (group.workingSetProtected) keptLatest = true;
      continue;
    }
    if (keptLatest && (dropping || currentTokens + group.tokens > inputBudgetTokens)) {
      dropping = true;
      droppedCount += group.messages.length;
      droppedGroups.unshift(group.messages);
      continue;
    }
    keptLatest = true;
    retained.push(group.messages);
    currentTokens += group.tokens;
  }
  return {
    messages: retained.reverse().flat(),
    droppedMessages: droppedGroups.flat(),
    droppedCount,
    estimatedInputTokens: currentTokens,
  };
}

function applyContextBudgetToMessages(messages, body, model, protocolOptions = {}, options = {}) {
  const budget = resolveContextBudget(body, model, protocolOptions);
  const rawEstimate = options.estimateMessageTokens || estimateTokensForValue;
  const estimate = createMessageTokenEstimator(rawEstimate);
  if (!budget.enabled || !Array.isArray(messages)) {
    const fixedInputTokens = Math.max(0, Number(options.fixedInputTokens) || 0);
    // Default estimates are additive. Reuse this pass for cache diagnostics;
    // custom estimators retain the existing independent aggregate calculation.
    const estimatedInputTokens = !Array.isArray(messages)
      ? 0
      : rawEstimate === estimateTokensForValue && options.includeCacheDiagnostics !== false
        ? messages.reduce((sum, message) => sum + estimate(message), 0)
        : estimateTokensForValue(messages);
    return {
      messages,
      diagnostics: {
        ...budget,
        estimatedInputTokens,
        optimizedCount: 0,
        droppedCount: 0,
        savedChars: 0,
        contextCache:
          options.includeCacheDiagnostics === false
            ? undefined
            : createContextCachePlan(messages, {
                estimateMessageTokens: estimate,
                fixedPrefixTokens: fixedInputTokens,
                fixedPrefixValue: options.fixedInputValue,
                cacheCandidateMinTokens: protocolOptions.contextCacheCandidateMinTokens,
              }),
      },
    };
  }

  const fixedInputTokens = Math.max(0, Number(options.fixedInputTokens) || 0);
  const estimatedBeforeTokens = messages.reduce(
    (sum, message) => sum + estimate(message),
    fixedInputTokens
  );
  const cachePlanOptions = {
    estimateMessageTokens: estimate,
    fixedPrefixTokens: fixedInputTokens,
    fixedPrefixValue: options.fixedInputValue,
    cacheCandidateMinTokens: protocolOptions.contextCacheCandidateMinTokens,
  };
  const initialContextCache =
    options.includeCacheDiagnostics === false
      ? undefined
      : createContextCachePlan(messages, cachePlanOptions);
  if (options.deferPlanning === true) {
    // A trusted transactional planner will perform admission later. Measure the
    // same ceiling here without destructively folding evidence before archival.
    return {
      messages,
      diagnostics: {
        ...budget,
        planningDeferred: true,
        estimatedBeforeTokens,
        estimatedInputTokens: estimatedBeforeTokens,
        fixedInputTokens,
        overBudgetTokens: Math.max(0, estimatedBeforeTokens - budget.inputBudgetTokens),
        optimizedCount: 0,
        droppedCount: 0,
        savedChars: 0,
        contextCache: initialContextCache,
      },
    };
  }
  if (preservesResponsesHistory(body)) {
    return {
      messages,
      diagnostics: {
        ...budget,
        policy: 'responses-truncation-disabled',
        estimatedBeforeTokens,
        estimatedInputTokens: estimatedBeforeTokens,
        fixedInputTokens,
        overBudgetTokens: Math.max(0, estimatedBeforeTokens - budget.inputBudgetTokens),
        optimizedCount: 0,
        droppedCount: 0,
        savedChars: 0,
        contextCache: initialContextCache,
      },
    };
  }
  const overBudgetBeforeTokens = Math.max(0, estimatedBeforeTokens - budget.inputBudgetTokens);
  if (overBudgetBeforeTokens === 0) {
    return {
      messages,
      diagnostics: {
        ...budget,
        estimatedBeforeTokens,
        estimatedInputTokens: estimatedBeforeTokens,
        fixedInputTokens,
        overBudgetTokens: 0,
        optimizedCount: 0,
        droppedCount: 0,
        savedChars: 0,
        compactionTriggered: false,
        compactionApplied: false,
        contextCache: initialContextCache,
      },
    };
  }
  const minimumSavingsTokens =
    positiveInteger(protocolOptions.contextCompactionMinSavingsTokens) ||
    DEFAULT_COMPACTION_MIN_SAVINGS_TOKENS;
  const targetRatio = boundedRatio(
    protocolOptions.contextCompactionTargetRatio,
    DEFAULT_COMPACTION_TARGET_RATIO
  );
  // Use high/low-water hysteresis: once overflow triggers cleanup, compact in
  // one batch far enough below the hard limit to avoid rewriting history on
  // every following turn. The minimum saving also prevents tiny cache-busting
  // rewrites when a larger safe batch can be removed.
  const compactionTargetTokens = Math.max(
    0,
    Math.min(
      budget.inputBudgetTokens,
      Math.floor(budget.inputBudgetTokens * targetRatio),
      estimatedBeforeTokens - minimumSavingsTokens
    )
  );
  const optimized = optimizeContextMessages(messages, {
    keepRecentTurns: positiveInteger(protocolOptions.contextKeepRecentTurns) || 2,
    maxHistoricalToolChars: positiveInteger(protocolOptions.maxHistoricalToolChars) || 800,
    maxHistoricalMessageChars: positiveInteger(protocolOptions.maxHistoricalMessageChars) || 4000,
    foldHistoricalMessages: estimatedBeforeTokens > budget.inputBudgetTokens,
  });
  const pruned = pruneMessagesToTokenBudget(
    optimized.messages,
    Math.max(0, compactionTargetTokens - fixedInputTokens),
    estimate
  );
  const estimatedInputTokens = pruned.estimatedInputTokens + fixedInputTokens;
  const finalContextCache =
    options.includeCacheDiagnostics === false
      ? undefined
      : createContextCachePlan(pruned.messages, cachePlanOptions);
  const stablePrefixPreserved =
    !initialContextCache ||
    !finalContextCache ||
    initialContextCache.stablePrefixHash === finalContextCache.stablePrefixHash;

  return {
    messages: pruned.messages,
    diagnostics: {
      ...budget,
      estimatedBeforeTokens,
      estimatedInputTokens,
      fixedInputTokens,
      overBudgetTokens: Math.max(0, estimatedInputTokens - budget.inputBudgetTokens),
      optimizedCount: optimized.prunedCount,
      droppedCount: pruned.droppedCount,
      savedChars: optimized.savedChars,
      compactionTriggered: true,
      compactionApplied: optimized.prunedCount > 0 || pruned.droppedCount > 0,
      compactionTargetTokens,
      compactionTargetRatio: targetRatio,
      minimumSavingsTokens,
      batchSavingsTokens: Math.max(0, estimatedBeforeTokens - estimatedInputTokens),
      stablePrefixPreserved,
      contextCache: finalContextCache,
    },
  };
}

function rejectContextOverflow(clientRes, body, sendJsonError) {
  const budget = body && body.__hpmDiagnostics && body.__hpmDiagnostics.contextBudget;
  if (!budget || !budget.enabled || !(budget.overBudgetTokens > 0)) return false;
  sendJsonError(clientRes, 400, {
    error: {
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message: CONTEXT_OVERFLOW_MESSAGE,
    },
  });
  return true;
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  DEFAULT_TOOL_RESERVE_TOKENS,
  DEFAULT_REASONING_RESERVE_TOKENS,
  DEFAULT_SAFETY_MARGIN_TOKENS,
  DEFAULT_COMPACTION_MIN_SAVINGS_TOKENS,
  DEFAULT_COMPACTION_TARGET_RATIO,
  MIN_EFFECTIVE_INPUT_TOKENS,
  CONTEXT_OVERFLOW_MESSAGE,
  applyContextBudgetToMessages,
  claudeToolResultIds,
  claudeToolUseIds,
  inferModelContextWindow,
  pruneMessagesToTokenBudget,
  requestedOutputTokens,
  rejectContextOverflow,
  reserveTokens,
  resolveContextBudget,
};
