'use strict';

const { isPromise } = require('node:util').types;
const { normalizeCompactionData } = require('./context-compaction-envelope');

function invalidReaderResult() {
  return new TypeError('Invalid recovery reader result');
}

// Never assimilate model/reader data as an arbitrary thenable. Only ordinary
// native promises from a trusted async capability may be awaited. Checking the
// constructor descriptor avoids executing it during PromiseResolve/then.
function nativeReaderPromise(value) {
  if (!isPromise(value)) return false;
  const constructor = Object.getOwnPropertyDescriptor(value, 'constructor');
  if (
    Object.getPrototypeOf(value) !== Promise.prototype ||
    (constructor && (!Object.hasOwn(constructor, 'value') || constructor.value !== Promise))
  )
    throw invalidReaderResult();
  return true;
}

function contextRecoveryReaderResult(input) {
  const value = normalizeCompactionData(input, 128 * 1024);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.text !== 'string' ||
    Buffer.byteLength(value.text) > 16384
  )
    throw invalidReaderResult();
  return { ok: value.ok === true, text: value.text };
}

function rejectAsyncReaderResult(value) {
  if (!nativeReaderPromise(value)) return;
  // The sync caller cannot release an in-flight durable result. Consume a
  // later rejection without reading a possibly overridden own .then property.
  Promise.prototype.then.call(
    value,
    () => {},
    () => {}
  );
  throw invalidReaderResult();
}

module.exports = {
  nativeReaderPromise,
  contextRecoveryReaderResult,
  rejectAsyncReaderResult,
};
