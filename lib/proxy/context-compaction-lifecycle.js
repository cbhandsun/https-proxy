'use strict';

const { invalidCompaction } = require('./context-compaction-envelope');
const { localCompactionEvidenceOwner } = require('./context-compaction-evidence');

function renewLocalCompactionReplay(tokens, binding, envelopes, artifacts, signal) {
  if (signal?.aborted) throw invalidCompaction('compaction_cancelled');
  if (tokens === undefined || (Array.isArray(tokens) && tokens.length === 0)) return null;
  if (typeof envelopes?.renew !== 'function') throw invalidCompaction();
  return envelopes.renew(tokens, binding, (references, expiresAt) => {
    if (signal?.aborted) throw invalidCompaction('compaction_cancelled');
    if (typeof artifacts?.renewReferences !== 'function')
      throw invalidCompaction('compaction_evidence_unavailable');
    const result = artifacts.renewReferences(
      localCompactionEvidenceOwner(binding),
      references,
      expiresAt
    );
    if (signal?.aborted) throw invalidCompaction('compaction_cancelled');
    return result;
  });
}

const INPUT_ERRORS = new Set([
  'invalid_local_compaction',
  'foreign_compaction_state',
  'invalid_compaction_trigger',
  'compaction_requires_full_history',
  'local_compaction_closed',
  'local_compaction_clock_invalid',
]);

function compactionReplayFailure(error) {
  const code =
    error?.code === 'compaction_evidence_unavailable'
      ? error.code
      : INPUT_ERRORS.has(error?.code)
        ? error.code
        : 'invalid_local_compaction';
  const status = code === 'compaction_evidence_unavailable' ? 502 : 400;
  return {
    code,
    status,
    payload: {
      error: {
        type: status === 400 ? 'invalid_request_error' : 'api_error',
        code,
        message:
          'Local compaction state or evidence is unavailable for this target. Resend the authorized original history; never reconstruct it from an unreadable checkpoint or rerun external tools.',
        recovery: { action: 'resend_full_history', replay_external_tools: false },
      },
    },
  };
}

module.exports = { renewLocalCompactionReplay, compactionReplayFailure };
