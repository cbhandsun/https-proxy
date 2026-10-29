'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');

const KEY_PREFIX = 'hpm-context-dpapi-v1:';
const MAX_WRAPPED_CHARS = 16384;
function keyFailure() {
  return Object.assign(new Error('context_recovery_key_unavailable'), {
    code: 'context_recovery_key_unavailable',
    statusCode: 503,
  });
}

function safeData(input) {
  try {
    return normalizeCompactionData(input, MAX_WRAPPED_CHARS + 256);
  } catch {
    throw keyFailure();
  }
}

function base64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw keyFailure();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minimum || bytes.toString('base64') !== value) throw keyFailure();
  return value;
}

function dataKey(value) {
  base64(value, 32, 44);
  if (Buffer.from(value, 'base64').length !== 32) throw keyFailure();
  return value;
}

function wrappedKey(value) {
  if (typeof value !== 'string' || !value.startsWith(KEY_PREFIX)) throw keyFailure();
  base64(value.slice(KEY_PREFIX.length), 32, MAX_WRAPPED_CHARS);
  return value;
}

function keyRequest(input) {
  const value = safeData(input);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'operation,value' ||
    !['protect', 'unprotect'].includes(value.operation)
  )
    throw keyFailure();
  return {
    operation: value.operation,
    value: value.operation === 'protect' ? dataKey(value.value) : wrappedKey(value.value),
  };
}

function keyResponse(operation, input) {
  const value = safeData(input);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'ok,value' ||
    value.ok !== true
  )
    throw keyFailure();
  if (operation === 'protect') return wrappedKey(value.value);
  if (operation === 'unprotect') return dataKey(value.value);
  throw keyFailure();
}

module.exports = { KEY_PREFIX, MAX_WRAPPED_CHARS, keyFailure, keyRequest, keyResponse };
