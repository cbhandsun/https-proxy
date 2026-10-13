'use strict';

// Read only data properties: native error objects must never execute accessors
// or custom coercion while constructing a public failure response.
function errorDataProperty(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch (_error) {
    return undefined;
  }
}

function errorText(value, depth = 0) {
  if (typeof value === 'string') return value.trim() ? value.slice(0, 8192) : '';
  if (depth >= 4) return '';
  let array;
  try {
    array = Array.isArray(value);
  } catch {
    return '';
  }
  if (array) {
    for (let index = 0; index < 8; index += 1) {
      const text = errorText(errorDataProperty(value, String(index)), depth + 1);
      if (text) return text;
    }
    return '';
  }
  for (const key of ['message', 'error', 'detail', 'error_detail', 'errors']) {
    const text = errorText(errorDataProperty(value, key), depth + 1);
    if (text) return text;
  }
  return '';
}

function selectTianxiErrorMessage(data, status) {
  for (const key of ['error_detail', 'message', 'error']) {
    const text = errorText(errorDataProperty(data, key));
    if (text) return text;
  }
  return typeof status === 'string' ? status.slice(0, 8192) : 'FAILED';
}

function sanitizeTianxiErrorText(value) {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, 8192)
    .replace(/sat-[A-Za-z0-9._-]+/g, 'sat-<redacted>')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'}]+/gi, '$1 <redacted>')
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi,
      '$1=<redacted>'
    )
    .replace(
      /\b(x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|"[\s\S]*|'[\s\S]*|[^,\s;}]+)/gi,
      '$1=<redacted>'
    )
    .replace(/[A-Za-z0-9_+/=-]{120,}/g, '<redacted-long>');
}

module.exports = { selectTianxiErrorMessage, sanitizeTianxiErrorText };
