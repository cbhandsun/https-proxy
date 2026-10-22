'use strict';

// Well-formed UTF-16 round-trips through UTF-8 exactly. Use the native scan when
// available to avoid allocating a second copy of retained evidence just to
// reject lone surrogates. Older supported runtimes keep the original check.
function isWellFormedEvidenceText(input) {
  if (typeof input !== 'string') return false;
  const native = String.prototype.isWellFormed;
  return typeof native === 'function'
    ? Reflect.apply(native, input, [])
    : Buffer.from(input, 'utf8').toString('utf8') === input;
}

module.exports = { isWellFormedEvidenceText };
