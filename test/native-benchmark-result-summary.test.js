'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  summarizeNativeBenchmarkResult,
} = require('../scripts/lib/native-benchmark-result-summary');

function row(compact = false) {
  return {
    compact,
    status: 200,
    responseCompletedEvents: 1,
    responseFailedEvents: 0,
    usage: {
      inputTokens: 8,
      outputTokens: 2,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 0,
      totalTokens: 10,
    },
    ...(compact
      ? {
          validNativeWindow: true,
          nativeObservation: { valid: true, doneCount: 1, completedCount: 1, failureCode: null },
        }
      : {}),
  };
}
function report() {
  return {
    schema: 'hpm.context.native-fixed-benchmark',
    benchmarkArm: 'compact',
    fixedWorkload: { kind: 'fixed_tool_result_heavy_readonly_audit', pageCount: 4 },
    passed: false,
    compactionStarted: false,
    compactionCompleted: false,
    compactionInvoker: 'native-auto-threshold',
    manualCompactionRpcCalls: 0,
    nativeCheckpointReused: true,
    nativeCheckpointItemEqual: false,
    compactionChainReuseChecks: [true, true],
    transport: [row(), row(true), row(true)],
    toolDiagnostics: {
      pagesRead: 4,
      allPagesRead: true,
      toolReplies: [{ tool: 'hpm_verify_state', correct: false }],
    },
    toolConcurrency: { parallelBranchesObserved: false, maxPendingBranches: 1, pendingBranches: 0 },
    verifiedRouteCount: 3,
    providerRouteVerified: true,
    guardedFilesUnchanged: true,
    nativeProcessTerminal: true,
    isolatedProxyTerminal: true,
  };
}

test('failure path preserves two valid automatic cycles without relabeling task verdict', () => {
  const source = report();
  source.transport.push({
    compact: true,
    status: null,
    responseCompletedEvents: 0,
    responseFailedEvents: 0,
  });
  source.transport[0].exactToolEvidence = Array.from({ length: 7 }, (_, index) => ({
    index,
    observed: true,
  }));
  source.fullEvidenceEnteredNativeInput = false;
  const before = JSON.stringify(source);
  const result = summarizeNativeBenchmarkResult(source);
  assert.equal(result.requestCount, 4);
  assert.equal(result.completedRequests, 3);
  assert.equal(result.validCompletedCompactions, 2);
  assert.equal(result.unknownOrFailedCompactionRequests, 1);
  assert.equal(result.nativeAutoCompactionObserved, true);
  assert.equal(result.allRequestedCompactionsCompleted, false);
  assert.equal(result.opaqueCheckpointReused, true);
  assert.equal(result.entireCheckpointItemEqual, false);
  assert.equal(result.fullEvidenceEnteredNativeInput, true);
  assert.equal(result.allPagesRead, true);
  assert.equal(result.parallelBranchesObserved, false);
  assert.equal(result.originalVerdictPassed, false);
  assert.equal(result.stateOraclePassed, false);
  assert.equal(result.oracleFieldDiagnosticsAvailable, false);
  assert.equal(result.oracleMismatchFields, null);
  assert.equal(result.completeUsage, false);
  assert.ok(Object.values(result.usageTotals).every((value) => value === null));
  assert.equal(result.providerRouteVerified, false);
  assert.equal(JSON.stringify(source), before);
});

test('complete observations qualify only their own measured gates', () => {
  const source = report();
  source.passed = true;
  source.toolDiagnostics.toolReplies = [
    {
      tool: 'hpm_verify_state',
      correct: true,
      evidenceComplete: true,
      mismatchFields: [],
      extraFieldCount: 0,
    },
  ];
  source.toolConcurrency = {
    parallelBranchesObserved: true,
    maxPendingBranches: 2,
    pendingBranches: 0,
  };
  source.nativeCheckpointItemEqual = true;
  const result = summarizeNativeBenchmarkResult(source);
  assert.equal(result.originalVerdictPassed, true);
  assert.equal(result.stateOraclePassed, true);
  assert.equal(result.oracleFieldDiagnosticsAvailable, true);
  assert.deepEqual(result.oracleMismatchFields, []);
  assert.equal(result.oracleExtraFieldCount, 0);
  assert.equal(result.allRequestedCompactionsCompleted, true);
  assert.equal(result.entireCheckpointItemEqual, true);
  assert.equal(result.parallelBranchesObserved, true);
  assert.equal(result.completeUsage, true);
  assert.equal(result.usageTotals.totalTokens, 30);
  assert.equal(result.providerRouteVerified, true);
  assert.equal(result.guardedFilesUnchanged, true);
  assert.equal(result.isolatedProcessesTerminal, true);
  assert.equal(result.fullEvidenceEnteredNativeInput, false);
});

test('empty, malformed, extreme and unsafe sources fail closed without invoking getters', () => {
  let called = 0;
  const unsafe = {
    get schema() {
      called++;
      return 'private';
    },
  };
  const cycle = {};
  cycle.self = cycle;
  for (const input of [
    undefined,
    null,
    [],
    {},
    unsafe,
    cycle,
    { text: 'x'.repeat(2 * 1024 * 1024) },
    { ...report(), transport: [null] },
    { ...report(), transport: [{ compact: 'true' }] },
    { ...report(), transport: Array.from({ length: 1001 }, () => ({ compact: true })) },
    { ...report(), benchmarkArm: 'unknown' },
    { ...report(), fixedWorkload: null },
  ])
    assert.deepEqual(summarizeNativeBenchmarkResult(input), { observationValid: false });
  assert.equal(called, 0);
  const empty = summarizeNativeBenchmarkResult({ ...report(), transport: [] });
  assert.equal(empty.validCompletedCompactions, 0);
  assert.equal(empty.completeUsage, false);
  assert.equal(empty.providerRouteVerified, false);
  assert.equal(empty.opaqueCheckpointReused, false);
});

test('HTTP success alone and inconsistent checkpoint observations never qualify cycles', () => {
  for (const overrides of [
    { status: 400 },
    { responseCompletedEvents: 0 },
    { responseFailedEvents: 1 },
    { validNativeWindow: false },
    { nativeObservation: undefined },
    { nativeObservation: { valid: true, doneCount: 2, completedCount: 1, failureCode: null } },
    { nativeObservation: { valid: true, doneCount: 1, completedCount: 2, failureCode: null } },
    { nativeObservation: { valid: true, doneCount: 1, completedCount: 1, failureCode: 'error' } },
  ]) {
    const candidate = { ...row(true), ...overrides };
    if (candidate.nativeObservation === undefined) delete candidate.nativeObservation;
    const result = summarizeNativeBenchmarkResult({ ...report(), transport: [candidate] });
    assert.equal(result.validCompletedCompactions, 0);
    assert.equal(result.nativeAutoCompactionObserved, false);
  }
  for (const overrides of [
    { manualCompactionRpcCalls: 1 },
    { compactionInvoker: 'manual' },
    { benchmarkArm: 'control' },
  ])
    assert.equal(
      summarizeNativeBenchmarkResult({ ...report(), ...overrides }).nativeAutoCompactionObserved,
      false
    );
});

test('unknown oracle fields, raw user content, encrypted checkpoints and credentials are excluded', () => {
  const secret = 'private-secret-value';
  const source = report();
  source.toolDiagnostics.toolReplies = [
    {
      tool: 'hpm_verify_state',
      correct: false,
      evidenceComplete: true,
      mismatchFields: ['color', secret],
      extraFieldCount: 1,
      actualValue: secret,
    },
  ];
  source.transport[0].headers = { authorization: secret };
  source.transport[0].encrypted_content = secret;
  source.transport[0].exactToolEvidence = [
    { index: 7, observed: true },
    { index: 0, observed: false },
    { index: -1, observed: true },
  ];
  source.error = secret;
  let result = summarizeNativeBenchmarkResult(source);
  assert.equal(result.oracleFieldDiagnosticsAvailable, false);
  assert.equal(result.exactEvidenceInputReplies, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  source.toolDiagnostics.toolReplies[0].mismatchFields = ['color'];
  result = summarizeNativeBenchmarkResult(source);
  assert.deepEqual(result.oracleMismatchFields, ['color']);
  assert.equal(JSON.stringify(result).includes(secret), false);
  source.toolDiagnostics.toolReplies.push({ tool: 'hpm_verify_state', correct: true });
  assert.equal(summarizeNativeBenchmarkResult(source).stateOraclePassed, false);
});

test('missing and extreme usage, incomplete paging and unsupported parallel claims remain unqualified', () => {
  const source = report();
  source.toolDiagnostics = {};
  source.toolConcurrency = {
    parallelBranchesObserved: true,
    maxPendingBranches: 1,
    pendingBranches: 1,
  };
  source.compactionChainReuseChecks = [true, false];
  source.guardedFilesUnchanged = false;
  source.nativeProcessTerminal = false;
  source.transport[0].usage.inputTokens = -1;
  let result = summarizeNativeBenchmarkResult(source);
  assert.equal(result.pagesRead, null);
  assert.equal(result.allPagesRead, false);
  assert.equal(result.parallelBranchesObserved, false);
  assert.equal(result.opaqueCheckpointReused, false);
  assert.equal(result.guardedFilesUnchanged, false);
  assert.equal(result.isolatedProcessesTerminal, false);
  assert.equal(result.completeUsage, false);
  source.transport[0].usage.inputTokens = Number.MAX_SAFE_INTEGER;
  result = summarizeNativeBenchmarkResult(source);
  assert.equal(result.completeUsage, false);
  assert.equal(result.usageTotals.inputTokens, null);
  source.transport[0].usage.inputTokens = 8;
  source.transport[0].exactToolEvidence = { observed: true };
  source.toolConcurrency = {
    parallelBranchesObserved: true,
    maxPendingBranches: 2,
    pendingBranches: 1,
  };
  assert.equal(summarizeNativeBenchmarkResult(source).parallelBranchesObserved, false);
});
