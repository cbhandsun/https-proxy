'use strict';

const { DEFAULT_KEEP_COMPLETED_TOOL_ROUNDS } = require('./context-completed-rounds');
const { DEFAULT_CHECKPOINT_CHARS } = require('./context-checkpoint');
const { planContextEviction } = require('./context-eviction-planner');
const { compactWorkBuddyWbipcBody } = require('./workbuddy-wbipc-payload');
const { estimateTokensForValue } = require('./inline-media');

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

// Retention is a preference, not an invariant: byte or token pressure can archive more
// completed exchanges. Always retry from original state, never a lossy candidate.
function planContextWorkingSet(body, targetBytes, options = {}) {
  const configuredKeep =
    Number.isSafeInteger(options.keepCompletedToolRounds) && options.keepCompletedToolRounds > 0
      ? Math.min(64, options.keepCompletedToolRounds)
      : DEFAULT_KEEP_COMPLETED_TOOL_ROUNDS;
  const messageBudget = Math.max(0, targetBytes - jsonBytes({ ...body, messages: [] }) + 2);
  const tokenBudget = options.operationalInputTokens;
  const messageTokenBudget =
    tokenBudget === undefined
      ? undefined
      : Math.max(0, tokenBudget - estimateTokensForValue({ ...body, messages: [] }));
  const requiredBytes = body.messages
    .filter((message) => message && ['system', 'developer', 'user'].includes(message.role))
    .reduce((sum, message) => sum + jsonBytes(message) + 1, 0);
  const maxCheckpointChars =
    options.maxChars ??
    Math.min(
      DEFAULT_CHECKPOINT_CHARS,
      Math.max(1024, Math.floor((messageBudget - requiredBytes) / 3))
    );
  const receiptCache =
    options.receiptCache instanceof WeakMap ? options.receiptCache : new WeakMap();
  const originalMessagesBytes = jsonBytes(body.messages);
  let keep = configuredKeep;
  let artifactsStored = 0;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const eviction = planContextEviction(body.messages, messageBudget, {
      keepRecentUserTurns: options.keepRecentUserTurns,
      boundCompletedRounds: true,
      keepCompletedToolRounds: keep,
      allowEmptyCompletedRounds: true,
      preserveUserMessages: true,
      protectedMessages: options.protectedMessages,
      maxCheckpointChars,
      maxCheckpointEntries: options.maxCheckpointEntries,
      artifactStore: options.artifactStore,
      artifactOwner: options.artifactOwner,
      artifactScope: options.artifactScope,
      receiptCache,
      inputBudgetTokens: messageTokenBudget,
      originalMessagesBytes,
    });
    artifactsStored += eviction.diagnostics.artifactsStored || 0;
    eviction.diagnostics.artifactsStored = artifactsStored;
    eviction.diagnostics.workingSetAttempts = attempts;
    eviction.diagnostics.retainedToolRoundLimit = keep;
    // Failure is terminal. A second generic pruner must never erase state after
    // its checkpoint could not be constructed or validated.
    const checkpointFailed = ['unavailable', 'invalid'].includes(
      eviction.diagnostics.checkpointStatus
    );
    const plannedBody = eviction.changed ? { ...body, messages: eviction.messages } : body;
    const compacted = checkpointFailed
      ? { body: plannedBody, changed: false }
      : compactWorkBuddyWbipcBody(
          plannedBody,
          targetBytes,
          options.maxMessageChars,
          options.maxProtectedMessageChars,
          {
            adaptive: options.adaptiveCompaction !== false,
            keepRecentUserTurns: options.keepRecentUserTurns ?? 2,
            allowHistoryEviction: false,
            preserveUserMessages: true,
            protectedMessages: options.protectedMessages,
            preserveToolSchemas: options.preserveToolSchemas === true,
          }
        );
    const candidate = compacted.changed ? compacted.body : plannedBody;
    const candidateBytes = Number.isSafeInteger(compacted.bodyBytes)
      ? compacted.bodyBytes
      : jsonBytes(candidate);
    if (
      checkpointFailed ||
      (candidateBytes <= targetBytes &&
        (tokenBudget === undefined || estimateTokensForValue(candidate) <= tokenBudget)) ||
      keep === 0 ||
      !(eviction.diagnostics.completedToolRounds > 0)
    ) {
      return { body: candidate, bodyBytes: candidateBytes, eviction, compacted, checkpointFailed };
    }
    keep = Math.floor(keep / 2);
  }
}

module.exports = { planContextWorkingSet };
