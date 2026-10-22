'use strict';

const { STATUS_CODES } = require('node:http');

const MAX_HANDSHAKE_BODY_BYTES = 64 * 1024;
const METADATA = new Set([
  'x-request-id',
  'x-codex-turn-state',
  'openai-processing-ms',
  'openai-version',
  'openai-model',
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
]);
const REJECTION_METADATA = new Set(['content-type', 'content-encoding', 'www-authenticate']);
const unavailable = () => new Error('Recovery WebSocket handshake unavailable');

// Each hop owns its Upgrade/Accept/protocol/compression headers. Only selected
// application metadata crosses the boundary; never cookies or credentials.
function recoveryHandshakeHeaders(input, rejected = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof rejected !== 'boolean')
    throw unavailable();
  const result = [];
  const seen = new Set();
  let bytes = 0;
  try {
    const names = Object.keys(input);
    if (names.length > 1024) throw unavailable();
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!METADATA.has(lower) && !(rejected && REJECTION_METADATA.has(lower))) continue;
      const slot = Object.getOwnPropertyDescriptor(input, name);
      if (!slot || !Object.hasOwn(slot, 'value') || seen.has(lower)) throw unavailable();
      const value = slot.value;
      if (typeof value !== 'string' || value.length > 4096 || !/^[\t\x20-\x7e]*$/.test(value))
        throw unavailable();
      const line = lower + ': ' + value;
      bytes += line.length + 2;
      if (bytes > 8192) throw unavailable();
      seen.add(lower);
      result.push(line);
    }
    return result;
  } catch {
    throw unavailable();
  }
}

function recoveryHandshakeRejection(status, headers, body) {
  if (
    !Number.isSafeInteger(status) ||
    status < 300 ||
    status > 599 ||
    !Buffer.isBuffer(body) ||
    body.length > MAX_HANDSHAKE_BODY_BYTES
  )
    throw unavailable();
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] || 'Upstream Error'}`,
    ...recoveryHandshakeHeaders(headers, true),
    'Connection: close',
    'Content-Length: ' + body.length,
  ];
  return Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'ascii'), body]);
}

module.exports = { MAX_HANDSHAKE_BODY_BYTES, recoveryHandshakeHeaders, recoveryHandshakeRejection };
