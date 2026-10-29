'use strict';

const counters = new Set(['input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new TypeError('Invalid recovery usage attribution');

// Input is already normalized and byte-bounded by safeRecoveryUsage. These are
// per-input item counters, not additional billable tokens. Their item identities
// can refer to private history and must never enter aggregate usage or reports.
function validateRecoveryUsageAttribution(value) {
  if (
    !record(value) ||
    !Object.hasOwn(value, 'items') ||
    Object.keys(value).some((key) => key !== 'items' && key !== 'request_fields') ||
    !record(value.items)
  )
    throw invalid();
  function counts(item, contentAllowed) {
    if (!record(item) || !Object.keys(item).length) throw invalid();
    for (const [key, amount] of Object.entries(item)) {
      if (key === 'content' && contentAllowed) {
        if (!Array.isArray(amount) || amount.length > 16384) throw invalid();
        for (const child of amount) counts(child, false);
      } else if (!counters.has(key) || !Number.isSafeInteger(amount) || amount < 0) throw invalid();
    }
  }
  // Official responses can attribute the request's tool definitions separately
  // from input items. Validate observed counters, then discard this metadata
  // along with item attribution so aggregate usage is never double counted.
  if (Object.hasOwn(value, 'request_fields')) {
    if (!record(value.request_fields)) throw invalid();
    for (const [field, item] of Object.entries(value.request_fields)) {
      if (field !== 'tools') throw invalid();
      counts(item, false);
    }
  }
  for (const [id, item] of Object.entries(value.items)) {
    // Attribution keys are provider input paths, not callable tool identities.
    if (
      !id.length ||
      Buffer.byteLength(id) > 256 ||
      [...id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw invalid();
    counts(item, true);
  }
}

module.exports = { validateRecoveryUsageAttribution };
