'use strict';

const { isWellFormedEvidenceText } = require('./context-evidence-utf8');

// Request-local encoded-byte accounting. No object serialization, user hooks,
// or retained transcript cache participates in unknown-data admission.
function createCompactionByteBudget(maximum, invalid) {
  let remaining = maximum;
  let cachedBytes = 0;
  // Reserve slots for large bodies so short metadata cannot exhaust the memo.
  // Both tiers share the original 4 MiB cap and remain local to this parse.
  const smallStrings = new Map();
  const largeStrings = new Map();
  function spend(count) {
    remaining -= count;
    if (remaining < 0) throw invalid();
  }
  function string(value, raw = Buffer.byteLength(value)) {
    const strings = value.length >= 1024 ? largeStrings : smallStrings;
    let count = strings.get(value);
    if (count === undefined) {
      count = raw + 2;
      if (count > remaining) throw invalid();
      if (/["\\]|[^\u0020-\uffff]/.test(value) || !isWellFormedEvidenceText(value)) {
        for (let index = 0; index < value.length; index++) {
          const unit = value.charCodeAt(index);
          if (unit === 34 || unit === 92) count++;
          else if (unit < 32)
            count += (unit >= 8 && unit <= 10) || unit === 12 || unit === 13 ? 1 : 5;
          else if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) index++;
            else count += 3;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) count += 3;
          if (count > remaining) throw invalid();
        }
      }
      if (strings.size < 64 && cachedBytes + raw <= 4 * 1024 * 1024) {
        strings.set(value, count);
        cachedBytes += raw;
      }
    }
    spend(count);
  }
  return { spend, string };
}

module.exports = { createCompactionByteBudget };
