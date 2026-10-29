'use strict';
const { usesNativeContextPlanning } = require('./context-recovery-policy');

const { boundCompletedToolRounds } = require('./context-completed-rounds');
const {
  toolCallIds,
  toolResultIds,
  classifyContextMessages,
  CONTEXT_CLASSES,
} = require('./context-classifier');
const { preservesResponsesHistory } = require('./responses-history-policy');
const { planWorkBuddyWbipcRequest } = require('./workbuddy-context-planner');
const { collectContextArtifactReferences } = require('./context-artifact-references');
const { estimateTokensForValue } = require('./inline-media');
const { createHash } = require('node:crypto');
const { createContextCompactionCoordinator } = require('./context-compaction-coordinator');
const { compactionBackoffKey } = require('./context-compaction-backoff');
const {
  createCompactionTiming,
  startCompactionTiming,
  measureCompactionTiming,
  snapshotCompactionTiming,
} = require('./context-compaction-timing');
const { createPendingContextPlan } = require('./context-pending-plan');
const { decideContextCleanup } = require('./context-cleanup-decision');
const {
  captureContextHistorySnapshot,
  commitContextHistoryPlan,
  contextHistoryControlDigest,
} = require('./context-history-branch');
const {
  TASK_STATE_MARKER,
  taskStateMessage,
  generatedTaskStateUserArchiveReferences,
} = require('./context-task-state');
const { measureWorkBuddyRequiredContext } = require('./workbuddy-required-context');
const {
  selectHistoricalUserArchive,
  stageHistoricalUserArchive,
} = require('./context-user-archive');
const {
  stateFromCompletion,
  planWorkBuddyTaskStateSummary,
  parseWorkBuddyTaskStateSummary,
  produceWorkBuddyTaskStateSummary,
  retainedWorkBuddyTaskStateMessages,
} = require('./workbuddy-task-state-summary');

const MIN_TASK_STATE_PROGRESS_CHARS = 1024;

function historicalProgress(body, options) {
  if (!Array.isArray(body?.messages) || preservesResponsesHistory(body)) return [];
  const rounds = boundCompletedToolRounds(body.messages, {
    ...options,
    keepCompletedToolRounds: 8,
  });
  const callIndices = body.messages.flatMap((message, index) =>
    toolCallIds(message).length > 0 ? [index] : []
  );
  const recentToolStart =
    callIndices.length > 0 ? callIndices.slice(-8)[0] : Math.max(0, body.messages.length - 6);
  const durable = classifyContextMessages(body.messages, options)
    .items.filter(
      (item) =>
        item.contextClass === CONTEXT_CLASSES.DURABLE_STATE &&
        item.index < recentToolStart &&
        !rounds.protectedIntervals.some(
          (interval) => item.index >= interval.start && item.index <= interval.end
        )
    )
    .map((item) => item.message);
  // Include old standalone narration and prior task-state messages, not just
  // narration adjacent to archived tool rounds. Otherwise each successive
  // summary leaves an older checkpoint behind and grows the context forever.
  return [...new Set([...rounds.droppedMessages, ...durable])].filter(
    (message) =>
      message?.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0 &&
      toolCallIds(message).length === 0 &&
      toolResultIds(message).length === 0 &&
      !message.function_call &&
      generatedTaskStateUserArchiveReferences(message).length === 0 &&
      !options.protectedMessages?.has(message)
  );
}

async function prepareWorkBuddyTaskStateContext(body, options = {}, runtime = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {};
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) runtime = {};
  if (usesNativeContextPlanning(options.contextPolicyOptions || {}))
    return planWorkBuddyWbipcRequest(body, options);
  const history = runtime.historyBranch || options.historyBranch;
  const snapshot = captureContextHistorySnapshot(
    history,
    body,
    options.artifactOwner,
    options.artifactScope
  );
  if (runtime.deferCommit === true && !snapshot)
    throw new TypeError('Deferred context planning requires owned history');
  if (snapshot) {
    const original = body;
    body = snapshot.body;
    if (options.protectedMessages instanceof Set)
      options = {
        ...options,
        protectedMessages: new Set(
          body.messages.filter((_entry, index) =>
            options.protectedMessages.has(original.messages[index])
          )
        ),
      };
  }
  const store = options.artifactStore;
  const transaction =
    store && typeof store.beginTransaction === 'function'
      ? store.beginTransaction(options.artifactOwner, options.artifactScope)
      : null;
  const planning = {
    ...options,
    receiptCache: new WeakMap(),
    historyCommit: false,
    ...(transaction ? { artifactStore: transaction } : {}),
  };
  const protectedIndices = new Set(
    Array.isArray(body?.messages)
      ? body.messages.flatMap((entry, index) =>
          options.protectedMessages?.has(entry) ? [index] : []
        )
      : []
  );
  let plan;
  let stateStatus = 'not_needed';
  let summaryAttempted = false;
  let requirements = 0;
  let revokedRequirements = 0;
  let localCoordinator = null;
  let stale = false;
  let summaryGeneration = 0;
  let summaryReused = false;
  let summaryChunks = 0;
  let carriedRequirements = 0;
  let pinnedStates = 0;
  let summaryFailureReason;
  let pendingCommit = null;
  let summaryCheckpoints = null;
  let archivedUsers = 0;
  let archiveStatus = 'not_requested';
  const timing = runtime.compactionTiming || createCompactionTiming();
  const finishPlanning = startCompactionTiming(timing, 'planning');
  let backoffApplied = false;
  let retryAfterMs = 0;
  try {
    plan = planWorkBuddyWbipcRequest(body, planning);
    const archiveSelection = selectHistoricalUserArchive(body?.messages, {
      enabled:
        options.archiveHistoricalUsers === true &&
        Boolean(transaction) &&
        !preservesResponsesHistory(body),
      keepRecentUserTurns: options.keepRecentUserTurns,
      protectedMessages: options.protectedMessages,
      protectedIntervals:
        options.archiveHistoricalUsers === true && Array.isArray(body?.messages)
          ? boundCompletedToolRounds(body.messages, {
              ...options,
              keepCompletedToolRounds: 0,
              allowEmptyCompletedRounds: true,
            }).protectedIntervals
          : [],
    });
    const archiveIndices = new Set(archiveSelection.indices);
    const archiveNeeded =
      archiveSelection.messageCount > 0 &&
      plan.diagnostics.preflightApplied === true &&
      plan.diagnostics.cleanupDeferred !== true;
    const remainingRequired = archiveNeeded
      ? measureWorkBuddyRequiredContext(
          body.messages.filter((_entry, index) => !archiveIndices.has(index))
        )
      : null;
    const archiveCanHelp =
      archiveNeeded &&
      !(
        remainingRequired?.requiredContextMeasured &&
        (remainingRequired.requiredContextMessageBytes > plan.diagnostics.hardBodyBytes ||
          remainingRequired.requiredContextEstimatedTokens >
            plan.diagnostics.operationalInputTokens)
      );
    if (options.archiveHistoricalUsers === true)
      archiveStatus = archiveCanHelp ? 'selected' : 'not_eligible_or_not_needed';
    const progress =
      plan.diagnostics.reason === 'required_context_too_large' && !archiveCanHelp
        ? []
        : historicalProgress(body, options);
    const progressSet = new Set(progress);
    const progressIndices = new Set(
      Array.isArray(body?.messages)
        ? body.messages.flatMap((entry, index) => (progressSet.has(entry) ? [index] : []))
        : []
    );
    const progressChars = progress.reduce((sum, message) => sum + message.content.length, 0);
    const needsState =
      plan.diagnostics.preflightApplied === true &&
      plan.diagnostics.cleanupDeferred !== true &&
      (archiveCanHelp ||
        (progress.length > 0 &&
          (progressChars >= MIN_TASK_STATE_PROGRESS_CHARS ||
            progress.some((message) => message.content.startsWith(TASK_STATE_MARKER + '\n')))));
    if (runtime.signal?.aborted) stateStatus = 'cancelled';
    // A measured policy/user lower bound is unchanged by every narration-only
    // summary. Do not spend a model request on a provably impossible admission.
    else if (plan.diagnostics.reason === 'required_context_too_large' && !archiveCanHelp)
      stateStatus = 'required_context_too_large';
    else if (needsState) {
      const summaryPlan =
        plan.diagnostics.reason === 'immutable_context_too_large'
          ? null
          : planWorkBuddyTaskStateSummary(body, progress, {
              maxBytes: plan.diagnostics.hardBodyBytes || options.targetBodyBytes,
              maxTokens: plan.diagnostics.operationalInputTokens || 96 * 1024,
              archiveSourceIndices: archiveCanHelp ? archiveSelection.indices : [],
            });
      if (!summaryPlan) stateStatus = 'source_unavailable';
      else if (typeof runtime.requestSummary !== 'function') stateStatus = 'summarizer_unavailable';
      else {
        carriedRequirements = summaryPlan.carriedRequirements;
        pinnedStates = summaryPlan.pinnedStates;
        for (const message of retainedWorkBuddyTaskStateMessages(summaryPlan)) {
          const index = body.messages.indexOf(message);
          if (index >= 0) {
            protectedIndices.add(index);
            progressIndices.delete(index);
          }
        }
        if (snapshot && runtime.summaryCheckpoints && runtime.compactionRetryBinding)
          summaryCheckpoints = runtime.summaryCheckpoints.begin({
            history,
            snapshot,
            binding: runtime.compactionRetryBinding,
            protectedIndices: [...protectedIndices],
            signal: runtime.signal,
          });
        summaryAttempted = true;
        summaryChunks = summaryPlan.chunkCount;
        const sentMessages = body.messages.length;
        const prefixDigest = createHash('sha256')
          .update(JSON.stringify(body.messages))
          .digest('hex');
        const controlsDigest = contextHistoryControlDigest(body);
        const coordinator =
          runtime.coordinator || (localCoordinator = createContextCompactionCoordinator());
        finishPlanning();
        const coordinate = () =>
          coordinator.run({
            owner: options.artifactOwner || 'workbuddy',
            scope: runtime.compactionScope || body.model,
            operationId: summaryPlan.digest,
            snapshotDigest: summaryPlan.digest,
            signal: runtime.signal,
            produce: async (signal) => {
              return produceWorkBuddyTaskStateSummary(
                summaryPlan,
                runtime.requestSummary,
                signal,
                timing,
                summaryCheckpoints
              );
            },
            validate: (value) => {
              try {
                measureCompactionTiming(timing, 'validation', () =>
                  parseWorkBuddyTaskStateSummary(value, summaryPlan)
                );
                return true;
              } catch (error) {
                if (error?.code !== 'invalid_task_state') throw error;
                return false;
              }
            },
          });
        const finishCoordination = startCompactionTiming(timing, 'coordination');
        let coordinated;
        try {
          coordinated =
            runtime.failureBackoff && runtime.compactionRetryBinding
              ? await runtime.failureBackoff.run({
                  key: compactionBackoffKey(
                    runtime.compactionRetryBinding,
                    prefixDigest,
                    controlsDigest,
                    summaryPlan.digest
                  ),
                  signal: runtime.signal,
                  produce: coordinate,
                })
              : await coordinate();
        } finally {
          finishCoordination();
        }
        backoffApplied = coordinated.backoffApplied === true;
        retryAfterMs = backoffApplied ? coordinated.retryAfterMs : 0;
        summaryAttempted = snapshotCompactionTiming(timing).summaryRequests > 0;
        let appendedMessages = [];
        if (snapshot) {
          const current = history.inspect(snapshot);
          stale = !current.ok;
          body = current.ok ? current.body : history.snapshot().body || body;
          appendedMessages = current.ok ? current.appendedMessages : [];
        } else {
          const currentPrefixDigest = Array.isArray(body.messages)
            ? createHash('sha256')
                .update(JSON.stringify(body.messages.slice(0, sentMessages)))
                .digest('hex')
            : null;
          stale =
            !Array.isArray(body.messages) ||
            body.messages.length < sentMessages ||
            currentPrefixDigest !== prefixDigest ||
            contextHistoryControlDigest(body) !== controlsDigest;
          appendedMessages = !stale ? body.messages.slice(sentMessages) : [];
        }
        planning.protectedMessages = new Set([
          ...(!stale ? body.messages.filter((_entry, index) => protectedIndices.has(index)) : []),
          ...appendedMessages,
        ]);
        if (runtime.signal?.aborted) stateStatus = 'cancelled';
        else if (stale) stateStatus = 'stale_snapshot';
        else if (!coordinated.ok) {
          stateStatus = coordinated.reason;
          summaryFailureReason = coordinated.failureReason;
          if (stateStatus === 'compaction_timeout') summaryCheckpoints?.saveProgress();
        } else {
          const summary = measureCompactionTiming(timing, 'validation', () =>
            parseWorkBuddyTaskStateSummary(coordinated.value, summaryPlan)
          );
          const source = summary.source;
          summaryGeneration = coordinated.generation;
          summaryReused = coordinated.reused;
          let message;
          const userArchive = archiveCanHelp
            ? stageHistoricalUserArchive(
                archiveSelection,
                summary.state,
                transaction,
                options.artifactOwner,
                options.artifactScope
              )
            : undefined;
          if (archiveCanHelp && !userArchive) archiveStatus = 'coverage_or_storage_unavailable';
          try {
            message = taskStateMessage(
              summary.state,
              source,
              userArchive || undefined,
              summary.requirementsRebasable
            );
          } catch (error) {
            if (error?.code !== 'invalid_task_state') throw error;
            stateStatus = 'state_too_large';
          }
          if (message) {
            const messages = body.messages.filter(
              (_entry, index) =>
                !progressIndices.has(index) && !(userArchive && archiveIndices.has(index))
            );
            const latestUser = messages.findLastIndex(
              (entry) => entry?.role === 'user' && toolResultIds(entry).length === 0
            );
            messages.splice(latestUser >= 0 ? latestUser : messages.length, 0, message);
            const protectedMessages = new Set([...(planning.protectedMessages || []), message]);
            const candidate = measureCompactionTiming(timing, 'planning', () =>
              planWorkBuddyWbipcRequest(
                { ...body, messages },
                // This is one step inside an already selected cleanup. Measure
                // its net benefit against the original window below, not against
                // the intermediate window after narration has been summarized.
                { ...planning, force: true, protectedMessages }
              )
            );
            const decision = decideContextCleanup({
              originalBodyBytes: Buffer.byteLength(JSON.stringify(body)),
              originalEstimatedTokens: estimateTokensForValue(body),
              finalBodyBytes: candidate.diagnostics.finalBodyBytes,
              finalEstimatedTokens: candidate.diagnostics.finalEstimatedTokens,
              targetBodyBytes: candidate.diagnostics.hardBodyBytes,
              operationalInputTokens: candidate.diagnostics.operationalInputTokens,
              minimumCleanupBytes: candidate.diagnostics.minimumCleanupBytes,
              forced: planning.force === true,
              candidateFits: candidate.fits,
            });
            if (decision.apply && candidate.body.messages.includes(message)) {
              plan = {
                ...candidate,
                changed: true,
                diagnostics: {
                  ...candidate.diagnostics,
                  originalBodyBytes: Buffer.byteLength(JSON.stringify(body)),
                  originalEstimatedTokens: estimateTokensForValue(body),
                  cleanupSavedBytes: decision.savedBytes,
                  minimumCleanupSatisfied: decision.minimumCleanupSatisfied,
                  cleanupDecision: decision.reason,
                  cleanupRequired: decision.required,
                  cleanupDeferred: false,
                },
              };
              requirements = summary.state.requirements.length;
              revokedRequirements = summary.state.requirements.filter((entry) =>
                ['revoked', 'superseded'].includes(entry.status)
              ).length;
              stateStatus = 'applied';
              if (userArchive) {
                archivedUsers = archiveSelection.messageCount;
                archiveStatus = 'staged';
              }
            } else stateStatus = 'state_budget_rejected';
          }
        }
        // Every fallback must plan the current history, including successful
        // summaries rejected for size. Returning the old preflight would lose
        // appends that arrived while the independent summarizer was running.
        if (!stale && stateStatus !== 'applied' && body.messages.length > sentMessages)
          plan = planWorkBuddyWbipcRequest(body, planning);
      }
    }
    finishPlanning();
    const staged = transaction?.stats().stagedEntries || 0;
    const cancelled = runtime.signal?.aborted === true;
    let historyCommit = null;
    const publish = () =>
      transaction
        ? transaction.commit(
            collectContextArtifactReferences(plan.body?.messages, options.artifactScope)
          )
        : { ok: true };
    if (runtime.deferCommit === true && plan.fits && !cancelled && !stale)
      pendingCommit = createPendingContextPlan({
        history,
        snapshot,
        plan: {
          body: plan.body,
          changed: plan.changed,
          fits: plan.fits,
          diagnostics: {
            ...plan.diagnostics,
            taskStateStatus: stateStatus,
            taskStateSummaryAttempted: summaryAttempted,
            taskStateRequirements: requirements,
            taskStateRevokedRequirements: revokedRequirements,
            taskStateTaskCorrectness: 'not_verified',
            taskStateSummaryGeneration: summaryGeneration,
            taskStateSummaryReused: summaryReused,
            taskStateSummaryChunks: summaryChunks,
            taskStateCarriedRequirements: carriedRequirements,
            taskStatePinnedStates: pinnedStates,
            taskStateBackoffApplied: backoffApplied,
            taskStateRetryAfterMs: retryAfterMs,
            taskStateCheckpointHits: summaryCheckpoints?.stats().hits || 0,
            taskStateFrontierReused: summaryCheckpoints?.stats().frontierReused === true,
            taskStateFrontierSourceMessages:
              summaryCheckpoints?.stats().frontierSourceMessages || 0,
            taskStateCheckpointMisses: summaryCheckpoints?.stats().misses || 0,
            taskStateCheckpointCommitted: false,
            taskStateSummaryProgressSaved: summaryCheckpoints?.stats().progressSavedEntries || 0,
            taskStateSummaryProgressReused:
              summaryCheckpoints?.stats().frontierProgressReused === true,
            compactionTiming: { ...snapshotCompactionTiming(timing), commitDeferred: true },
            userArchiveStatus: archiveStatus,
            archivedUserMessages: archivedUsers,
          },
        },
        sourceMessages: body.messages.length,
        transaction,
        scope: options.artifactScope,
        signal: runtime.signal,
      });
    if (pendingCommit && summaryCheckpoints) {
      const pending = pendingCommit;
      const checkpoints = summaryCheckpoints;
      let settled;
      pendingCommit = Object.freeze({
        commit() {
          if (settled) return settled;
          const result = pending.commit();
          if (!result.ok || stateStatus !== 'applied') checkpoints.rollback();
          const committed = result.ok && stateStatus === 'applied' && checkpoints.commit();
          settled = result.ok
            ? {
                ...result,
                plan: {
                  ...result.plan,
                  diagnostics: {
                    ...result.plan.diagnostics,
                    taskStateCheckpointCommitted: committed,
                  },
                },
              }
            : result;
          return settled;
        },
        rollback() {
          checkpoints.rollback();
          return pending.rollback();
        },
      });
    }
    const commit =
      !pendingCommit && plan.fits && !cancelled && !stale
        ? measureCompactionTiming(timing, 'commit', () =>
            snapshot
              ? (historyCommit = commitContextHistoryPlan(
                  history,
                  snapshot,
                  plan.body,
                  publish,
                  runtime.signal
                )).publication
              : publish()
          )
        : null;
    const admitted =
      plan.fits &&
      !cancelled &&
      !stale &&
      (Boolean(pendingCommit) ||
        ((!snapshot || historyCommit?.ok === true) && (!transaction || commit?.ok === true)));
    if (admitted && !pendingCommit && stateStatus === 'applied') summaryCheckpoints?.commit();
    // A managed writer may replace history after summary revalidation but
    // before stage/commit. A rejected candidate must return the current,
    // unlossy canonical history, just like the synchronous planner does.
    if (!admitted && snapshot) body = history.snapshot().body || body;
    const originalBytes =
      body && typeof body === 'object' ? Buffer.byteLength(JSON.stringify(body)) : 0;
    const originalTokens = estimateTokensForValue(body);
    return {
      ...plan,
      ...(pendingCommit ? { pendingCommit } : {}),
      ...(!admitted ? { body, fits: false, changed: false } : {}),
      diagnostics: {
        ...plan.diagnostics,
        originalBodyBytes: originalBytes,
        originalEstimatedTokens: originalTokens,
        cleanupSavedBytes: admitted
          ? Math.max(0, originalBytes - plan.diagnostics.finalBodyBytes)
          : 0,
        taskStateStatus: cancelled
          ? 'cancelled'
          : !admitted && stateStatus === 'applied'
            ? 'commit_rejected'
            : stateStatus,
        taskStateSummaryAttempted: summaryAttempted,
        ...(summaryFailureReason ? { taskStateFailureReason: summaryFailureReason } : {}),
        taskStateRequirements: admitted ? requirements : 0,
        taskStateRevokedRequirements: admitted ? revokedRequirements : 0,
        taskStateTaskCorrectness: 'not_verified',
        taskStateSummaryGeneration: summaryGeneration,
        taskStateSummaryReused: summaryReused,
        taskStateSummaryChunks: summaryChunks,
        taskStateCarriedRequirements: carriedRequirements,
        taskStatePinnedStates: pinnedStates,
        taskStateBackoffApplied: backoffApplied,
        taskStateRetryAfterMs: retryAfterMs,
        taskStateCheckpointHits: summaryCheckpoints?.stats().hits || 0,
        taskStateFrontierReused: summaryCheckpoints?.stats().frontierReused === true,
        taskStateFrontierSourceMessages: summaryCheckpoints?.stats().frontierSourceMessages || 0,
        taskStateCheckpointMisses: summaryCheckpoints?.stats().misses || 0,
        taskStateCheckpointCommitted: summaryCheckpoints?.stats().committed === true,
        taskStateSummaryProgressSaved: summaryCheckpoints?.stats().progressSavedEntries || 0,
        taskStateSummaryProgressReused: summaryCheckpoints?.stats().frontierProgressReused === true,
        compactionTiming: {
          ...snapshotCompactionTiming(timing),
          commitDeferred: Boolean(pendingCommit),
        },
        userArchiveStatus:
          admitted && archivedUsers > 0
            ? pendingCommit
              ? 'staged'
              : 'committed'
            : archiveStatus === 'staged'
              ? 'rolled_back'
              : archiveStatus,
        archivedUserMessages: admitted ? archivedUsers : 0,
        ...(snapshot
          ? {
              historyTransactionStatus: pendingCommit
                ? 'staged'
                : admitted
                  ? 'committed'
                  : 'rolled_back',
              historyVersion: history.stats().version,
            }
          : {}),
        ...(transaction
          ? {
              artifactTransactionStatus: pendingCommit
                ? 'staged'
                : admitted
                  ? 'committed'
                  : 'rolled_back',
              artifactsStaged: staged,
              artifactsStored: admitted && !pendingCommit ? commit.committedEntries : 0,
              artifactsDiscarded: pendingCommit ? 0 : admitted ? commit.discardedEntries : staged,
            }
          : {}),
        ...(!admitted
          ? {
              reason: cancelled
                ? 'context_compaction_cancelled'
                : stale
                  ? 'stale_context_snapshot'
                  : historyCommit?.reason || plan.diagnostics.reason || 'artifact_commit_failed',
              attemptedFinalBodyBytes: plan.diagnostics.finalBodyBytes,
              attemptedFinalEstimatedTokens: plan.diagnostics.finalEstimatedTokens,
              finalBodyBytes: originalBytes,
              finalEstimatedTokens: originalTokens,
              cleanupSavedBytes: 0,
              droppedMessages: 0,
              continuationSummaryAdded: false,
            }
          : {}),
      },
    };
  } finally {
    finishPlanning();
    if (!pendingCommit) transaction?.rollback();
    if (!pendingCommit) summaryCheckpoints?.rollback();
    localCoordinator?.close();
  }
}

module.exports = {
  MIN_TASK_STATE_PROGRESS_CHARS,
  stateFromCompletion,
  prepareWorkBuddyTaskStateContext,
};
