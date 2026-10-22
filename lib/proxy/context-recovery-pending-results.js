'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const MAX_PENDING_RESULTS_BYTES = 2 * 1024 * 1024;
const unavailable = () => new Error('Recovery pending results unavailable');

// Completed internal read-only results only. No caller-selected scope, tools,
// roles or executable values can acquire a continuation capability here.
function parseRecoveryPendingResults(input) {
  try {
    const results = normalizeCompactionData(input, MAX_PENDING_RESULTS_BYTES);
    const ids = new Set();
    if (!Array.isArray(results) || results.length > 16) throw unavailable();
    for (const item of results) {
      if (
        !item ||
        Array.isArray(item) ||
        Object.keys(item).sort().join(',') !== 'call_id,output,type' ||
        item.type !== 'function_call_output' ||
        typeof item.call_id !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(item.call_id) ||
        ids.has(item.call_id) ||
        typeof item.output !== 'string'
      )
        throw unavailable();
      ids.add(item.call_id);
    }
    return results;
  } catch {
    throw unavailable();
  }
}

function pendingResultsBytes(results) {
  return results.length ? Buffer.byteLength(JSON.stringify(results)) : 0;
}

// A full client window has no private results. Only the already authorized map
// may supply each exact result once; never append a second copy after rebuild.
function assertRebuiltPendingResults(input, publicHistory, upstreamHistory, historyFormat = 2) {
  const pending = parseRecoveryPendingResults(input);
  const publicItems = normalizeRecoveryRequestBody(
    'responses',
    { input: publicHistory },
    historyFormat
  ).input;
  const upstreamItems = normalizeRecoveryRequestBody(
    'responses',
    { input: upstreamHistory },
    historyFormat
  ).input;
  if (
    !Array.isArray(publicItems) ||
    !Array.isArray(upstreamItems) ||
    [...publicItems, ...upstreamItems].some(
      (item) => !item || typeof item !== 'object' || Array.isArray(item)
    )
  )
    throw unavailable();
  for (const result of pending) {
    if (publicItems.some((item) => item?.call_id === result.call_id)) throw unavailable();
    const matches = upstreamItems.filter((item) => item?.call_id === result.call_id);
    if (
      matches.length !== 2 ||
      matches[0].type !== 'function_call' ||
      matches[1].type !== 'function_call_output' ||
      matches[1].output !== result.output
    )
      throw unavailable();
  }
}

module.exports = {
  parseRecoveryPendingResults,
  pendingResultsBytes,
  MAX_PENDING_RESULTS_BYTES,
  assertRebuiltPendingResults,
};
