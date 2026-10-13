'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const KNOWN = [
  'document',
  'offsetBytes',
  'sourceId',
  'digest',
  'limitBytes',
  'afterSourceId',
  'limit',
];

// Classify boundary failures, never raw values, unknown names or source IDs.
function nativeEvidenceArgumentShape(input) {
  const args = normalizeCompactionData(input, 2 * 1024 * 1024);
  const keys = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : [];
  const integerRange = (value, min, max) =>
    typeof value !== 'number'
      ? 'wrong_type'
      : !Number.isSafeInteger(value)
        ? 'not_safe_integer'
        : value < min || value > max
          ? 'out_of_range'
          : 'valid';
  const keyConstraints = {};
  for (const key of keys) {
    if (key === 'limit') keyConstraints[key] = integerRange(args[key], 1, 16);
    if (key === 'limitBytes') keyConstraints[key] = integerRange(args[key], 1, 65536);
    if (key === 'offsetBytes')
      keyConstraints[key] = integerRange(args[key], 0, Number.MAX_SAFE_INTEGER);
    if (['sourceId', 'afterSourceId', 'digest'].includes(key)) {
      const pattern = key === 'digest' ? /^[a-f0-9]{64}$/ : /^hce_[a-f0-9]{32}$/;
      keyConstraints[key] =
        typeof args[key] !== 'string'
          ? 'wrong_type'
          : pattern.test(args[key])
            ? 'valid'
            : 'invalid_format';
    }
  }
  return {
    argumentsType: args === null ? 'null' : Array.isArray(args) ? 'array' : typeof args,
    keyTypes: Object.fromEntries(
      keys
        .filter((key) => KNOWN.includes(key))
        .map((key) => [key, args[key] === null ? 'null' : typeof args[key]])
    ),
    keyConstraints,
    unknownKeyCount: keys.filter((key) => !KNOWN.includes(key)).length,
  };
}

module.exports = { nativeEvidenceArgumentShape };
