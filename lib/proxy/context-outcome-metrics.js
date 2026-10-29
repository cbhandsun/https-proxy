'use strict';

const { safeCompactionFailureReason } = require('./context-compaction-failure');
const { sanitizeCompactionTiming } = require('./context-compaction-timing');

const TASK_STATE_STATUSES = new Set([
  'not_needed',
  'background_pending',
  'applied',
  'cancelled',
  'commit_rejected',
  'required_context_too_large',
  'source_unavailable',
  'summarizer_unavailable',
  'stale_snapshot',
  'state_budget_rejected',
  'state_too_large',
  'compaction_busy',
  'compaction_cancelled',
  'compaction_clock_invalid',
  'compaction_closed',
  'compaction_id_conflict',
  'compaction_timeout',
  'invalid_compaction_candidate',
  'invalid_compaction_request',
]);

function safeTaskStateMetrics(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return {};
  const field = (name) => Object.getOwnPropertyDescriptor(value, name)?.value;
  const result = {};
  const status = field('taskStateStatus');
  if (status !== undefined)
    result.taskStateStatus = TASK_STATE_STATUSES.has(status) ? status : 'invalid';
  const failure = safeCompactionFailureReason(field('taskStateFailureReason'));
  if (failure) result.taskStateFailureReason = failure;
  for (const name of [
    'taskStateSummaryAttempted',
    'taskStateSummaryReused',
    'taskStateBackoffApplied',
    'taskStateCheckpointCommitted',
    'taskStateFrontierReused',
    'taskStateSummaryProgressReused',
    'taskStateRootsConsolidated',
  ])
    if (field(name) !== undefined) result[name] = field(name) === true;
  for (const name of [
    'taskStateSummaryChunks',
    'taskStateCheckpointHits',
    'taskStateCheckpointMisses',
    'taskStateSummaryProgressSaved',
    'taskStateRetryAfterMs',
    'taskStateFrontierSourceMessages',
    'taskStateCarriedRequirements',
    'taskStatePinnedStates',
  ]) {
    const number = field(name);
    if (number === undefined) continue;
    const maximum =
      name === 'taskStateRetryAfterMs'
        ? 30000
        : ['taskStateFrontierSourceMessages', 'taskStatePinnedStates'].includes(name)
          ? 16384
          : name === 'taskStateCarriedRequirements'
            ? 32
            : 16;
    result[name] = Number.isSafeInteger(number) && number >= 0 ? Math.min(number, maximum) : 0;
  }
  const timing = sanitizeCompactionTiming(field('compactionTiming'));
  if (timing) result.compactionTiming = timing;
  return result;
}

const MAX_METRIC_VALUE = 1024 * 1024 * 1024;
const CHECKPOINT_STATUSES = new Set([
  'not_needed',
  'unavailable',
  'removed_for_budget',
  'validated',
  'invalid',
]);
const USER_ARCHIVE_STATUSES = new Set([
  'not_requested',
  'not_eligible_or_not_needed',
  'selected',
  'coverage_or_storage_unavailable',
  'staged',
  'committed',
  'rolled_back',
]);
const TERMINAL_CODES = new Set([
  'completed',
  'context_too_large',
  'client_disconnected',
  'downstream_stream_error',
  'downstream_stream_drain_timeout',
  'downstream_stream_buffer_limit',
  'downstream_stream_write_error',
  'context_artifact_read_limit',
  'context_artifact_read_loop',
  'context_artifact_invalid_turn',
  'context_artifact_recovery_failed',
  'context_tool_catalog_unavailable',
  'context_tool_discovery_invalid_turn',
  'context_tool_discovery_invalid_arguments',
  'context_tool_discovery_loop',
  'context_tool_discovery_limit',
  'context_tool_schema_limit',
  'context_tool_discovery_cancelled',
  'context_tool_publication_failed',
  'conversion_failed',
  'upstream_error',
  'request_failed',
]);

function boundedInteger(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
  return Math.min(numeric, MAX_METRIC_VALUE);
}

function checkpointStatus(value) {
  const normalized = String(value || 'not_needed');
  return CHECKPOINT_STATUSES.has(normalized) ? normalized : 'invalid';
}

function successfulResponse(response) {
  return !!(
    response &&
    response.ok === true &&
    Number.isInteger(response.status) &&
    response.status >= 200 &&
    response.status < 300
  );
}

function buildWorkBuddyContextOutcome(options = {}) {
  const preflight = options.preflightPlan?.diagnostics || {};
  const retry = options.retryPlan?.diagnostics || null;
  const effective = retry || preflight;
  const artifactReadRounds = boundedInteger(options.artifactReadRounds);
  const artifactsResolved = boundedInteger(options.artifactsResolved);
  const artifactsDelivered = boundedInteger(options.artifactsDelivered);
  const finalStatus =
    Number.isInteger(options.finalStatus) &&
    options.finalStatus >= 100 &&
    options.finalStatus <= 599
      ? options.finalStatus
      : boundedInteger(options.finalResponse?.status);
  return {
    provider: 'workbuddy',
    preflightApplied: preflight.preflightApplied === true,
    compactionApplied:
      options.preflightPlan?.changed === true || options.retryPlan?.changed === true,
    cleanupSavedBytes: boundedInteger(effective.cleanupSavedBytes),
    minimumCleanupSatisfied: effective.minimumCleanupSatisfied !== false,
    checkpointStatus: checkpointStatus(effective.checkpointStatus),
    checkpointValid: effective.checkpointValid === true,
    userArchiveStatus:
      effective.userArchiveStatus === undefined
        ? 'not_requested'
        : USER_ARCHIVE_STATUSES.has(effective.userArchiveStatus)
          ? effective.userArchiveStatus
          : 'invalid',
    archivedUserMessages: boundedInteger(effective.archivedUserMessages),
    ...safeTaskStateMetrics(effective),
    stablePrefixPreserved: effective.stablePrefixPreserved !== false,
    retryAttempted: options.retryAttempted === true,
    retrySucceeded:
      options.retryAttempted === true &&
      (options.retrySucceeded === true || successfulResponse(options.finalResponse)),
    artifactReadRounds,
    artifactsResolved,
    artifactsAttempted: boundedInteger(options.artifactsAttempted),
    artifactsUnavailable: boundedInteger(options.artifactsUnavailable),
    artifactsBudgetExceeded: boundedInteger(options.artifactsBudgetExceeded),
    artifactsDelivered,
    artifactReadSucceeded: artifactReadRounds > 0 && artifactsResolved > 0,
    artifactDeliverySucceeded: artifactsDelivered > 0,
    finalOk: successfulResponse(options.finalResponse) && finalStatus >= 200 && finalStatus < 300,
    finalStatus,
    terminalCode: TERMINAL_CODES.has(options.terminalCode)
      ? options.terminalCode
      : 'request_failed',
  };
}

function createWorkBuddyContextOutcomeRecorder(logEvent, preflightPlan) {
  const state = { preflightPlan };
  let finished = false;
  return {
    update(value) {
      if (!finished) Object.assign(state, value);
    },
    finish(status, code) {
      if (finished) return;
      finished = true;
      const fallback =
        status === 413
          ? 'context_too_large'
          : status === 499
            ? 'client_disconnected'
            : status >= 200 && status < 300
              ? 'completed'
              : successfulResponse(state.finalResponse) ||
                  (state.finalResponse?.ok === true &&
                    Number.isInteger(state.finalResponse.status) &&
                    state.finalResponse.status >= 400)
                ? 'upstream_error'
                : 'request_failed';
      if (typeof logEvent === 'function')
        logEvent(
          'workbuddy_context_outcome',
          buildWorkBuddyContextOutcome({
            ...state,
            finalStatus: status,
            terminalCode: TERMINAL_CODES.has(code) ? code : fallback,
          })
        );
    },
  };
}

module.exports = { buildWorkBuddyContextOutcome, createWorkBuddyContextOutcomeRecorder };
