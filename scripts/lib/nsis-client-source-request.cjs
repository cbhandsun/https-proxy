'use strict';

const { types } = require('node:util');
const invalid = () => new Error('source_request_invalid');

// Keep the same 16 KiB wire admission as stdin, including JSON escaping. No
// getters, proxy traps, coercion or serialization hooks run on direct inputs.
function snapshotSourceRequest(input) {
  let nodes = 4096;
  let bytes = 16384;
  const seen = new Set();
  function copy(value, depth) {
    if (--nodes < 0 || depth > 64) throw invalid();
    if (typeof value === 'string') {
      bytes -= Buffer.byteLength(value);
      if (bytes < 0) throw invalid();
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value))
      throw invalid();
    const array = Array.isArray(value);
    if (
      !(
        [Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        (array && Object.getPrototypeOf(value) === Array.prototype)
      )
    )
      throw invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > nodes || (array && keys.length !== value.length + 1)) throw invalid();
    const result = array ? [] : Object.create(null);
    seen.add(value);
    for (const key of keys) {
      const slot = Object.getOwnPropertyDescriptor(value, key);
      if (!slot || !Object.hasOwn(slot, 'value')) throw invalid();
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || !slot.enumerable || (array && !/^(0|[1-9]\d*)$/.test(key)))
        throw invalid();
      bytes -= Buffer.byteLength(key);
      if (bytes < 0) throw invalid();
      Object.defineProperty(result, key, { value: copy(slot.value, depth + 1), enumerable: true });
    }
    seen.delete(value);
    return result;
  }
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw invalid();
  return result;
}

function validSourceMetadata(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (!Object.hasOwn(value, 'progressToken') ||
      ['string', 'number'].includes(typeof value.progressToken)) &&
    (!Object.hasOwn(value, 'claudecode/toolUseId') ||
      typeof value['claudecode/toolUseId'] === 'string')
  );
}

module.exports = { snapshotSourceRequest, validSourceMetadata };
