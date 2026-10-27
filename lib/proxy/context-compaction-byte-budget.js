'use strict';

const { isWellFormedEvidenceText } = require('./context-evidence-utf8');

// Request-local encoded-byte accounting. No object serialization, user hooks,
// or retained transcript cache participates in unknown-data admission.
function createCompactionByteBudget(maximum, invalid) {
  let remaining = maximum;
  let cachedBytes = 0;
  const strings = new Map();
  function spend(count) {
    remaining -= count;
    if (remaining < 0) throw invalid();
  }
  function string(value, raw = Buffer.byteLength(value)) {
    let count = strings.get(value);
    if (count === undefined) {
      count =
        /["\\]|[^\u0020-\uffff]/.test(value) || !isWellFormedEvidenceText(value)
          ? Buffer.byteLength(JSON.stringify(value))
          : raw + 2;
      if (strings.size < 128 && cachedBytes + raw <= 4 * 1024 * 1024) {
        strings.set(value, count);
        cachedBytes += raw;
      }
    }
    spend(count);
  }
  return { spend, string };
}

module.exports = { createCompactionByteBudget };
