'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { MAX_READER_CALLS, MAX_READER_BYTES } = require('./context-evidence-page');

// Version 1 is the original lifetime allowance. Version 2 separates a task's
// cumulative ceiling from the unchanged per-request reader limits.
function evidenceBudgetLimits(version) {
  if (version === 1) return { maxCalls: MAX_READER_CALLS, maxBytes: MAX_READER_BYTES };
  if (version === 2) return { maxCalls: 4096, maxBytes: 16 * 1024 * 1024 };
  throw budgetFailure();
}

function budgetFailure() {
  return Object.assign(new TypeError('invalid_evidence_budget_state'), {
    code: 'invalid_evidence_budget_state',
  });
}
function parseEvidenceBudgetState(input) {
  try {
    const state = normalizeCompactionData(input, 1024);
    const limits = evidenceBudgetLimits(state?.version);
    if (
      !state ||
      Array.isArray(state) ||
      Object.keys(state).sort().join(',') !== 'calls,returnedBytes,successfulReads,version' ||
      !Number.isSafeInteger(state.calls) ||
      state.calls < 0 ||
      state.calls > limits.maxCalls ||
      !Number.isSafeInteger(state.returnedBytes) ||
      state.returnedBytes < 0 ||
      state.returnedBytes > limits.maxBytes ||
      !Number.isSafeInteger(state.successfulReads) ||
      state.successfulReads < 0 ||
      state.successfulReads > state.calls ||
      (state.returnedBytes > 0 && state.calls === 0) ||
      (state.successfulReads > 0 && state.returnedBytes === 0)
    )
      throw budgetFailure();
    return {
      version: state.version,
      calls: state.calls,
      returnedBytes: state.returnedBytes,
      successfulReads: state.successfulReads,
    };
  } catch {
    throw budgetFailure();
  }
}

module.exports = { budgetFailure, parseEvidenceBudgetState, evidenceBudgetLimits };
