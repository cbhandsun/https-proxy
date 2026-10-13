'use strict';

const { serializedContentBytes } = require('./context-artifact-page');

const MAX_READER_CALLS = 64;
const MAX_READER_BYTES = 512 * 1024;
const MAX_READER_RESULT_BYTES = 16 * 1024;
const EVIDENCE_ENVELOPE_RESERVE_BYTES = 64;

// Shared by real ledger reads and offload admission. Account for the source
// metadata and escaped result envelope, not just the unescaped payload bytes.
function contextEvidencePageBudget(source, maxResultBytes) {
  return Math.max(
    0,
    maxResultBytes - serializedContentBytes({ source }) - EVIDENCE_ENVELOPE_RESERVE_BYTES
  );
}

function attachContextEvidencePageSource(result, source, maxResultBytes) {
  if (!result.ok) return result;
  const output = { ...result, source };
  return serializedContentBytes(output) > maxResultBytes
    ? { ok: false, error: 'context_artifact_budget_exceeded' }
    : output;
}

module.exports = {
  MAX_READER_CALLS,
  MAX_READER_BYTES,
  MAX_READER_RESULT_BYTES,
  EVIDENCE_ENVELOPE_RESERVE_BYTES,
  contextEvidencePageBudget,
  attachContextEvidencePageSource,
};
