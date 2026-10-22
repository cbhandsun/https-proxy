'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');

const DIGEST = /^[a-f0-9]{64}$/;
const MAX_MESSAGES = 16384;
function invalid() {
  return new TypeError('Invalid summary frontier binding');
}

// Only bounded digests/ordinals reach the checkpoint store. Transcript text,
// evidence locators and execution/deletion authority are not frontier metadata.
function createSummaryFrontier(prefixes, limits, contract, sourceMessages) {
  if (
    typeof contract !== 'string' ||
    !DIGEST.test(contract) ||
    !Number.isSafeInteger(sourceMessages) ||
    sourceMessages < 1 ||
    sourceMessages > MAX_MESSAGES
  )
    throw invalid();
  const safe = normalizeCompactionData({ prefixes, limits }, 2 * 1024 * 1024);
  if (
    !Array.isArray(safe.prefixes) ||
    safe.prefixes.length < 1 ||
    safe.prefixes.length > MAX_MESSAGES ||
    !safe.limits ||
    Array.isArray(safe.limits) ||
    Object.keys(safe.limits).sort().join(',') !== 'maxBytes,maxTokens' ||
    !['maxBytes', 'maxTokens'].every(
      (key) =>
        Number.isSafeInteger(safe.limits[key]) &&
        safe.limits[key] > 0 &&
        safe.limits[key] <= 16 * 1024 * 1024
    )
  )
    throw invalid();
  const byIndex = new Map();
  let previous = -1;
  for (const entry of safe.prefixes) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'digest,index' ||
      !Number.isSafeInteger(entry.index) ||
      entry.index <= previous ||
      entry.index >= sourceMessages ||
      typeof entry.digest !== 'string' ||
      !DIGEST.test(entry.digest)
    )
      throw invalid();
    previous = entry.index;
    byIndex.set(entry.index, entry.digest);
  }
  return Object.freeze({
    limits: Object.freeze(safe.limits),
    key(index, binding) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= sourceMessages) throw invalid();
      const prefix = byIndex.get(index);
      if (!prefix) return null;
      const context = normalizeCompactionData(binding, 128 * 1024);
      return createHash('sha256')
        .update(JSON.stringify(['hpm.summary.frontier.v1', contract, index, prefix, context]))
        .digest('hex');
    },
  });
}

module.exports = { createSummaryFrontier };
