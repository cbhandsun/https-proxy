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

// Apply the limit to individual events, not an arbitrary transport chunk that
// may contain many valid events. Retain only the unfinished trailing event.
function createSseEventParser(maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new TypeError('maxChars must be a positive safe integer');
  }
  return function parseSseEvents(state, chunkText, label, onEvent) {
    const input = (state.buffer || '') + chunkText;
    state.buffer = '';
    const delimiter = /\r?\n\r?\n/g;
    let offset = 0;
    let match;
    while ((match = delimiter.exec(input))) {
      if (match.index - offset > maxChars) {
        const error = new RangeError(`${label} SSE event too large; max ${maxChars} chars`);
        error.code = 'upstream_stream_event_too_large';
        throw error;
      }
      const event = input.slice(offset, match.index);
      offset = delimiter.lastIndex;
      onEvent(event);
      if (state.done) return;
    }
    if (input.length - offset > maxChars) {
      const error = new RangeError(`${label} SSE event too large; max ${maxChars} chars`);
      error.code = 'upstream_stream_event_too_large';
      throw error;
    }
    state.buffer = input.slice(offset);
  };
}

module.exports = { createSseBufferAppender, createSseEventParser, parseBoundedInteger };
