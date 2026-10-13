'use strict';

const { createHash } = require('node:crypto');
const {
  DEFAULT_ARTIFACT_PAGE_BYTES,
  MAX_ARTIFACT_PAGE_BYTES,
  serializedContentBytes,
} = require('./context-artifact-page');
const {
  createContextArtifactContinuationRequest,
  parseBufferedChatCompletion,
  parseArguments,
  CONTEXT_ARTIFACT_TOOL_NAME,
} = require('./context-artifact-tool');
const { planWorkBuddyWbipcRequest } = require('./workbuddy-context-planner');
const { collectContextArtifactReferences } = require('./context-artifact-references');
const { estimateTokensForValue } = require('./inline-media');
const {
  captureContextHistorySnapshot,
  commitContextHistoryPlan,
} = require('./context-history-branch');

const MAX_CONTEXT_RECOVERY_ROUNDS = 8;

function recoveryProtection(plannerOptions, currentMessages) {
  return new Set([
    ...(plannerOptions?.protectedMessages instanceof Set ? plannerOptions.protectedMessages : []),
    ...currentMessages,
  ]);
}

function createContextRecoveryGuard() {
  let rounds = 0;
  const seen = new Set();
  return {
    accept(responseBody, stream, maxBytes) {
      const completion = parseBufferedChatCompletion(responseBody, stream, maxBytes);
      const calls = completion?.choices?.[0]?.message?.tool_calls;
      if (
        !Array.isArray(calls) ||
        !calls.some((call) => call?.function?.name === CONTEXT_ARTIFACT_TOOL_NAME)
      )
        return { matched: false };
      if (rounds >= MAX_CONTEXT_RECOVERY_ROUNDS)
        return { matched: true, ok: false, reason: 'context_artifact_read_limit' };
      const fingerprints = calls
        .filter((call) => call?.function?.name === CONTEXT_ARTIFACT_TOOL_NAME)
        .map((call) => {
          const args = parseArguments(call.function.arguments);
          return args
            ? createHash('sha256')
                .update(
                  JSON.stringify([
                    args.locator,
                    args.scope,
                    args.digest,
                    args.offsetBytes ?? 0,
                    args.limitBytes ?? DEFAULT_ARTIFACT_PAGE_BYTES,
                  ])
                )
                .digest('hex')
            : null;
        });
      if (
        fingerprints.some((key) => key && seen.has(key)) ||
        new Set(fingerprints.filter(Boolean)).size !== fingerprints.filter(Boolean).length
      ) {
        return { matched: true, ok: false, reason: 'context_artifact_read_loop' };
      }
      for (const key of fingerprints) if (key) seen.add(key);
      rounds += 1;
      return { matched: true, ok: true };
    },
  };
}

function buildWorkBuddyContextRecovery(options) {
  const { plannerOptions, targetBodyBytes } = options;
  // Plan with fixed-size failure envelopes first. This can archive earlier
  // evidence without ever slicing the fresh, still-unconsumed recovery page.
  const shell = createContextArtifactContinuationRequest({ ...options, maxResultBytes: 0 });
  if (!shell.matched || !shell.ok) return shell;
  const planOptions = {
    ...plannerOptions,
    historyCommit: false,
    force: true,
    adaptiveCompaction: true,
    targetBodyBytes,
    protectedMessages: recoveryProtection(plannerOptions, shell.protectedMessages),
  };
  const shellPlan = planWorkBuddyWbipcRequest(shell.body, planOptions);
  if (!shellPlan.fits) return { ...shell, plan: shellPlan };
  const shells = [...shell.protectedMessages].filter((message) => message.role === 'tool');
  const freedBytes = shells.reduce(
    (sum, message) => sum + serializedContentBytes(JSON.parse(message.content)),
    0
  );
  const hardRemaining = Math.max(
    0,
    targetBodyBytes - Buffer.byteLength(JSON.stringify(shellPlan.body)) + freedBytes
  );
  const preferredRemaining = Math.max(
    0,
    (shellPlan.diagnostics.growthReserveReclaimed
      ? targetBodyBytes
      : shellPlan.diagnostics.cleanupTargetBodyBytes) -
      Buffer.byteLength(JSON.stringify(shellPlan.body)) +
      freedBytes
  );
  // Growth headroom must not turn an otherwise feasible current read into a
  // budget error. Prefer a normal-sized serialized page per call when the hard
  // envelope can accommodate it; reclaim only the reserve needed for that.
  const remaining = Math.max(
    preferredRemaining,
    Math.min(hardRemaining, DEFAULT_ARTIFACT_PAGE_BYTES * shells.length)
  );
  const maxResultBytes = Math.min(MAX_ARTIFACT_PAGE_BYTES, Math.floor(remaining / shells.length));
  const actual = createContextArtifactContinuationRequest({ ...options, maxResultBytes });
  if (!actual.ok) return actual;
  const oldMessages = [...shell.protectedMessages];
  const newMessages = [...actual.protectedMessages];
  const replacements = new Map(oldMessages.map((message, index) => [message, newMessages[index]]));
  const body = {
    ...shellPlan.body,
    messages: shellPlan.body.messages.map((message) => replacements.get(message) || message),
  };
  const plan = planWorkBuddyWbipcRequest(body, {
    ...planOptions,
    protectedMessages: recoveryProtection(plannerOptions, actual.protectedMessages),
  });
  plan.diagnostics.recoveryGrowthReserveReclaimedBytes = Math.max(
    0,
    remaining - preferredRemaining
  );
  // Delivery must not depend on the planner silently dropping a restored page.
  if (plan.fits && !newMessages.every((message) => plan.body.messages.includes(message))) {
    return {
      ...actual,
      plan: {
        ...plan,
        fits: false,
        diagnostics: { ...plan.diagnostics, reason: 'context_artifact_not_preserved' },
      },
    };
  }
  return { ...actual, plan };
}

function planWorkBuddyContextRecovery(options) {
  const plannerOptions = options?.plannerOptions;
  const store = plannerOptions?.artifactStore;
  const history = plannerOptions?.historyCommit === false ? null : plannerOptions?.historyBranch;
  const snapshot = captureContextHistorySnapshot(
    history,
    options.chatBody,
    plannerOptions?.artifactOwner,
    plannerOptions?.artifactScope
  );
  const transaction =
    store && typeof store.beginTransaction === 'function'
      ? store.beginTransaction(plannerOptions.artifactOwner, plannerOptions.artifactScope)
      : null;
  if (!transaction && !snapshot) return buildWorkBuddyContextRecovery(options);
  try {
    // Shell admission and restored-page admission are one transaction. The
    // read store stays committed-only; staged history is not a readable source.
    const result = buildWorkBuddyContextRecovery({
      ...options,
      plannerOptions: {
        ...plannerOptions,
        artifactStore: transaction || store,
        historyCommit: false,
      },
    });
    const stagedEntries = transaction?.stats().stagedEntries || 0;
    if (!result.plan) return result;
    let historyCommit = null;
    const publish = () =>
      transaction
        ? transaction.commit(
            collectContextArtifactReferences(
              result.plan.body.messages,
              plannerOptions.artifactScope
            )
          )
        : { ok: true };
    const committed =
      result.ok && result.plan.fits
        ? snapshot
          ? (historyCommit = commitContextHistoryPlan(
              history,
              snapshot,
              result.plan.body,
              publish,
              plannerOptions.signal
            )).publication
          : publish()
        : null;
    const accepted = committed?.ok === true && (!snapshot || historyCommit?.ok === true);
    const rejectedBody = snapshot ? history.snapshot().body || options.chatBody : options.chatBody;
    const rejectedBytes = accepted ? 0 : Buffer.byteLength(JSON.stringify(rejectedBody));
    return {
      ...result,
      plan: {
        ...result.plan,
        ...(accepted ? {} : { body: rejectedBody, fits: false, changed: false }),
        diagnostics: {
          ...result.plan.diagnostics,
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
          ...(!accepted && result.plan.fits
            ? { reason: historyCommit?.reason || 'artifact_commit_failed' }
            : {}),
          ...(!accepted
            ? {
                attemptedFinalBodyBytes: result.plan.diagnostics.finalBodyBytes,
                attemptedFinalEstimatedTokens: result.plan.diagnostics.finalEstimatedTokens,
                finalBodyBytes: rejectedBytes,
                finalEstimatedTokens: estimateTokensForValue(rejectedBody),
                cleanupSavedBytes: 0,
                remainingBodyBytes: Math.max(0, options.targetBodyBytes - rejectedBytes),
                droppedMessages: 0,
                continuationSummaryAdded: false,
                growthReserveSatisfied: false,
              }
            : {}),
        },
      },
    };
  } finally {
    transaction?.rollback();
  }
}

module.exports = {
  MAX_CONTEXT_RECOVERY_ROUNDS,
  createContextRecoveryGuard,
  planWorkBuddyContextRecovery,
};
