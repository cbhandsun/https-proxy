'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { sanitizeContextEvidenceFailure } = require('./context-evidence-errors');

// One canonical app-server dynamic-tool result. Admission includes the actual
// contentItems envelope, not only its nested evidence JSON string. This does
// not control Code Mode stdout or imply that the provider received the data.
function encodeContextEvidenceOutput(input) {
  const value = normalizeCompactionData(input, 2 * 1024 * 1024);
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.ok !== 'boolean'
  )
    throw new TypeError('Invalid evidence output');
  const safe = value.ok ? value : sanitizeContextEvidenceFailure(value);
  const text = JSON.stringify(safe);
  const nativeResult = Object.freeze({
    success: safe.ok,
    contentItems: Object.freeze([Object.freeze({ type: 'inputText', text })]),
  });
  return { text, nativeResult, bytes: Buffer.byteLength(JSON.stringify(nativeResult)) };
}

module.exports = { encodeContextEvidenceOutput };
