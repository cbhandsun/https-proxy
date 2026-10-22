'use strict';

const { createHash } = require('node:crypto');

// Internal canonical encoding of a fresh, bounded normalizer result. External
// entry points must normalize before calling this helper; a digest never grants
// ownership or read authority. Do not retain caller data or memoize across calls.
function fingerprintNormalizedValue(value) {
  const hash = createHash('sha256');
  // JSON enumerates array-index properties numerically even when they were
  // inserted lexicographically. Preserve the original sorted-object digest.
  const index = (key) => String(Number(key) >>> 0) === key && key !== '4294967295';
  function append(item) {
    if (item === null || typeof item !== 'object') {
      hash.update(JSON.stringify(item));
      return;
    }
    const array = Array.isArray(item);
    const keys = array
      ? Array.from({ length: item.length }, (_, position) => String(position))
      : Object.keys(item).sort((a, b) => {
          const ai = index(a),
            bi = index(b);
          if (ai && bi) return Number(a) - Number(b);
          if (ai !== bi) return ai ? -1 : 1;
          return a < b ? -1 : a > b ? 1 : 0;
        });
    hash.update(array ? '[' : '{');
    keys.forEach((key, position) => {
      if (position) hash.update(',');
      if (!array) hash.update(JSON.stringify(key) + ':');
      append(item[key]);
    });
    hash.update(array ? ']' : '}');
  }
  append(value);
  return hash.digest('hex');
}

module.exports = { fingerprintNormalizedValue };
