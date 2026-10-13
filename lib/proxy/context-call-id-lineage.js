'use strict';

const MAX_CONTEXT_CALL_ID_DIGESTS = 65536;
function invalidLineage() {
  const error = new TypeError('Invalid or oversized context call identity lineage');
  error.code = 'invalid_context_call_lineage';
  return error;
}

// Only trusted in-process callers provide this metadata. Never read a wire field
// or invoke array getters/toJSON while accepting a bounded set of SHA-256 IDs.
function normalizeCallIdDigests(value = [], maximum = MAX_CONTEXT_CALL_ID_DIGESTS) {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > MAX_CONTEXT_CALL_ID_DIGESTS ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw invalidLineage();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (
    !Number.isSafeInteger(length) ||
    length > maximum ||
    Reflect.ownKeys(value).length !== length + 1
  )
    throw invalidLineage();
  const ids = new Set();
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable ||
      typeof descriptor.value !== 'string' ||
      !/^[a-f0-9]{64}$/.test(descriptor.value)
    )
      throw invalidLineage();
    ids.add(descriptor.value);
  }
  return [...ids];
}

function mergeCallIdDigests(...lineages) {
  const merged = new Set();
  for (const lineage of lineages) {
    for (const id of normalizeCallIdDigests(lineage)) merged.add(id);
    if (merged.size > MAX_CONTEXT_CALL_ID_DIGESTS) throw invalidLineage();
  }
  return [...merged];
}

module.exports = { MAX_CONTEXT_CALL_ID_DIGESTS, normalizeCallIdDigests, mergeCallIdDigests };
