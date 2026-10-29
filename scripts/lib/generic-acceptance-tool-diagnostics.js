'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { sanitizeContextEvidenceFailure } = require('../../lib/proxy/context-evidence-errors');

const TOOLS = {
  emit_fresh_report: 'source',
  hpm_list_retained_evidence: 'index',
  hpm_read_retained_evidence: 'reader',
  hpm_list_execution_records: 'execution_ledger',
};

// Receipts contain only fixed contract metadata. Never retain arguments,
// arbitrary field names, source locators, digests, text, or exception messages.
function genericAcceptanceToolDiagnostic(name, phase, input, transportFailed = false) {
  const row = {
    tool: typeof name === 'string' && Object.hasOwn(TOOLS, name) ? TOOLS[name] : 'unknown',
    phase: [
      'source',
      'source_verification',
      'recovery_1',
      'recovery_2',
      'missing',
      'execution_verification',
    ].includes(phase)
      ? phase
      : 'unknown',
    outcome: 'invalid_reply',
  };
  if (transportFailed) return { ...row, outcome: 'transport_failed' };
  try {
    const reply = normalizeCompactionData(input, 2 * 1024 * 1024);
    if (reply?.content?.length !== 1 || reply.content[0]?.type !== 'text') return row;
    const value = normalizeCompactionData(JSON.parse(reply.content[0].text), 2 * 1024 * 1024);
    if (reply.isError === true)
      return {
        ...row,
        outcome: 'tool_failed',
        failure: sanitizeContextEvidenceFailure(value || {}),
      };
    return { ...row, outcome: 'returned' };
  } catch {
    return row;
  }
}

module.exports = { genericAcceptanceToolDiagnostic };
