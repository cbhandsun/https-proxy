'use strict';
const { usesNativeContextPlanning } = require('./context-recovery-policy');
const { planNativeWorkBuddyContext } = require('./workbuddy-native-context');

const { estimateTokensForValue } = require('./inline-media');
const { preservesResponsesHistory } = require('./responses-history-policy');
const { isToolResponseMessage } = require('./context-optimizer');
const { planContextWorkingSet } = require('./context-working-set-planner');
const { appendContextArtifactTool } = require('./context-artifact-tool');
const { resolveContextCapabilities, selectContextStrategy } = require('./context-capabilities');
const { compactWorkBuddyTools } = require('./workbuddy-wbipc-payload');
const { compactProtectedMessages } = require('./workbuddy-context-summary');
const { resolveContextGrowthBudget } = require('./context-growth-budget');
const { decideContextCleanup } = require('./context-cleanup-decision');
const { collectContextArtifactReferences } = require('./context-artifact-references');
const {
  isGeneratedTaskStateMessage,
  consolidateGeneratedTaskStates,
} = require('./context-task-state');
const { boundCompletedToolRounds } = require('./context-completed-rounds');
const { isLocalCompactionMessage } = require('./context-local-compaction-provenance');
const { measureWorkBuddyRequiredContext } = require('./workbuddy-required-context');
const {
  knownContextHistoryBodyBytes,
  captureContextHistorySnapshot,
  commitContextHistoryPlan,
} = require('./context-history-branch');

const {
  DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
  DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
} = require('./workbuddy-context-limits');
const DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES = 680 * 1024;
const DEFAULT_WORKBUDDY_MIN_CLEANUP_BYTES = 64 * 1024;
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
  const known = knownContextHistoryBodyBytes(value);
  if (known !== undefined) return known;
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
  // A negotiated catalog has already admitted the active set. Its exact
  // schemas and loaded names must not be silently reselected or rewritten.
  if (options.preserveToolSchemas === true)
    return { tools, changed: false, originalCount: tools.length, selectedCount: tools.length };
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
  const requiredIndex =
    typeof options.requiredToolName === 'string'
      ? tools.findIndex((tool) => toolName(tool) === options.requiredToolName)
      : -1;
  if (requiredIndex >= 0) selectedIndexes.add(requiredIndex);
  for (let index = 0; index < Math.min(alwaysOnTools, tools.length); index += 1) {
    if (selectedIndexes.size >= maxSelectedTools) break;
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

function buildWorkBuddyWbipcPlan(chatBody, options = {}, rootPins = new Set()) {
  if (!chatBody || typeof chatBody !== 'object' || !Array.isArray(chatBody.messages)) {
    return {
      body: chatBody,
      changed: false,
      fits: false,
      diagnostics: { reason: 'invalid_body' },
    };
  }
  const operationalInputTokens =
    options.operationalInputTokens === undefined
      ? DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS
      : options.operationalInputTokens;
  if (!Number.isSafeInteger(operationalInputTokens) || operationalInputTokens <= 0) {
    return {
      body: chatBody,
      changed: false,
      fits: false,
      diagnostics: { reason: 'invalid_token_budget' },
    };
  }
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
  const minimumCleanupBytes = positiveInteger(
    options.minimumCleanupBytes,
    DEFAULT_WORKBUDDY_MIN_CLEANUP_BYTES
  );
  // The learned/configured limit is a hard admission ceiling. Forecast growth
  // below it, but never impose the reserve as a new mandatory rejection limit.
  const growthBudget = resolveContextGrowthBudget(chatBody, targetBodyBytes, options);
  const cleanupTargetBodyBytes = growthBudget.planningBodyBytes;
  const preflightApplied =
    options.force === true ||
    originalBodyBytes > Math.min(preflightBodyBytes, growthBudget.triggerBodyBytes) ||
    originalEstimatedTokens > operationalInputTokens;
  const truncationDisabled = preservesResponsesHistory(chatBody);
  // Optional planning may be abandoned after measuring its net gain. A legacy
  // store without staged admission cannot safely reserve evidence for it.
  const stagingUnavailable =
    preflightApplied &&
    !truncationDisabled &&
    options.force !== true &&
    originalBodyBytes <= targetBodyBytes &&
    originalEstimatedTokens <= operationalInputTokens &&
    typeof options.artifactStore?.put === 'function' &&
    typeof options.artifactStore.beginTransaction !== 'function' &&
    !(
      typeof options.artifactStore.commit === 'function' &&
      typeof options.artifactStore.rollback === 'function'
    );
  if (!preflightApplied || truncationDisabled || stagingUnavailable) {
    return {
      body: chatBody,
      changed: false,
      fits:
        !preflightApplied ||
        (originalBodyBytes <= targetBodyBytes && originalEstimatedTokens <= operationalInputTokens),
      diagnostics: {
        preflightApplied,
        ...(stagingUnavailable
          ? {
              cleanupDecision: 'evidence_staging_unavailable',
              cleanupDeferred: true,
              cleanupRequired: false,
              cleanupSavedBytes: 0,
              minimumCleanupBytes,
              minimumCleanupSatisfied: false,
            }
          : {}),
        ...(truncationDisabled ? { truncationDisabled: true } : {}),
        originalBodyBytes,
        finalBodyBytes: originalBodyBytes,
        originalEstimatedTokens,
        finalEstimatedTokens: originalEstimatedTokens,
        operationalInputTokens,
        originalToolCount: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0,
        selectedToolCount: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0,
        ...growthBudget,
      },
    };
  }

  const capabilities = resolveContextCapabilities('workbuddy');
  const contextStrategy = selectContextStrategy(capabilities);
  const protectedContext = compactProtectedMessages(chatBody.messages);
  const requiredContext = measureWorkBuddyRequiredContext(chatBody.messages);
  if (
    requiredContext.requiredContextMeasured &&
    (requiredContext.requiredContextMessageBytes > targetBodyBytes ||
      requiredContext.requiredContextEstimatedTokens > operationalInputTokens)
  ) {
    // Even removing every tool, checkpoint, control and assistant message would
    // not fit. Avoid expensive repeated evidence planning and model summaries;
    // returning the untouched source grants no new authority to change policy.
    return {
      body: chatBody,
      changed: false,
      fits: false,
      diagnostics: {
        preflightApplied: true,
        contextStrategy,
        reason:
          protectedContext.finalBytes >= targetBodyBytes
            ? 'immutable_context_too_large'
            : 'required_context_too_large',
        originalBodyBytes,
        finalBodyBytes: originalBodyBytes,
        originalEstimatedTokens,
        finalEstimatedTokens: originalEstimatedTokens,
        operationalInputTokens,
        ...requiredContext,
        ...growthBudget,
        cleanupTargetBodyBytes,
        minimumCleanupBytes,
        cleanupSavedBytes: 0,
        remainingBodyBytes: 0,
        growthReserveSatisfied: false,
        originalToolCount: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0,
        selectedToolCount: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0,
        originalToolsBytes: jsonBytes(chatBody.tools),
        finalToolsBytes: jsonBytes(chatBody.tools),
        workingSetPlanningSkipped: true,
        workingSetAttempts: 0,
        droppedMessages: 0,
        evictedToolRounds: 0,
        continuationSummaryAdded: false,
        checkpointStatus: 'not_needed',
        checkpointValid: false,
        stablePrefixPreserved: true,
        foldedMessages: 0,
        foldedProtectedMessages: 0,
        foldedToolOutputs: 0,
        compactionPasses: 0,
        byteBudgetCompactionApplied: false,
        artifactsStored: 0,
        artifactsReferenced: 0,
        originalProtectedMessageBytes: protectedContext.originalBytes,
        finalProtectedMessageBytes: protectedContext.finalBytes,
      },
    };
  }
  let rootMessages = protectedContext.messages;
  if (rootMessages.filter(isGeneratedTaskStateMessage).length >= 2) {
    const unsafe = boundCompletedToolRounds(chatBody.messages, {
      keepCompletedToolRounds: 0,
      allowEmptyCompletedRounds: true,
    }).protectedIntervals.sort((left, right) => left.start - right.start);
    const barriers = [];
    let cursor = 0,
      protectedEnd = -1;
    for (let index = 0; index < chatBody.messages.length; index++) {
      while (cursor < unsafe.length && unsafe[cursor].start <= index)
        protectedEnd = Math.max(protectedEnd, unsafe[cursor++].end);
      if (index <= protectedEnd || isLocalCompactionMessage(chatBody.messages[index]))
        barriers.push(index);
    }
    rootMessages = consolidateGeneratedTaskStates(
      rootMessages,
      options.artifactOwner,
      options.artifactScope,
      rootPins,
      barriers
    );
  }
  const rootsChanged = rootMessages !== protectedContext.messages;
  const sourceBody =
    protectedContext.changed || rootsChanged ? { ...chatBody, messages: rootMessages } : chatBody;
  const selected = selectWorkBuddyTools(sourceBody.tools, sourceBody.messages, {
    ...options,
    requiredToolName: sourceBody.tool_choice?.function?.name || sourceBody.tool_choice?.name,
  });
  const compactedTools =
    options.preserveToolSchemas === true
      ? {
          tools: selected.tools,
          changed: false,
          originalBytes: jsonBytes(selected.tools),
          bodyBytes: jsonBytes(selected.tools),
        }
      : compactWorkBuddyTools(selected.tools);
  const artifactEnabled =
    options.artifactStore &&
    typeof options.artifactStore.put === 'function' &&
    typeof options.artifactOwner === 'string' &&
    options.artifactOwner.length > 0 &&
    typeof options.artifactScope === 'string' &&
    options.artifactScope.length > 0;
  const plannedTools = artifactEnabled
    ? appendContextArtifactTool(compactedTools.tools)
    : compactedTools.tools;
  const withTools = {
    ...sourceBody,
    ...(Array.isArray(sourceBody.tools) || artifactEnabled ? { tools: plannedTools } : {}),
  };
  const workingSetOptions = {
    ...options,
    protectedMessages: new Set([
      ...(options.protectedMessages instanceof Set ? options.protectedMessages : []),
      ...rootMessages.filter(isGeneratedTaskStateMessage),
    ]),
    operationalInputTokens,
    // The selected catalog is composed back into the final request below.
    // Admit against that exact catalog, not a second schema-description trim
    // whose smaller candidate would cease to fit when the catalog is restored.
    preserveToolSchemas: true,
    receiptCache: options.receiptCache instanceof WeakMap ? options.receiptCache : new WeakMap(),
  };
  let workingSet = planContextWorkingSet(withTools, cleanupTargetBodyBytes, workingSetOptions);
  let growthReserveReclaimed = false;
  // Headroom is a preference, not new authority to remove immutable user
  // requirements or locally reject a request that fits the real learned cap.
  // Replan from the original body, never from the lossy first candidate. Share
  // receipt admission so retrying cannot consume a second artifact quota.
  if (
    workingSet.checkpointFailed ||
    (Number.isSafeInteger(workingSet.bodyBytes)
      ? workingSet.bodyBytes
      : jsonBytes(workingSet.body)) > cleanupTargetBodyBytes
  ) {
    const admittedArtifacts = workingSet.eviction.diagnostics.artifactsStored || 0;
    workingSet = planContextWorkingSet(withTools, targetBodyBytes, workingSetOptions);
    workingSet.eviction.diagnostics.artifactsStored =
      admittedArtifacts + (workingSet.eviction.diagnostics.artifactsStored || 0);
    growthReserveReclaimed = true;
  }
  const { eviction, compacted } = workingSet;
  const activeTools =
    artifactEnabled &&
    (eviction.diagnostics.artifactsReferenced > 0 || options.preserveArtifactTool === true)
      ? plannedTools
      : compactedTools.tools;
  const bodyWithActiveTools = {
    ...workingSet.body,
    ...(Array.isArray(sourceBody.tools) || (Array.isArray(activeTools) && activeTools.length > 0)
      ? { tools: activeTools }
      : {}),
  };
  const body = bodyWithActiveTools;
  const continuationSummaryAdded = eviction.diagnostics.checkpointAdded === true;
  const sameToolsAsWorkingSet =
    (Array.isArray(sourceBody.tools) || (Array.isArray(activeTools) && activeTools.length > 0)) ===
      (Array.isArray(sourceBody.tools) || Boolean(artifactEnabled)) &&
    activeTools === plannedTools;
  const finalBodyBytes =
    sameToolsAsWorkingSet && Number.isSafeInteger(workingSet.bodyBytes)
      ? workingSet.bodyBytes
      : jsonBytes(body);
  const finalEstimatedTokens = estimateTokensForValue(body);
  const fits =
    !workingSet.checkpointFailed &&
    finalBodyBytes <= targetBodyBytes &&
    finalEstimatedTokens <= operationalInputTokens;
  const failureReason = workingSet.checkpointFailed
    ? eviction.diagnostics.reason || 'checkpoint_invalid'
    : fits
      ? undefined
      : protectedContext.finalBytes >= targetBodyBytes
        ? 'immutable_context_too_large'
        : 'working_set_too_large';
  const changed =
    rootsChanged ||
    protectedContext.changed ||
    selected.changed ||
    compactedTools.changed ||
    eviction.changed ||
    compacted.changed;
  return {
    body,
    changed,
    fits,
    diagnostics: {
      preflightApplied: true,
      contextStrategy,
      taskStateRootsConsolidated: rootsChanged,
      ...(failureReason ? { reason: failureReason } : {}),
      originalBodyBytes,
      finalBodyBytes,
      originalEstimatedTokens,
      finalEstimatedTokens,
      operationalInputTokens,
      ...requiredContext,
      cleanupTargetBodyBytes,
      ...growthBudget,
      growthReserveReclaimed,
      remainingBodyBytes: Math.max(0, targetBodyBytes - finalBodyBytes),
      growthReserveSatisfied: targetBodyBytes - finalBodyBytes >= growthBudget.growthReserveBytes,
      minimumCleanupBytes,
      cleanupSavedBytes: Math.max(0, originalBodyBytes - finalBodyBytes),
      minimumCleanupSatisfied:
        originalBodyBytes <= targetBodyBytes ||
        Math.max(0, originalBodyBytes - finalBodyBytes) >= minimumCleanupBytes,
      originalToolCount: selected.originalCount,
      selectedToolCount: selected.selectedCount,
      originalToolsBytes: compactedTools.originalBytes,
      finalToolsBytes: compactedTools.bodyBytes,
      droppedMessages: (eviction.diagnostics.evictedMessages || 0) + (compacted.droppedCount || 0),
      continuationSummaryAdded,
      checkpointStatus: eviction.diagnostics.checkpointStatus || 'not_needed',
      checkpointValid: eviction.diagnostics.checkpointValid === true,
      stablePrefixPreserved: eviction.diagnostics.stablePrefixPreserved !== false,
      foldedMessages: compacted.foldedMessages || 0,
      foldedProtectedMessages:
        protectedContext.foldedCount + (compacted.foldedProtectedMessages || 0),
      foldedToolOutputs:
        (eviction.diagnostics.foldedEvidence || 0) + (compacted.foldedToolOutputs || 0),
      immutableMessages: eviction.diagnostics.immutableMessages || 0,
      recentMessages: eviction.diagnostics.recentMessages || 0,
      durableMessages: eviction.diagnostics.durableMessages || 0,
      evictableMessages: eviction.diagnostics.evictableMessages || 0,
      unresolvedToolCalls: eviction.diagnostics.unresolvedToolCalls || 0,
      completedToolRounds: eviction.diagnostics.completedToolRounds || 0,
      evictedToolRounds: eviction.diagnostics.evictedToolRounds || 0,
      workingSetAttempts: eviction.diagnostics.workingSetAttempts || 0,
      retainedToolRoundLimit: eviction.diagnostics.retainedToolRoundLimit,
      artifactsStored: eviction.diagnostics.artifactsStored || 0,
      artifactsReferenced: eviction.diagnostics.artifactsReferenced || 0,
      compactionPasses: compacted.compactionPasses || 0,
      byteBudgetCompactionApplied: compacted.byteBudgetCompactionApplied === true,
      finalMessageChars: compacted.finalMessageChars || 0,
      finalProtectedMessageChars: compacted.finalProtectedMessageChars || 0,
      originalProtectedMessageBytes: protectedContext.originalBytes,
      finalProtectedMessageBytes:
        compacted.retryProtectedMessageBytes || protectedContext.finalBytes,
    },
  };
}

function selectCleanupPlan(original, plan, settings) {
  const diagnostics = plan.diagnostics;
  if (
    !diagnostics.preflightApplied ||
    diagnostics.truncationDisabled ||
    diagnostics.cleanupDeferred
  )
    return plan;
  const decision = decideContextCleanup({
    originalBodyBytes: diagnostics.originalBodyBytes,
    finalBodyBytes: diagnostics.finalBodyBytes,
    originalEstimatedTokens: diagnostics.originalEstimatedTokens,
    finalEstimatedTokens: diagnostics.finalEstimatedTokens,
    targetBodyBytes: diagnostics.hardBodyBytes,
    operationalInputTokens: diagnostics.operationalInputTokens,
    minimumCleanupBytes: diagnostics.minimumCleanupBytes,
    forced: settings.force === true,
    candidateFits: plan.fits === true,
  });
  const deferred = !decision.required && !decision.apply;
  return {
    ...plan,
    ...(deferred ? { body: original, changed: false, fits: true } : {}),
    diagnostics: {
      ...diagnostics,
      cleanupDecision: decision.reason,
      cleanupRequired: decision.required,
      cleanupDeferred: deferred,
      minimumCleanupSatisfied: decision.minimumCleanupSatisfied,
      ...(deferred
        ? {
            attemptedFinalBodyBytes: diagnostics.finalBodyBytes,
            attemptedFinalEstimatedTokens: diagnostics.finalEstimatedTokens,
            finalBodyBytes: diagnostics.originalBodyBytes,
            finalEstimatedTokens: diagnostics.originalEstimatedTokens,
            cleanupSavedBytes: 0,
            remainingBodyBytes: Math.max(
              0,
              diagnostics.hardBodyBytes - diagnostics.originalBodyBytes
            ),
            growthReserveSatisfied:
              diagnostics.hardBodyBytes - diagnostics.originalBodyBytes >=
              diagnostics.growthReserveBytes,
            droppedMessages: 0,
            evictedToolRounds: 0,
            continuationSummaryAdded: false,
            checkpointStatus: 'not_needed',
            checkpointValid: false,
            artifactsStored: 0,
            artifactsReferenced: 0,
            selectedToolCount: diagnostics.originalToolCount,
            finalToolsBytes: diagnostics.originalToolsBytes,
            foldedMessages: 0,
            foldedToolOutputs: 0,
            foldedProtectedMessages: 0,
            compactionPasses: 0,
            byteBudgetCompactionApplied: false,
          }
        : {}),
    },
  };
}

function planWorkBuddyWbipcRequest(chatBody, options = {}) {
  const supplied = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (usesNativeContextPlanning(supplied.contextPolicyOptions || {}))
    return planNativeWorkBuddyContext(chatBody, supplied, {
      targetBodyBytes: DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
      operationalInputTokens: DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
    });
  const generated = Array.isArray(chatBody?.messages)
    ? chatBody.messages.filter(
        (message) => isGeneratedTaskStateMessage(message) || isLocalCompactionMessage(message)
      )
    : [];
  // Locally validated structured state is indivisible throughout retry and
  // recovery. A marker string or changed object is not this capability. An
  // explicit semantic replacement may remove old state before calling us.
  const settings =
    generated.length > 0
      ? {
          ...supplied,
          protectedMessages: new Set([
            ...(supplied.protectedMessages instanceof Set ? supplied.protectedMessages : []),
            ...generated,
          ]),
        }
      : supplied;
  const store = settings.artifactStore;
  const history = settings.historyCommit === false ? null : settings.historyBranch;
  const snapshot = captureContextHistorySnapshot(
    history,
    chatBody,
    settings.artifactOwner,
    settings.artifactScope
  );
  // Legacy injected stores remain supported, but must not be reported as
  // transactional. The production store implements staged admission.
  const transaction =
    store && typeof store.beginTransaction === 'function'
      ? store.beginTransaction(settings.artifactOwner, settings.artifactScope)
      : null;
  if (!transaction && !snapshot)
    return selectCleanupPlan(
      chatBody,
      buildWorkBuddyWbipcPlan(chatBody, settings, supplied.protectedMessages),
      settings
    );
  try {
    const plan = selectCleanupPlan(
      chatBody,
      buildWorkBuddyWbipcPlan(
        chatBody,
        {
          ...settings,
          artifactStore: transaction || store,
        },
        supplied.protectedMessages
      ),
      settings
    );
    const stagedEntries = transaction?.stats().stagedEntries || 0;
    let historyCommit = null;
    const publish = () =>
      transaction
        ? transaction.commit(
            collectContextArtifactReferences(plan.body?.messages, settings.artifactScope)
          )
        : { ok: true };
    const committed = plan.fits
      ? snapshot
        ? (historyCommit = commitContextHistoryPlan(
            history,
            snapshot,
            plan.body,
            publish,
            settings.signal
          )).publication
        : publish()
      : null;
    const accepted =
      plan.fits && committed?.ok === true && (!snapshot || historyCommit?.ok === true);
    if (!accepted) transaction?.rollback();
    const rejectedBody = !accepted
      ? snapshot
        ? history.snapshot().body || chatBody
        : chatBody
      : null;
    const rejectedBytes = !accepted ? jsonBytes(rejectedBody) : 0;
    return {
      ...plan,
      ...(accepted ? {} : { body: rejectedBody, changed: false, fits: false }),
      diagnostics: {
        ...plan.diagnostics,
        ...(snapshot
          ? {
              historyTransactionStatus: accepted ? 'committed' : 'rolled_back',
              historyVersion: history.stats().version,
            }
          : {}),
        artifactTransactionStatus: transaction
          ? accepted
            ? 'committed'
            : 'rolled_back'
          : 'unavailable',
        artifactsStaged: stagedEntries,
        artifactsStored: accepted ? committed.committedEntries || 0 : 0,
        artifactsDiscarded: accepted ? committed.discardedEntries || 0 : stagedEntries,
        ...(!accepted
          ? {
              reason: historyCommit?.reason || plan.diagnostics.reason || 'artifact_commit_failed',
              attemptedFinalBodyBytes: plan.diagnostics.finalBodyBytes,
              attemptedFinalEstimatedTokens: plan.diagnostics.finalEstimatedTokens,
              finalBodyBytes: rejectedBytes,
              finalEstimatedTokens: estimateTokensForValue(rejectedBody),
              cleanupSavedBytes: 0,
              remainingBodyBytes: Math.max(
                0,
                (plan.diagnostics.hardBodyBytes || 0) - rejectedBytes
              ),
              droppedMessages: 0,
              continuationSummaryAdded: false,
              growthReserveSatisfied: false,
            }
          : {}),
      },
    };
  } finally {
    // Also release reservations on a thrown serialization/planning error. The
    // error propagates unchanged; rollback cannot manufacture a green result.
    transaction?.rollback();
  }
}

module.exports = {
  DEFAULT_RECENT_TOOL_REFERENCE_MESSAGES,
  DEFAULT_WORKBUDDY_ALWAYS_ON_TOOLS,
  DEFAULT_WORKBUDDY_MAX_SELECTED_TOOLS,
  DEFAULT_WORKBUDDY_MIN_CLEANUP_BYTES,
  DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
  DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES,
  DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
  collectReferencedToolNames,
  planWorkBuddyWbipcRequest,
  selectWorkBuddyTools,
};
