'use strict';

const { types } = require('node:util');
const { storageFailure } = require('./context-recovery-storage-contract');
const MAX_VALUE_BYTES = 65536;
const MAX_WIRE_BYTES = 131072;

function ownRecord(input, names) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw storageFailure();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key)))
    throw storageFailure();
  const result = Object.create(null);
  for (const name of names) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value') || types.isProxy(slot.value))
      throw storageFailure();
    result[name] = slot.value;
  }
  return result;
}

function nativeReply(text) {
  if (
    typeof text !== 'string' ||
    text.length > MAX_WIRE_BYTES ||
    Buffer.byteLength(text) > MAX_WIRE_BYTES
  )
    throw storageFailure();
  const parsed = JSON.parse(text);
  // The fixed native serializer is compact. Exact reserialization also refuses
  // duplicate keys, including an earlier conflicting ok/revision/value field.
  if (JSON.stringify(parsed) !== text) throw storageFailure();
  const value = ownRecord(parsed, ['ok', 'revision', 'value']);
  if (value.ok !== true || !Number.isSafeInteger(value.revision) || value.revision < 0)
    throw storageFailure();
  if (value.revision === 0) {
    if (value.value !== null) throw storageFailure();
  } else {
    if (
      typeof value.value !== 'string' ||
      value.value.length > 87384 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.value)
    )
      throw storageFailure();
    const bytes = Buffer.from(value.value, 'base64');
    if (
      bytes.length < 29 ||
      bytes.length > MAX_VALUE_BYTES ||
      bytes.toString('base64') !== value.value
    )
      throw storageFailure();
  }
  return value;
}

// Sequence zero and the wrapping terminal value are never admitted. The Rust
// stream uses the same bound before executing a request.
function encodeRecoveryAnchorFrame(sequence, text) {
  if (
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    sequence >= 0xffffffff ||
    typeof text !== 'string' ||
    text.length > MAX_WIRE_BYTES
  )
    throw storageFailure();
  const payload = Buffer.from(text, 'utf8');
  if (!payload.length || payload.length > MAX_WIRE_BYTES || payload.toString('utf8') !== text)
    throw storageFailure();
  const frame = Buffer.allocUnsafe(8 + payload.length);
  frame.writeUInt32LE(sequence, 0);
  frame.writeUInt32LE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

module.exports = {
  MAX_VALUE_BYTES,
  MAX_WIRE_BYTES,
  ownAnchorRecord: ownRecord,
  parseRecoveryAnchorReply(text) {
    try {
      return nativeReply(text);
    } catch {
      throw storageFailure();
    }
  },
  encodeRecoveryAnchorFrame,
};
