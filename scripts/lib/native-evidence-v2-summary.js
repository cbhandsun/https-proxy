'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { summarizeNativeEvidenceCandidate } = require('./native-evidence-candidate-summary');

function summarizeNativeEvidenceV2(input) {
  let r;
  try {
    r = normalizeCompactionData(input, 2 * 1024 * 1024);
  } catch {
    return { observationValid: false };
  }
  if (
    r?.schema !== 'hpm.context.native-evidence-v2-candidate' ||
    r.version !== 2 ||
    r.fixedWorkload?.kind !== 'native_paged_evidence_readback_candidate' ||
    r.fixedWorkload.version !== 2 ||
    r.fixedWorkload.nativePrintApi !== 'text' ||
    r.fixedWorkload.nativeOutputPolicy !== 'code-mode-page'
  )
    return { observationValid: false };
  const base = summarizeNativeEvidenceCandidate({
    ...r,
    schema: 'hpm.context.native-evidence-candidate',
    fixedWorkload: { ...r.fixedWorkload, kind: 'retained_evidence_readback_candidate' },
  });
  if (!base.observationValid) return base;
  const oracleCount = Array.isArray(r.toolDiagnostics?.toolReplies)
    ? r.toolDiagnostics.toolReplies.filter((item) => item?.tool === 'hpm_verify_state').length
    : 0;
  const readItemsComplete =
    r.completedDynamicReadItems === base.retainedPageReplyCount &&
    base.retainedPageReplyCount === 13;
  const batches = r.transport.map((row) => row.maxRetainedPagesPerCodeModeOutput);
  const pagedPolicyObserved = batches.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1);
  const compactionQualified =
    r.benchmarkArm === 'control'
      ? base.nativeCompactionRequests === 0
      : base.validCompletedCompactions >= 2 &&
        base.allRequestedCompactionsCompleted &&
        base.nativeAutoCompactionObserved &&
        base.opaqueCheckpointReused;
  const budget = r.requestBudget;
  const budgetHonored =
    budget?.reservedRequests === r.transport.length &&
    budget?.priorRequests === (r.benchmarkArm === 'control' ? 32 : 40) &&
    budget?.cumulativeLimit === (r.benchmarkArm === 'control' ? 62 : 70) &&
    budget.reservedRequests <= 30;
  const nativeAcceptancePassed =
    base.stateOraclePassed &&
    oracleCount === 1 &&
    r.finalStateCorrect === true &&
    base.allPagesRead &&
    base.fullEvidenceEnteredNativeInput &&
    base.sourceReadbackComplete &&
    base.allRetainedPagesEnteredInput &&
    readItemsComplete &&
    pagedPolicyObserved &&
    base.parallelBranchesObserved &&
    compactionQualified &&
    base.completeUsage &&
    base.providerRouteVerified &&
    base.guardedFilesUnchanged &&
    base.isolatedProcessesTerminal &&
    base.completedRequests === base.requestCount &&
    base.requestCount > 0 &&
    r.toolFailureCount === 0 &&
    r.unsafeToolRequests === 0 &&
    r.failureCode === null &&
    budgetHonored &&
    r.loopbackServerTerminal === true &&
    r.realNativeClient === true &&
    r.nativeEphemeralThreads === 1 &&
    Array.isArray(r.turns) &&
    r.turns.length === 3 &&
    r.turns.every((turn) => turn?.completed === true);
  return {
    ...base,
    candidateVersion: 2,
    matchedToHistoricalCandidate: false,
    completedDynamicReadItems: r.completedDynamicReadItems ?? null,
    readItemsComplete,
    pagedPolicyObserved,
    oracleCount,
    budgetHonored,
    compactionQualified,
    nativeAcceptancePassed,
    allRetainedPagesEnteredGenerationInput:
      base.retainedPageReplyCount === 13 && base.retainedPageRepliesEnteredGenerationInput === 13,
    installedClientIntegrationVerified: false,
    productionDeliveryVerified: false,
    matchedLatencyOrEconomicsVerified: false,
  };
}

module.exports = { summarizeNativeEvidenceV2 };
