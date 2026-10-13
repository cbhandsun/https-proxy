'use strict';
const { isUtf8 } = require('node:buffer');
const WBIPC_MAX_FRAME_BYTES = 1024 * 1024;
function createFrameReader(onFrame, onError) {
  if (typeof onFrame !== 'function' || typeof onError !== 'function')
    throw new TypeError('WorkBuddy WBIPC frame callbacks are required');
  let buffer = Buffer.alloc(0),
    length = 0,
    failed = false;
  function fail(message) {
    if (failed) return;
    failed = true;
    buffer = Buffer.alloc(0);
    length = 0;
    onError(new Error(message));
  }
  function append(fragment) {
    const total = length + fragment.length;
    if (total > WBIPC_MAX_FRAME_BYTES) {
      fail('WorkBuddy WBIPC frame exceeded maximum size');
      return false;
    }
    if (buffer.length < total) {
      const next = Buffer.allocUnsafe(
        Math.min(WBIPC_MAX_FRAME_BYTES, Math.max(4096, total, buffer.length * 2))
      );
      buffer.copy(next, 0, 0, length);
      buffer = next;
    }
    fragment.copy(buffer, length);
    length = total;
    return true;
  }
  return function pushFrameChunk(chunk) {
    if (failed) return;
    if (!Buffer.isBuffer(chunk)) {
      fail('WorkBuddy WBIPC frame chunk is invalid');
      return;
    }
    let offset = 0;
    while (offset < chunk.length && !failed) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);
      if (length + fragment.length > WBIPC_MAX_FRAME_BYTES) {
        fail('WorkBuddy WBIPC frame exceeded maximum size');
        return;
      }
      if (newline < 0) {
        append(fragment);
        return;
      }
      let line = fragment;
      if (length) {
        if (!append(fragment)) return;
        line = buffer.subarray(0, length);
      }
      buffer = Buffer.alloc(0);
      length = 0;
      offset = newline + 1;
      if (line.length === 0 || (line.length === 1 && line[0] === 13)) continue;
      try {
        if (!isUtf8(line)) throw new TypeError('Invalid encoding');
        const frame = JSON.parse(line.toString('utf8'));
        if (!frame || typeof frame !== 'object' || Array.isArray(frame))
          throw new TypeError('Invalid frame');
        onFrame(frame);
      } catch (_error) {
        fail('WorkBuddy WBIPC frame is invalid');
        return;
      }
    }
  };
}
module.exports = { createFrameReader, WBIPC_MAX_FRAME_BYTES };
