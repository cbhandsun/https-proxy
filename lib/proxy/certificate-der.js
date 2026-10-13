'use strict';

// A bounded DER framing codec, not a general ASN.1 or certificate verifier.
// Certificate parsing, key operations and signature verification use OpenSSL.
const MAX_DER_BYTES = 16 * 1024;

function fail() {
  throw new Error('certificate_der_invalid');
}

function read(buffer, offset = 0, limit) {
  if (!Buffer.isBuffer(buffer)) fail();
  if (limit === undefined) limit = buffer.length;
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length > MAX_DER_BYTES ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(limit) ||
    offset < 0 ||
    limit > buffer.length ||
    offset + 2 > limit
  )
    fail();
  const start = offset;
  const tag = buffer[offset++];
  if (!tag || (tag & 31) === 31) fail();
  let length = buffer[offset++];
  if (length & 128) {
    const count = length & 127;
    if (!count || count > 2 || offset + count > limit || buffer[offset] === 0) fail();
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buffer[offset++];
    if (length < 128) fail();
  }
  const end = offset + length;
  if (end > limit) fail();
  return { tag, start, content: offset, end };
}

function children(buffer, node, maximum = 32) {
  const items = [];
  let offset = node.content;
  while (offset < node.end) {
    if (items.length >= maximum) fail();
    const item = read(buffer, offset, node.end);
    items.push(item);
    offset = item.end;
  }
  return items;
}

function encode(tag, content) {
  if (
    !Number.isInteger(tag) ||
    tag < 1 ||
    tag > 255 ||
    (tag & 31) === 31 ||
    !Buffer.isBuffer(content) ||
    content.length > MAX_DER_BYTES - 4
  )
    fail();
  const size = content.length;
  const length = size < 128 ? [size] : size < 256 ? [129, size] : [130, size >> 8, size & 255];
  return Buffer.concat([Buffer.from([tag, ...length]), content]);
}

function sequence(...items) {
  if (!items.every(Buffer.isBuffer)) fail();
  return encode(48, Buffer.concat(items));
}

function positiveInteger(value) {
  if (!Buffer.isBuffer(value) || !value.length || value.length > 20) fail();
  let offset = 0;
  while (offset + 1 < value.length && value[offset] === 0) offset++;
  const bytes = value.subarray(offset);
  return encode(2, bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

module.exports = { MAX_DER_BYTES, read, children, encode, sequence, positiveInteger };
