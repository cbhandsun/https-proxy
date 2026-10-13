'use strict';

const FIELDS = [
  'arguments',
  'afterSourceId',
  'limit',
  'sourceId',
  'digest',
  'offsetBytes',
  'limitBytes',
];
const REASONS = [
  'invalid_data',
  'unknown_field',
  'required',
  'wrong_type',
  'invalid_format',
  'not_safe_integer',
  'out_of_range',
];

// Fixed contract metadata only. Never forward exception text, source values,
// unknown field names, provider diagnostics, or credential-bearing objects.
function sanitizeContextEvidenceFailure(value) {
  if (value.error === 'evidence_read_budget_exceeded')
    return { ok: false, error: 'evidence_read_budget_exceeded' };
  if (
    value.error === 'invalid_evidence_arguments' &&
    FIELDS.includes(value.field) &&
    REASONS.includes(value.reason)
  )
    return {
      ok: false,
      error: 'invalid_evidence_arguments',
      field: value.field,
      reason: value.reason,
    };
  return { ok: false, error: 'context_evidence_unavailable' };
}

module.exports = { sanitizeContextEvidenceFailure };
