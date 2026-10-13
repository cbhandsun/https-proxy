'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  summarizeNativeEvidenceCandidate,
} = require('../scripts/lib/native-evidence-candidate-summary');
const {
  summarizeNativeBenchmarkResult,
} = require('../scripts/lib/native-benchmark-result-summary');

function fixture() {
  const receipt = { index: 0, bytes: 42, sha256: 'a'.repeat(64) };
  return {
    schema: 'hpm.context.native-evidence-candidate',
    benchmarkArm: 'compact',
    passed: false,
    fixedWorkload: {
      kind: 'retained_evidence_readback_candidate',
      fixedNoRereadComparison: false,
      pageCount: 4,
    },
    transport: [
      {
        compact: false,
        status: 200,
        responseCompletedEvents: 1,
        responseFailedEvents: 0,
        exactRetainedEvidence: [{ ...receipt, observed: true }],
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 12,
        },
      },
    ],
    toolDiagnostics: { readbackComplete: true, retainedPageReplies: [receipt], toolReplies: [] },
  };
}

test('candidate read-back observation does not rewrite old schema, native gates or verdict', () => {
  const report = fixture();
  const before = JSON.stringify(report);
  const result = summarizeNativeEvidenceCandidate(report);
  assert.equal(result.observationValid, true);
  assert.equal(result.sourceReadbackComplete, true);
  assert.equal(result.allRetainedPagesEnteredInput, true);
  assert.equal(result.retainedPageRepliesEnteredInput, 1);
  assert.equal(result.retainedPageRepliesEnteredGenerationInput, 1);
  assert.equal(result.retainedPageRepliesEnteredCompactionInput, 0);
  assert.equal(result.originalVerdictPassed, false);
  assert.equal(result.validCompletedCompactions, 0);
  assert.equal(result.stateOraclePassed, false);
  assert.equal(result.comparableToHistoricalFixedWorkload, false);
  assert.equal(result.installedClientIntegrationVerified, false);
  assert.equal(summarizeNativeBenchmarkResult(report).observationValid, false);
  assert.equal(JSON.stringify(report), before);
});

test('raw evidence in a compaction request is not raw evidence in a later generation request', () => {
  const report = fixture();
  report.transport[0].compact = true;
  const result = summarizeNativeEvidenceCandidate(report);
  assert.equal(result.retainedPageRepliesEnteredGenerationInput, 0);
  assert.equal(result.retainedPageRepliesEnteredCompactionInput, 1);
  assert.equal(result.allRetainedPagesEnteredInput, true);
  assert.equal(result.validCompletedCompactions, 0);
});

test('missing, partial, mismatched, invalid and extreme observations never qualify read-back entry', () => {
  for (const mutation of [
    (r) => {
      r.toolDiagnostics.retainedPageReplies = [];
    },
    (r) => {
      delete r.toolDiagnostics.retainedPageReplies;
    },
    (r) => {
      r.toolDiagnostics.retainedPageReplies[0].bytes = -1;
    },
    (r) => {
      r.toolDiagnostics.retainedPageReplies[0].sha256 = 'secret';
    },
    (r) => {
      r.toolDiagnostics.retainedPageReplies[0].index = 2;
    },
    (r) => {
      r.transport[0].exactRetainedEvidence[0].observed = false;
    },
    (r) => {
      r.transport[0].exactRetainedEvidence[0].sha256 = 'b'.repeat(64);
    },
    (r) => {
      r.transport[0].exactRetainedEvidence[0].bytes = 43;
    },
    (r) => {
      delete r.transport[0].exactRetainedEvidence;
    },
    (r) => {
      r.transport[0].exactRetainedEvidence = [null];
    },
  ]) {
    const report = fixture();
    mutation(report);
    assert.equal(summarizeNativeEvidenceCandidate(report).allRetainedPagesEnteredInput, false);
  }
  const incomplete = fixture();
  incomplete.toolDiagnostics.readbackComplete = false;
  assert.equal(summarizeNativeEvidenceCandidate(incomplete).sourceReadbackComplete, false);
});

test('wrong schema, malformed transport and hostile input fail closed without leaking content', () => {
  let executed = 0;
  const getter = Object.defineProperty({}, 'schema', {
    enumerable: true,
    get() {
      executed++;
      return 'untrusted';
    },
  });
  const cycle = {};
  cycle.self = cycle;
  const wrongSchema = fixture();
  wrongSchema.schema = 'hpm.context.native-fixed-benchmark';
  const wrongKind = fixture();
  wrongKind.fixedWorkload.kind = 'wrong';
  const wrongComparable = fixture();
  wrongComparable.fixedWorkload.fixedNoRereadComparison = true;
  const wrongTransport = fixture();
  wrongTransport.transport = null;
  for (const report of [
    null,
    {},
    [],
    getter,
    cycle,
    wrongSchema,
    wrongKind,
    wrongComparable,
    wrongTransport,
  ])
    assert.deepEqual(summarizeNativeEvidenceCandidate(report), { observationValid: false });
  assert.equal(executed, 0);
  const privateReport = fixture();
  privateReport.privateText = 'token-secret-user-content';
  assert.ok(
    !JSON.stringify(summarizeNativeEvidenceCandidate(privateReport)).includes(
      'token-secret-user-content'
    )
  );
});
