'use strict';

const { isDeepStrictEqual } = require('node:util');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');

const KNOWN_FIELDS = ['id', 'type', 'encrypted_content', 'summary', 'created_by', 'status'];
const fail = () => new TypeError('Invalid checkpoint reuse observation');

// Compare complete JSON values. Emit only fixed labels, booleans and counts:
// neither opaque bytes, user content nor untrusted extra property names escape.
function inspectNativeCheckpointReuse(items, checkpoint) {
  let safe;
  try {
    safe = {
      items: normalizeCompactionData(items, 2 * 1024 * 1024),
      checkpoint: normalizeCompactionData(checkpoint, 2 * 1024 * 1024),
    };
  } catch {
    throw fail();
  }
  if (
    !Array.isArray(safe.items) ||
    !['compaction', 'compaction_summary'].includes(safe.checkpoint?.type) ||
    typeof safe.checkpoint.encrypted_content !== 'string' ||
    !safe.checkpoint.encrypted_content.trim()
  )
    throw fail();
  const candidates = safe.items.filter((item) =>
    ['compaction', 'compaction_summary'].includes(item?.type)
  );
  const matches = candidates.filter(
    (item) => item.encrypted_content === safe.checkpoint.encrypted_content
  );
  const reused = matches.length === 1 ? matches[0] : null;
  const result = {
    candidateCount: candidates.length,
    matchingOpaqueItems: matches.length,
    opaqueReused: reused !== null,
    exactItemEqual: reused !== null && isDeepStrictEqual(reused, safe.checkpoint),
    changedKnownFields: [],
    addedOtherFields: 0,
    removedOtherFields: 0,
    changedOtherFields: 0,
  };
  if (!reused) return result;
  const before = safe.checkpoint;
  result.changedKnownFields = KNOWN_FIELDS.filter(
    (key) =>
      Object.hasOwn(before, key) !== Object.hasOwn(reused, key) ||
      !isDeepStrictEqual(before[key], reused[key])
  );
  const others = new Set(
    [...Object.keys(before), ...Object.keys(reused)].filter((key) => !KNOWN_FIELDS.includes(key))
  );
  for (const key of others) {
    if (!Object.hasOwn(before, key)) result.addedOtherFields++;
    else if (!Object.hasOwn(reused, key)) result.removedOtherFields++;
    else if (!isDeepStrictEqual(before[key], reused[key])) result.changedOtherFields++;
  }
  return result;
}

module.exports = { inspectNativeCheckpointReuse };
