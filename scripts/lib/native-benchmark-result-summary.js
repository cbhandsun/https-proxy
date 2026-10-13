'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { NATIVE_BENCHMARK_STATE_FIELDS } = require('./native-compaction-benchmark-workload');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'totalTokens',
];
const terminal = (row) =>
  row.status === 200 && row.responseCompletedEvents === 1 && row.responseFailedEvents === 0;
const validCompaction = (row) =>
  terminal(row) &&
  row.validNativeWindow === true &&
  row.nativeObservation?.valid === true &&
  row.nativeObservation.doneCount === 1 &&
  row.nativeObservation.completedCount === 1 &&
  row.nativeObservation.failureCode === null;

// Read completed observations even when the task failed before main's success
// assignments. This is a content-free mechanism summary, never a replacement
// for the original verdict or a matched control/economics qualification.
function summarizeNativeBenchmarkResult(input) {
  let report;
  try {
    report = normalizeCompactionData(input, 2 * 1024 * 1024);
  } catch {
    return { observationValid: false };
  }
  if (
    !record(report) ||
    report.schema !== 'hpm.context.native-fixed-benchmark' ||
    !['control', 'compact'].includes(report.benchmarkArm) ||
    report.fixedWorkload?.kind !== 'fixed_tool_result_heavy_readonly_audit' ||
    !Array.isArray(report.transport) ||
    report.transport.length > 1000 ||
    report.transport.some((row) => !record(row) || typeof row.compact !== 'boolean')
  )
    return { observationValid: false };

  const rows = report.transport;
  const compactions = rows.filter((row) => row.compact);
  const validCycles = compactions.filter(validCompaction).length;
  const observedEvidence = new Set();
  for (const row of rows) {
    if (!Array.isArray(row.exactToolEvidence)) continue;
    for (const item of row.exactToolEvidence) {
      if (record(item) && item.observed === true && count(item.index) && item.index < 7)
        observedEvidence.add(item.index);
    }
  }
  const toolReplies = report.toolDiagnostics?.toolReplies;
  const oracles = Array.isArray(toolReplies)
    ? toolReplies.filter((item) => record(item) && item.tool === 'hpm_verify_state')
    : [];
  const oracle = oracles.length === 1 ? oracles[0] : null;
  const diagnosticAvailable =
    record(oracle) &&
    typeof oracle.evidenceComplete === 'boolean' &&
    count(oracle.extraFieldCount) &&
    Array.isArray(oracle.mismatchFields) &&
    oracle.mismatchFields.every((field) => NATIVE_BENCHMARK_STATE_FIELDS.includes(field));
  const measured = rows.filter((row) => USAGE_FIELDS.every((field) => count(row.usage?.[field])));
  const usageTotals = Object.fromEntries(
    USAGE_FIELDS.map((field) => {
      const total = measured.reduce((sum, row) => sum + row.usage[field], 0);
      return [
        field,
        rows.length > 0 && measured.length === rows.length && count(total) ? total : null,
      ];
    })
  );
  const chain = report.compactionChainReuseChecks;
  const reused =
    validCycles > 0 &&
    report.nativeCheckpointReused === true &&
    Array.isArray(chain) &&
    chain.length > 0 &&
    chain.every((check) => check === true);
  const pending = report.toolConcurrency;
  return {
    observationValid: true,
    originalVerdictPassed: report.passed === true,
    requestCount: rows.length,
    completedRequests: rows.filter(terminal).length,
    nativeCompactionRequests: compactions.length,
    validCompletedCompactions: validCycles,
    unknownOrFailedCompactionRequests: compactions.length - validCycles,
    nativeAutoCompactionObserved:
      validCycles > 0 &&
      report.benchmarkArm === 'compact' &&
      report.compactionInvoker === 'native-auto-threshold' &&
      report.manualCompactionRpcCalls === 0,
    allRequestedCompactionsCompleted: compactions.length > 0 && validCycles === compactions.length,
    opaqueCheckpointReused: reused,
    entireCheckpointItemEqual: reused && report.nativeCheckpointItemEqual === true,
    pagesRead: count(report.toolDiagnostics?.pagesRead) ? report.toolDiagnostics.pagesRead : null,
    allPagesRead:
      report.fixedWorkload.pageCount === 4 &&
      report.toolDiagnostics?.pagesRead === 4 &&
      report.toolDiagnostics.allPagesRead === true,
    exactEvidenceInputReplies: observedEvidence.size,
    fullEvidenceEnteredNativeInput: observedEvidence.size === 7,
    parallelBranchesObserved:
      pending?.parallelBranchesObserved === true &&
      count(pending.maxPendingBranches) &&
      pending.maxPendingBranches >= 2 &&
      pending.pendingBranches === 0,
    stateOraclePassed: oracle?.correct === true,
    oracleFieldDiagnosticsAvailable: diagnosticAvailable,
    oracleMismatchFields: diagnosticAvailable ? [...oracle.mismatchFields] : null,
    oracleExtraFieldCount: diagnosticAvailable ? oracle.extraFieldCount : null,
    usageMeasuredRequests: measured.length,
    completeUsage: rows.length > 0 && USAGE_FIELDS.every((field) => usageTotals[field] !== null),
    usageTotals,
    providerRouteVerified:
      rows.length > 0 &&
      report.providerRouteVerified === true &&
      report.verifiedRouteCount === rows.length,
    guardedFilesUnchanged: report.guardedFilesUnchanged === true,
    isolatedProcessesTerminal:
      report.nativeProcessTerminal === true && report.isolatedProxyTerminal === true,
  };
}

module.exports = { summarizeNativeBenchmarkResult };
