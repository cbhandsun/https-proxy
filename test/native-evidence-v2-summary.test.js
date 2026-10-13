'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { summarizeNativeEvidenceV2 } = require('../scripts/lib/native-evidence-v2-summary');
function fixture(arm = 'control') {
  const retained = Array.from({ length: 13 }, (_, index) => ({
    index,
    bytes: 12,
    sha256: 'a'.repeat(64),
  }));
  const row = () => ({
    compact: false,
    status: 200,
    responseCompletedEvents: 1,
    responseFailedEvents: 0,
    maxRetainedPagesPerCodeModeOutput: 1,
    exactRetainedEvidence: retained.map((r) => ({ ...r, observed: true })),
    exactToolEvidence: Array.from({ length: 7 }, (_, index) => ({ index, observed: true })),
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
  });
  const rows = [row()];
  if (arm === 'compact')
    for (let i = 0; i < 2; i++)
      rows.push({
        ...row(),
        compact: true,
        validNativeWindow: true,
        nativeObservation: { valid: true, doneCount: 1, completedCount: 1, failureCode: null },
      });
  return {
    schema: 'hpm.context.native-evidence-v2-candidate',
    version: 2,
    benchmarkArm: arm,
    fixedWorkload: {
      kind: 'native_paged_evidence_readback_candidate',
      version: 2,
      nativePrintApi: 'text',
      nativeOutputPolicy: 'code-mode-page',
      fixedNoRereadComparison: false,
      pageCount: 4,
    },
    transport: rows,
    toolDiagnostics: {
      retainedPageReplies: retained,
      readbackComplete: true,
      pagesRead: 4,
      allPagesRead: true,
      toolReplies: [{ tool: 'hpm_verify_state', correct: true }],
    },
    toolConcurrency: { parallelBranchesObserved: true, maxPendingBranches: 2, pendingBranches: 0 },
    completedDynamicReadItems: 13,
    finalStateCorrect: true,
    compactionInvoker: 'native-auto-threshold',
    manualCompactionRpcCalls: 0,
    nativeCheckpointReused: true,
    compactionChainReuseChecks: [true],
    providerRouteVerified: true,
    verifiedRouteCount: rows.length,
    guardedFilesUnchanged: true,
    nativeProcessTerminal: true,
    isolatedProxyTerminal: true,
    loopbackServerTerminal: true,
    realNativeClient: true,
    nativeEphemeralThreads: 1,
    turns: Array.from({ length: 3 }, () => ({ completed: true })),
    toolFailureCount: 0,
    unsafeToolRequests: 0,
    failureCode: null,
    requestBudget: {
      reservedRequests: rows.length,
      priorRequests: arm === 'control' ? 32 : 40,
      cumulativeLimit: arm === 'control' ? 62 : 70,
    },
  };
}
test('V2 exact gates qualify both arms without claiming integration/economics', () => {
  for (const arm of ['control', 'compact']) {
    const r = fixture(arm);
    const original = JSON.stringify(r);
    const s = summarizeNativeEvidenceV2(r);
    assert.equal(s.nativeAcceptancePassed, true);
    assert.equal(s.installedClientIntegrationVerified, false);
    assert.equal(s.matchedLatencyOrEconomicsVerified, false);
    assert.equal(JSON.stringify(r), original);
  }
});
test('each safety/evidence/native gate stays strict, including missing diagnostics regression', () => {
  for (const mutate of [
    (r) => {
      delete r.toolDiagnostics.toolReplies;
    },
    (r) => {
      r.toolDiagnostics.toolReplies = null;
    },
    (r) => {
      r.toolDiagnostics.toolReplies.push({ tool: 'hpm_verify_state', correct: true });
    },
    (r) => {
      r.completedDynamicReadItems = 12;
    },
    (r) => {
      r.transport[0].maxRetainedPagesPerCodeModeOutput = 2;
    },
    (r) => {
      r.transport[0].usage.cachedInputTokens = null;
    },
    (r) => {
      r.unsafeToolRequests = 1;
    },
    (r) => {
      r.toolFailureCount = 1;
    },
    (r) => {
      r.nativeCheckpointReused = false;
    },
    (r) => {
      r.toolConcurrency.parallelBranchesObserved = false;
    },
    (r) => {
      r.requestBudget.reservedRequests = 31;
    },
    (r) => {
      r.finalStateCorrect = false;
    },
    (r) => {
      r.failureCode = 'failed';
    },
    (r) => {
      r.turns.pop();
    },
    (r) => {
      r.loopbackServerTerminal = false;
    },
    (r) => {
      r.transport[0].exactRetainedEvidence.pop();
    },
    (r) => {
      r.transport[1].nativeObservation.valid = false;
    },
  ]) {
    const r = fixture('compact');
    mutate(r);
    // Other requests must not mask the one missing envelope mutation.
    if (r.transport[0].exactRetainedEvidence.length === 12)
      for (const row of r.transport)
        row.exactRetainedEvidence = r.transport[0].exactRetainedEvidence;
    assert.equal(summarizeNativeEvidenceV2(r).nativeAcceptancePassed, false);
  }
  const missing = fixture();
  delete missing.toolDiagnostics;
  assert.equal(summarizeNativeEvidenceV2(missing).nativeAcceptancePassed, false);
  const control = fixture();
  control.transport[0].compact = true;
  assert.equal(summarizeNativeEvidenceV2(control).nativeAcceptancePassed, false);
});
test('wrong schemas and hostile inputs cannot execute hooks or disclose content', () => {
  let invoked = 0;
  const hostile = Object.defineProperty({}, 'schema', {
    enumerable: true,
    get() {
      invoked++;
      return null;
    },
  });
  for (const r of [null, {}, [], hostile, { schema: 'wrong' }])
    assert.deepEqual(summarizeNativeEvidenceV2(r), { observationValid: false });
  assert.equal(invoked, 0);
  const r = fixture();
  r.private = 'secret';
  assert.equal(JSON.stringify(summarizeNativeEvidenceV2(r)).includes('secret'), false);
});
