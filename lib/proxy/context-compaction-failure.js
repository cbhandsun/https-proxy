'use strict';

// Only fixed codes cross the planning/logging boundary. Provider bodies,
// exception messages and model-generated fields never become diagnostics.
const reasons = new Set([
  'summary_upstream_failure',
  'summary_completion_invalid',
  'summary_incomplete',
  'summary_tool_or_refusal',
  'summary_size_limit',
  'summary_json_invalid',
  'summary_schema_invalid',
  'summary_entry_invalid',
  'summary_reference_invalid',
  'summary_exact_quote_mismatch',
  'summary_revision_invalid',
  'summary_requirement_loss',
  'summary_request_budget',
  'summary_source_invalid',
]);
const failures = new WeakMap();

function safeCompactionFailureReason(value) {
  return typeof value === 'string' && reasons.has(value) ? value : undefined;
}

function createCompactionFailure(reason) {
  const failure = new TypeError('Context summary rejected; originals retained');
  failures.set(failure, safeCompactionFailureReason(reason) || 'summary_source_invalid');
  return failure;
}

function compactionFailureReason(error) {
  return failures.get(error);
}

module.exports = {
  safeCompactionFailureReason,
  createCompactionFailure,
  compactionFailureReason,
};
