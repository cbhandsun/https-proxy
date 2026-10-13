'use strict';

const {
  CONTEXT_CLASSES,
  classifyContextMessages,
  toolCallIds,
  toolResultIds,
} = require('./context-classifier');
const {
  EVIDENCE_MARKER,
  buildRolePreservingCheckpoint,
  createEvidenceReceipt,
  evidenceReceiptWasStored,
  validateCheckpointMessages,
} = require('./context-checkpoint');
const { pruneMessagesToTokenBudget } = require('./context-budget-manager');
const { boundCompletedToolRounds } = require('./context-completed-rounds');
const { estimateTokensForValue } = require('./inline-media');

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized) : 0;
  } catch (_error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function evidencePlaceholder(receipt) {
  return `${EVIDENCE_MARKER} ${JSON.stringify(receipt)}`;
}

function countArtifactReferences(messages) {
  try {
    return JSON.stringify(messages).match(/hca_[0-9a-f]{32}/g)?.length || 0;
  } catch (_error) {
    return 0;
  }
}

function foldToolResultContent(content, placeholder) {
  if (typeof content === 'string') return placeholder;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'tool_result') return { ...part, content: placeholder };
    if (['text', 'input_text', 'output_text'].includes(part.type)) {
      return { ...part, text: placeholder };
    }
    if (part.functionResponse && typeof part.functionResponse === 'object') {
      return {
        ...part,
        functionResponse: {
          ...part.functionResponse,
          response: { content: placeholder },
        },
      };
    }
    return part;
  });
}

function foldEvidenceMessage(message, receipt) {
  if (!message || typeof message !== 'object') return message;
  return {
    ...message,
    content: foldToolResultContent(message.content, evidencePlaceholder(receipt)),
  };
}

function checkpointInsertionIndex(messages) {
  const latestUser = messages.findLastIndex(
    (message) =>
      message &&
      message.role === 'user' &&
      toolResultIds(message).length === 0 &&
      !isCheckpointMessage(message)
  );
  if (latestUser >= 0) return latestUser;
  const lastPolicy = messages.findLastIndex(
    (message) => message && ['system', 'developer'].includes(message.role)
  );
  return lastPolicy + 1;
}

function isCheckpointMessage(message) {
  return !!(
    message &&
    ['user', 'assistant'].includes(message.role) &&
    typeof message.content === 'string' &&
    message.content.startsWith('[HPM_CONTEXT_CHECKPOINT_V1]\n') &&
    validateCheckpointMessages([message], 64 * 1024)
  );
}

function stablePrefixPreserved(original, planned) {
  const leadingPolicy = (messages) => {
    const prefix = [];
    for (const message of messages) {
      if (!message || !['system', 'developer'].includes(message.role)) break;
      prefix.push(message);
    }
    return prefix;
  };
  const before = leadingPolicy(original);
  const after = leadingPolicy(planned);
  return (
    before.length === after.length && before.every((message, index) => message === after[index])
  );
}

function planContextEviction(messages, budgetBytes, options = {}) {
  const tokenBudget = options.inputBudgetTokens;
  if (
    !Array.isArray(messages) ||
    !Number.isFinite(budgetBytes) ||
    budgetBytes < 0 ||
    (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0))
  ) {
    return {
      messages,
      changed: false,
      fits: false,
      diagnostics: { reason: 'invalid_input', originalBytes: jsonBytes(messages) },
    };
  }
  const originalBytes = jsonBytes(messages);
  if (
    originalBytes <= budgetBytes &&
    (tokenBudget === undefined || estimateTokensForValue(messages) <= tokenBudget)
  ) {
    return {
      messages,
      changed: false,
      fits: true,
      diagnostics: {
        originalBytes,
        finalBytes: originalBytes,
        foldedEvidence: 0,
        evictedMessages: 0,
        checkpointAdded: false,
        artifactsReferenced: countArtifactReferences(messages),
      },
    };
  }
  const rounds =
    options.boundCompletedRounds === true
      ? boundCompletedToolRounds(messages, options)
      : { messages, droppedMessages: [], completedRounds: 0, evictedRounds: 0 };
  const previousCheckpoints = rounds.messages.filter(isCheckpointMessage);
  const activeMessages = rounds.messages.filter((message) => !isCheckpointMessage(message));
  const classification = classifyContextMessages(activeMessages, options);
  const receiptCache =
    options.receiptCache instanceof WeakMap ? options.receiptCache : new WeakMap();
  let artifactsStored = 0;
  const receiptFactory = (message, originalMessage = message) => {
    if (
      originalMessage &&
      typeof originalMessage === 'object' &&
      receiptCache.has(originalMessage)
    ) {
      return receiptCache.get(originalMessage);
    }
    const receipt = createEvidenceReceipt(message, options);
    if (evidenceReceiptWasStored(receipt)) artifactsStored += 1;
    if (originalMessage && typeof originalMessage === 'object')
      receiptCache.set(originalMessage, receipt);
    return receipt;
  };
  const protectedWorkingSet = new Set(
    classification.items
      .filter((item) => item.contextClass === CONTEXT_CLASSES.RECENT_WORKING_SET)
      .map((item) => item.message)
  );
  let foldedEvidence = 0;
  const foldedMessages = classification.items.map((item) => {
    if (options.protectedMessages?.has(item.message)) return item.message;
    if (options.preserveUserMessages === true && item.message?.role === 'user') return item.message;
    if (item.contextClass !== CONTEXT_CLASSES.EVICTABLE_EVIDENCE) return item.message;
    foldedEvidence += 1;
    const receipt = receiptFactory(item.message);
    const folded = foldEvidenceMessage(item.message, receipt);
    if (folded && typeof folded === 'object') receiptCache.set(folded, receipt);
    return folded;
  });
  const pruneOptions = {
    isProtectedMessage: (message) =>
      options.protectedMessages?.has(message) ||
      protectedWorkingSet.has(message) ||
      isCheckpointMessage(message) ||
      (options.preserveUserMessages === true && message?.role === 'user') ||
      // Once complete rounds are bounded, generic pruning must not split any
      // remaining exchange, including ambiguous or unfinished calls/results.
      (options.boundCompletedRounds === true &&
        (toolCallIds(message).length > 0 ||
          toolResultIds(message).length > 0 ||
          message?.function_call)),
  };
  const serializedMessageCost = (message) => jsonBytes(message) + 1;
  const serializedMessageBudget = Math.max(0, budgetBytes - 1);
  let retained = foldedMessages;
  let dropped = [...rounds.droppedMessages];
  let checkpoint = previousCheckpoints;
  let checkpointAttempted = dropped.length > 0;
  // Every pass strictly removes messages or terminates. Rebuild from all dropped
  // state so a checkpoint's own byte cost cannot silently discard more history.
  for (let pass = 0; pass <= foldedMessages.length; pass += 1) {
    if (dropped.length > 0) {
      checkpoint = buildRolePreservingCheckpoint([...previousCheckpoints, ...dropped], {
        maxChars: options.maxCheckpointChars,
        maxEntries: options.maxCheckpointEntries,
        receiptFactory,
      });
    }
    const checkpointCost = (checkpoint || []).reduce(
      (sum, message) => sum + serializedMessageCost(message),
      0
    );
    const pruned = pruneMessagesToTokenBudget(
      retained,
      Math.max(0, serializedMessageBudget - checkpointCost),
      serializedMessageCost,
      pruneOptions
    );
    const tokenPruned =
      tokenBudget === undefined
        ? { messages: pruned.messages, droppedMessages: [], droppedCount: 0 }
        : pruneMessagesToTokenBudget(
            pruned.messages,
            Math.max(0, tokenBudget - estimateTokensForValue(checkpoint)),
            estimateTokensForValue,
            pruneOptions
          );
    retained = tokenPruned.messages;
    if (pruned.droppedCount + tokenPruned.droppedCount === 0) break;
    checkpointAttempted = true;
    const droppedSet = new Set([
      ...dropped,
      ...pruned.droppedMessages,
      ...tokenPruned.droppedMessages,
    ]);
    dropped = [...rounds.droppedMessages, ...foldedMessages].filter((message) =>
      droppedSet.has(message)
    );
  }
  if (dropped.length > 0 && !checkpoint?.length) {
    return {
      messages,
      changed: false,
      fits: false,
      diagnostics: {
        originalBytes,
        finalBytes: originalBytes,
        reason: 'checkpoint_unavailable',
        checkpointStatus: 'unavailable',
        checkpointValid: false,
        stablePrefixPreserved: true,
        evictedMessages: 0,
      },
    };
  }
  const finalMessages = [...retained];
  if (checkpoint?.length) {
    finalMessages.splice(checkpointInsertionIndex(finalMessages), 0, ...checkpoint);
  }
  const checkpointAdded = dropped.length > 0 && !!checkpoint?.length;
  const finalBytes = jsonBytes(finalMessages);
  const retainedCheckpoints = finalMessages.filter(isCheckpointMessage);
  const checkpointValid =
    retainedCheckpoints.length > 0 &&
    validateCheckpointMessages(retainedCheckpoints, options.maxCheckpointChars);
  const checkpointStatus = !checkpointAttempted
    ? 'not_needed'
    : !checkpoint
      ? 'unavailable'
      : !checkpointAdded
        ? 'removed_for_budget'
        : checkpointValid
          ? 'validated'
          : 'invalid';
  const artifactsReferenced = countArtifactReferences(finalMessages);
  return {
    messages: finalMessages,
    changed: foldedEvidence > 0 || dropped.length > 0 || checkpointAdded,
    fits:
      finalBytes <= budgetBytes &&
      (!checkpointAdded || checkpointValid) &&
      (tokenBudget === undefined || estimateTokensForValue(finalMessages) <= tokenBudget),
    diagnostics: {
      originalBytes,
      finalBytes,
      foldedEvidence,
      evictedMessages: dropped.length,
      completedToolRounds: rounds.completedRounds,
      evictedToolRounds: rounds.evictedRounds,
      checkpointAdded,
      checkpointStatus,
      checkpointValid,
      savedBytes: Math.max(0, originalBytes - finalBytes),
      stablePrefixPreserved: stablePrefixPreserved(messages, finalMessages),
      immutableMessages: classification.counts[CONTEXT_CLASSES.IMMUTABLE_POLICY] || 0,
      recentMessages: classification.counts[CONTEXT_CLASSES.RECENT_WORKING_SET] || 0,
      durableMessages: classification.counts[CONTEXT_CLASSES.DURABLE_STATE] || 0,
      evictableMessages: classification.counts[CONTEXT_CLASSES.EVICTABLE_EVIDENCE] || 0,
      unresolvedToolCalls: classification.unresolvedCallIds.length,
      artifactsStored,
      artifactsReferenced,
    },
  };
}

module.exports = { planContextEviction };
