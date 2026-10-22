'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryStateData } = require('./context-recovery-state-data');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');

const ITEM_BYTES = 2 * 1024 * 1024;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Format is supplied by the binding owner, never by a request body selector.
// Replies retain their independent small budget. Only request history grows;
// metadata and individual messages keep their original admission boundaries.
function normalizeRecoveryRequestBody(kind, input, format = 2) {
  if (!['chat', 'responses', 'claude', 'gemini'].includes(kind))
    throw new TypeError('invalid_recovery_request_data');
  const maximum = recoveryHistoryRequestLimit(format);
  const body =
    format === 3
      ? normalizeRecoveryStateData(input, maximum)
      : normalizeCompactionData(input, maximum);
  if (!record(body)) throw new TypeError('invalid_recovery_request_data');
  const key = kind === 'responses' ? 'input' : kind === 'gemini' ? 'contents' : 'messages';
  const { [key]: history, ...metadata } = body;
  normalizeCompactionData(metadata, ITEM_BYTES);
  if (kind === 'responses' && typeof history === 'string') {
    normalizeCompactionData(history, ITEM_BYTES);
    return body;
  }
  if (!Array.isArray(history) || history.length > 16384)
    throw new TypeError('invalid_recovery_request_data');
  for (const item of history) {
    if (!record(item)) throw new TypeError('invalid_recovery_request_data');
    normalizeCompactionData(item, ITEM_BYTES);
  }
  return body;
}

module.exports = { normalizeRecoveryRequestBody };
