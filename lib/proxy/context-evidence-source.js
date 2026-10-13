'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');

const MAX_SOURCE_BYTES = 1024 * 1024 + 16384;
const identity = (value, max = 256) =>
  typeof value === 'string' && value.length <= max && /^[a-zA-Z0-9_.:-]+$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const secretKey =
  /^(?:authorization|proxy-authorization|headers|cookie|cookies|set-cookie|token|access_token|refresh_token|id_token|api[_-]?key|password|secret|credential)$/i;
const secretText =
  /(?:\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:["']?(?:access_token|refresh_token|id_token|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?[^\s,"'}]{4,}))/i;
const forbiddenInput =
  /(?:\.codex[\\/](?:sessions|auth\.json)|\.claude[\\/]projects[\\/]|transcript_path|rollout-[\d-]+.*\.jsonl)/i;
const failure = (code) => ({ ok: false, code });

function sensitive(value) {
  if (typeof value === 'string') return secretText.test(value);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(sensitive);
  return Object.entries(value).some(
    ([key, child]) => (secretKey.test(key) && child !== null && child !== '') || sensitive(child)
  );
}

// Shared prospective-capture policy. The caller must observe execution itself;
// this validator does not authenticate a host, read history, or execute a tool.
function parseCompletedEvidenceSource(value) {
  let source;
  try {
    source = normalizeCompactionData(value, MAX_SOURCE_BYTES);
  } catch {
    return failure('invalid_evidence_source');
  }
  if (
    !record(source) ||
    Object.keys(source).sort().join(',') !== 'arguments,callId,completed,output,toolName' ||
    source.completed !== true ||
    !identity(source.callId) ||
    !identity(source.toolName, 128) ||
    !record(source.arguments)
  )
    return failure('invalid_evidence_source');
  if (
    /hpm_(?:capture_completed_hook|list_retained_evidence|read_retained_evidence|list_execution_records)/.test(
      source.toolName
    )
  )
    return failure('evidence_recapture_excluded');
  let args;
  try {
    args = normalizeCompactionData(source.arguments, 4096);
  } catch {
    return failure('evidence_arguments_too_large');
  }
  if (forbiddenInput.test(JSON.stringify(args)) || sensitive(args) || sensitive(source.output))
    return failure('sensitive_evidence_excluded');
  const output = typeof source.output === 'string' ? source.output : JSON.stringify(source.output);
  if (
    /Process running with session ID|Script running with cell ID/i.test(output) ||
    (record(source.output) &&
      ['session_id', 'sessionId', 'cell_id', 'cellId'].some((key) => source.output[key] != null))
  )
    return failure('incomplete_evidence_excluded');
  if (
    Buffer.byteLength(output) > 1024 * 1024 ||
    Buffer.from(output, 'utf8').toString('utf8') !== output
  )
    return failure('evidence_output_too_large');
  return {
    ok: true,
    source: {
      callId: source.callId,
      toolName: source.toolName,
      arguments: args,
      output,
      completed: true,
    },
  };
}

module.exports = { parseCompletedEvidenceSource };
