'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { summarizeNativeBenchmarkResult } = require('./native-benchmark-result-summary');

function summarizeNativeEvidenceCandidate(input) {
  let report;
  try {
    report = normalizeCompactionData(input, 2 * 1024 * 1024);
  } catch {
    return { observationValid: false };
  }
  if (
    report?.schema !== 'hpm.context.native-evidence-candidate' ||
    report.fixedWorkload?.kind !== 'retained_evidence_readback_candidate' ||
    report.fixedWorkload?.fixedNoRereadComparison !== false
  )
    return { observationValid: false };
  // Reuse transport-only observation logic without rewriting the source report
  // or claiming equivalence to the original no-reread benchmark.
  const base = summarizeNativeBenchmarkResult({
    ...report,
    schema: 'hpm.context.native-fixed-benchmark',
    fixedWorkload: { ...report.fixedWorkload, kind: 'fixed_tool_result_heavy_readonly_audit' },
  });
  if (!base.observationValid) return base;
  const expected = report.toolDiagnostics?.retainedPageReplies;
  const validReplies =
    Array.isArray(expected) &&
    expected.length > 0 &&
    expected.length <= 64 &&
    expected.every(
      (item, index) =>
        item?.index === index &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes > 0 &&
        typeof item.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(item.sha256)
    );
  const entered = new Set();
  const enteredGeneration = new Set();
  const enteredCompaction = new Set();
  if (validReplies)
    for (const row of report.transport) {
      if (!Array.isArray(row.exactRetainedEvidence)) continue;
      for (const item of row.exactRetainedEvidence) {
        const prior = expected[item?.index];
        if (
          prior &&
          item.observed === true &&
          item.bytes === prior.bytes &&
          item.sha256 === prior.sha256
        ) {
          entered.add(prior.index);
          (row.compact ? enteredCompaction : enteredGeneration).add(prior.index);
        }
      }
    }
  return {
    ...base,
    candidateWorkload: true,
    comparableToHistoricalFixedWorkload: false,
    sourceReadbackComplete: report.toolDiagnostics?.readbackComplete === true,
    retainedPageReplyCount: validReplies ? expected.length : null,
    retainedPageRepliesEnteredInput: entered.size,
    retainedPageRepliesEnteredGenerationInput: enteredGeneration.size,
    retainedPageRepliesEnteredCompactionInput: enteredCompaction.size,
    allRetainedPagesEnteredInput: validReplies && entered.size === expected.length,
    installedClientIntegrationVerified: false,
  };
}

module.exports = { summarizeNativeEvidenceCandidate };
