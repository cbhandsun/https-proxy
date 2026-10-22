'use strict';

const crypto = require('node:crypto');
const { createHash } = crypto;
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { observedResponsesEcho } = require('./context-responses-observed-echo');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonicalStringEscapes = new RegExp(
  '["\\\\' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + '\ud800-\udfff]'
);

// Callers normalize JSON before canonical traversal. Keep the exact binding
// encoding shared by admission and private-history verification.
function canonicalBindingData(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalBindingData).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalBindingData(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

// Bounded to this one admission only. Repeated immutable scalar text is common
// in full histories; cache escaping without retaining any transcript globally.
function createCanonicalBindingEncoder() {
  const strings = new Map();
  let bytes = 0;
  function encodeString(value) {
    const prior = strings.get(value);
    if (prior !== undefined) return prior;
    // JSON only escapes quotes, backslashes, C0 controls and lone surrogates.
    // Keep every surrogate on the native path, including valid pairs. Other
    // Unicode is emitted verbatim; admission already validated scalar data.
    const encoded = canonicalStringEscapes.test(value) ? JSON.stringify(value) : '"' + value + '"';
    const size = Buffer.byteLength(encoded);
    if (strings.size < 128 && bytes + size <= 4 * 1024 * 1024) {
      strings.set(value, encoded);
      bytes += size;
    }
    return encoded;
  }
  function encode(value) {
    if (typeof value === 'string') return encodeString(value);
    if (Array.isArray(value)) return '[' + value.map(encode).join(',') + ']';
    if (value !== null && typeof value === 'object')
      return (
        '{' +
        Object.keys(value)
          .sort()
          .map((key) => encodeString(key) + ':' + encode(value[key]))
          .join(',') +
        '}'
      );
    return JSON.stringify(value);
  }
  return encode;
}

// Request-local only. Copy a bounded SHA prefix for repeated leading values
// (for example tool content), without retaining raw text between admissions.
function createCanonicalBindingFingerprint() {
  const encode = createCanonicalBindingEncoder();
  const prefixes = new Map();
  const completed = new Map();
  let bytes = 0,
    count = 0;
  return (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return createHash('sha256').update(encode(value)).digest('hex');
    const keys = Object.keys(value).sort();
    if (!keys.length) return createHash('sha256').update('{}').digest('hex');
    const name = keys[0];
    const leading = encode(value[name]);
    const encodedName = encode(name);
    // Batch the small trailing fields into one native hash update. Repeated
    // small messages can also reuse their completed digest within this request.
    // Large content keeps the prefix-state path without copying its whole body.
    let tail = '';
    for (let index = 1; index < keys.length; index++) {
      const key = keys[index];
      tail += ',' + encode(key) + ':' + encode(value[key]);
    }
    tail += '}';
    const small = leading.length + encodedName.length + tail.length + 2 <= 4096;
    const encoded = small ? '{' + encodedName + ':' + leading + tail : null;
    if (small && completed.has(encoded)) return completed.get(encoded);
    if (small) {
      // Small canonical messages need one digest, not a copied incremental
      // prefix state. Keep the identical SHA-256 bytes on older Node versions.
      const digest =
        typeof crypto.hash === 'function'
          ? crypto.hash('sha256', encoded, 'hex')
          : createHash('sha256').update(encoded).digest('hex');
      if (completed.size < 128) completed.set(encoded, digest);
      return digest;
    }
    let values = prefixes.get(name);
    let state = values?.get(leading);
    if (!state) {
      state = createHash('sha256').update('{').update(encodedName).update(':').update(leading);
      const size = Buffer.byteLength(encodedName) + Buffer.byteLength(leading) + 2;
      if (count < 128 && bytes + size <= 4 * 1024 * 1024) {
        if (!values) {
          values = new Map();
          prefixes.set(name, values);
        }
        values.set(leading, state);
        bytes += size;
        count++;
      }
    }
    const digest = state.copy().update(tail).digest('hex');
    return digest;
  };
}
function publicWindowFrontiers(scope, history) {
  let frontier = scope;
  return history.map((item) => {
    frontier = createHash('sha256')
      .update(frontier + '\0' + canonicalBindingData(item))
      .digest('hex');
    return frontier;
  });
}
function parsePublicWindow(input, published = true) {
  const value = normalizeCompactionData(input, 1024);
  const hasEcho =
    value && typeof value === 'object' && Object.hasOwn(value, 'echoPublishedFrontier');
  if (
    typeof published !== 'boolean' ||
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      (hasEcho
        ? 'count,echoPublishedFrontier,frontier,publishedFrontier,scope'
        : 'count,frontier,publishedFrontier,scope') ||
    !hash(value.scope) ||
    !hash(value.frontier) ||
    (published ? !hash(value.publishedFrontier) : value.publishedFrontier !== null) ||
    (hasEcho && (!published || !hash(value.echoPublishedFrontier))) ||
    !Number.isSafeInteger(value.count) ||
    value.count < (published ? 1 : 0) ||
    value.count > 16384
  )
    throw new TypeError('Invalid public window');
  return value;
}
function publishPublicWindow(input, output) {
  const window = parsePublicWindow(input, false);
  if (
    !Array.isArray(output) ||
    output.length < 1 ||
    output.length > 128 ||
    window.count + output.length > 16384
  )
    throw new TypeError('Invalid public output');
  const echo = output.some(
    (item) =>
      item &&
      typeof item === 'object' &&
      (Object.hasOwn(item, 'metadata') ||
        Object.hasOwn(item, 'internal_chat_message_metadata_passthrough'))
  )
    ? observedResponsesEcho(output)
    : null;
  return {
    ...window,
    count: window.count + output.length,
    publishedFrontier: publicWindowFrontiers(window.frontier, output).at(-1),
    ...(echo ? { echoPublishedFrontier: publicWindowFrontiers(window.frontier, echo).at(-1) } : {}),
  };
}
function matchesPublicWindow(window, offset, history) {
  const frontiers = publicWindowFrontiers(window.scope, history.slice(0, window.count));
  return (
    history.length >= window.count &&
    (offset === 0 ? window.scope : frontiers[offset - 1]) === window.frontier &&
    [window.publishedFrontier, window.echoPublishedFrontier].includes(frontiers[window.count - 1])
  );
}
function historyEntryBytes(tail, prefix, window) {
  return (
    Buffer.byteLength(JSON.stringify(tail)) +
    prefix.length * 64 +
    256 +
    (window ? Buffer.byteLength(JSON.stringify(window)) : 0)
  );
}

module.exports = {
  canonicalBindingData,
  createCanonicalBindingEncoder,
  createCanonicalBindingFingerprint,
  publicWindowFrontiers,
  parsePublicWindow,
  publishPublicWindow,
  matchesPublicWindow,
  historyEntryBytes,
};
