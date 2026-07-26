'use strict';

function parseBoundedInteger(value, defaultValue, min, max) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
  const fallback = Number.isFinite(defaultValue) ? Math.trunc(defaultValue) : min;
  const integer = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function createSseBufferAppender(maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new TypeError('maxChars must be a positive safe integer');
  }
  return function appendSseBuffer(state, chunkText, label) {
    state.buffer = (state.buffer || '') + chunkText;
    if (state.buffer.length > maxChars) {
      state.buffer = '';
      throw new Error(`${label} SSE event too large; max ${maxChars} chars`);
    }
  };
}

module.exports = { createSseBufferAppender, parseBoundedInteger };
