'use strict';

// Capabilities are internal functions; inspect descriptors without invoking
// accessors, serialization hooks or inherited properties.
function nativeEvidenceV2Options(input, allowed) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new TypeError('Invalid native evidence options');
  const output = {};
  for (const key of Reflect.ownKeys(input)) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!allowed.includes(key) || !d || !Object.hasOwn(d, 'value') || !d.enumerable)
      throw new TypeError('Invalid native evidence options');
    output[key] = d.value;
  }
  return output;
}

module.exports = { nativeEvidenceV2Options };
