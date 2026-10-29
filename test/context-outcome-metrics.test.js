'use strict';

const assert = require('node:assert/strict');
const {
  buildWorkBuddyContextOutcome,
  createWorkBuddyContextOutcomeRecorder,
} = require('../lib/proxy/context-outcome-metrics');

const outcome = buildWorkBuddyContextOutcome({
  preflightPlan: {
    changed: true,
    diagnostics: {
      preflightApplied: true,
      cleanupSavedBytes: 9000,
      minimumCleanupSatisfied: true,
      checkpointStatus: 'validated',
      checkpointValid: true,
      stablePrefixPreserved: true,
    },
  },
  retryPlan: {
    changed: true,
    diagnostics: {
      cleanupSavedBytes: 12000,
      minimumCleanupSatisfied: true,
      checkpointStatus: 'validated',
      checkpointValid: true,
      stablePrefixPreserved: true,
      userArchiveStatus: 'committed',
      archivedUserMessages: 6,
    },
  },
  retryAttempted: true,
  artifactReadRounds: 1,
  artifactsResolved: 2,
  artifactsAttempted: 2,
  artifactsDelivered: 2,
  terminalCode: 'completed',
  finalResponse: { ok: true, status: 200, body: 'private response body' },
});

assert.deepEqual(outcome, {
  provider: 'workbuddy',
  preflightApplied: true,
  compactionApplied: true,
  cleanupSavedBytes: 12000,
  minimumCleanupSatisfied: true,
  checkpointStatus: 'validated',
  checkpointValid: true,
  userArchiveStatus: 'committed',
  archivedUserMessages: 6,
  stablePrefixPreserved: true,
  retryAttempted: true,
  retrySucceeded: true,
  artifactReadRounds: 1,
  artifactsResolved: 2,
  artifactsAttempted: 2,
  artifactsUnavailable: 0,
  artifactsBudgetExceeded: 0,
  artifactsDelivered: 2,
  artifactReadSucceeded: true,
  artifactDeliverySucceeded: true,
  finalOk: true,
  finalStatus: 200,
  terminalCode: 'completed',
});
assert.equal(JSON.stringify(outcome).includes('private response body'), false);

const hostile = buildWorkBuddyContextOutcome({
  preflightPlan: {
    diagnostics: {
      cleanupSavedBytes: Infinity,
      checkpointStatus: '<script>',
      stablePrefixPreserved: false,
      userArchiveStatus: 'SECRET_RAW_USER_CONTENT',
      archivedUserMessages: -1,
    },
  },
  retryAttempted: true,
  artifactReadRounds: -1,
  artifactsResolved: Number.MAX_SAFE_INTEGER,
  finalResponse: { ok: false, status: 999, body: 'secret' },
});
assert.equal(hostile.cleanupSavedBytes, 0);
assert.equal(hostile.checkpointStatus, 'invalid');
assert.equal(hostile.artifactReadRounds, 0);
assert.equal(hostile.userArchiveStatus, 'invalid');
assert.equal(hostile.archivedUserMessages, 0);
assert.equal(JSON.stringify(hostile).includes('SECRET'), false);
assert.equal(hostile.artifactsResolved, 1024 * 1024 * 1024);
assert.equal(hostile.retrySucceeded, false);
assert.equal(JSON.stringify(hostile).includes('secret'), false);

const events = [];
const recorder = createWorkBuddyContextOutcomeRecorder(
  (kind, value) => events.push({ kind, value }),
  { diagnostics: {} }
);
recorder.update({
  finalResponse: { ok: true, status: 200, body: 'PRIVATE_BODY' },
  artifactReadRounds: 1,
  artifactsAttempted: 2,
  artifactsResolved: 1,
  artifactsUnavailable: 1,
  artifactsDelivered: 0,
});
recorder.finish(413, 'PRIVATE_TOKEN');
recorder.update({ artifactsDelivered: 1 });
recorder.finish(200, 'completed');
assert.equal(events.length, 1);
assert.equal(events[0].value.finalStatus, 413);
assert.equal(events[0].value.finalOk, false);
assert.equal(events[0].value.artifactReadSucceeded, true);
assert.equal(events[0].value.artifactDeliverySucceeded, false);
assert.equal(events[0].value.terminalCode, 'context_too_large');
assert.ok(!JSON.stringify(events).includes('PRIVATE'));
const expired = buildWorkBuddyContextOutcome({
  artifactReadRounds: 1,
  artifactsAttempted: 1,
  artifactsResolved: 0,
  artifactsUnavailable: 1,
});
assert.equal(expired.artifactReadSucceeded, false);
assert.equal(expired.artifactDeliverySucceeded, false);
assert.doesNotThrow(() => createWorkBuddyContextOutcomeRecorder(null).finish(499));
const {
  createCompactionTiming,
  snapshotCompactionTiming,
  recordCompactionSummaryProgress,
} = require('../lib/proxy/context-compaction-timing');
const failureTiming = createCompactionTiming();
recordCompactionSummaryProgress(failureTiming, 2, 'validation');
const taskMetrics = buildWorkBuddyContextOutcome({
  preflightPlan: {
    diagnostics: {
      taskStateStatus: 'invalid_compaction_candidate',
      taskStateFailureReason: 'summary_requirement_loss',
      taskStateSummaryAttempted: true,
      taskStateRootsConsolidated: true,
      taskStateSummaryReused: false,
      taskStateBackoffApplied: false,
      taskStateRetryAfterMs: 0,
      taskStateSummaryChunks: 3,
      taskStateCheckpointHits: 2,
      taskStateFrontierReused: true,
      taskStateFrontierSourceMessages: 2400,
      taskStateCarriedRequirements: 4,
      taskStatePinnedStates: 1,
      taskStateCheckpointMisses: 1,
      taskStateCheckpointCommitted: false,
      taskStateSummaryProgressSaved: 1,
      taskStateSummaryProgressReused: true,
      compactionTiming: { ...snapshotCompactionTiming(failureTiming), body: 'SECRET' },
    },
  },
});
assert.equal(taskMetrics.taskStateStatus, 'invalid_compaction_candidate');
assert.equal(taskMetrics.taskStateFailureReason, 'summary_requirement_loss');
assert.equal(taskMetrics.taskStateSummaryAttempted, true);
assert.equal(taskMetrics.taskStateRootsConsolidated, true);
assert.equal(taskMetrics.taskStateCheckpointHits, 2);
assert.equal(taskMetrics.taskStateSummaryProgressSaved, 1);
assert.equal(taskMetrics.taskStateSummaryProgressReused, true);
assert.equal(taskMetrics.taskStateCheckpointCommitted, false);
assert.equal(taskMetrics.taskStateFrontierReused, true);
assert.equal(taskMetrics.taskStateFrontierSourceMessages, 2400);
assert.equal(taskMetrics.taskStateCarriedRequirements, 4);
assert.equal(taskMetrics.taskStatePinnedStates, 1);
assert.equal(taskMetrics.compactionTiming.summaryRequests, 0);
assert.equal(taskMetrics.compactionTiming.summaryLastChunk, 2);
assert.equal(taskMetrics.compactionTiming.summaryLastStage, 'validation');
assert.ok(!JSON.stringify(taskMetrics).includes('SECRET'));
const hostileProgress = buildWorkBuddyContextOutcome({
  preflightPlan: {
    diagnostics: {
      compactionTiming: {
        ...snapshotCompactionTiming(failureTiming),
        summaryLastStage: 'SECRET provider response',
      },
    },
  },
});
assert.equal(hostileProgress.compactionTiming.valid, false);
assert.equal(hostileProgress.compactionTiming.summaryLastChunk, undefined);
assert.ok(!JSON.stringify(hostileProgress).includes('SECRET'));
let hooks = 0;
const diagnostics = {
  taskStateStatus: 'SECRET',
  taskStateRootsConsolidated: 'SECRET',
  taskStateFailureReason: 'SECRET',
  taskStateSummaryChunks: Infinity,
  taskStateCheckpointHits: 999,
  taskStateFrontierReused: 'SECRET',
  taskStateFrontierSourceMessages: 999999,
  taskStateCarriedRequirements: 999999,
  taskStatePinnedStates: Infinity,
  taskStateSummaryProgressSaved: Infinity,
  taskStateSummaryProgressReused: 'SECRET',
  taskStateRetryAfterMs: 999999,
  taskStateSummaryAttempted: {
    valueOf() {
      hooks++;
      return true;
    },
  },
};
Object.defineProperty(diagnostics, 'compactionTiming', {
  get() {
    hooks++;
    return 'SECRET';
  },
});
const safeTask = buildWorkBuddyContextOutcome({ retryPlan: { diagnostics } });
assert.equal(safeTask.taskStateStatus, 'invalid');
assert.equal(safeTask.taskStateRootsConsolidated, false);
assert.equal(safeTask.taskStateFailureReason, undefined);
assert.equal(safeTask.taskStateSummaryChunks, 0);
assert.equal(safeTask.taskStateCheckpointHits, 16);
assert.equal(safeTask.taskStateFrontierReused, false);
assert.equal(safeTask.taskStateFrontierSourceMessages, 16384);
assert.equal(safeTask.taskStateCarriedRequirements, 32);
assert.equal(safeTask.taskStatePinnedStates, 0);
assert.equal(safeTask.taskStateSummaryProgressSaved, 0);
assert.equal(safeTask.taskStateSummaryProgressReused, false);
assert.equal(safeTask.taskStateRetryAfterMs, 30000);
assert.equal(safeTask.taskStateSummaryAttempted, false);
assert.equal(safeTask.compactionTiming, undefined);
assert.equal(hooks, 0);
assert.ok(!JSON.stringify(safeTask).includes('SECRET'));
console.log('[context-outcome-metrics.test] ok');
