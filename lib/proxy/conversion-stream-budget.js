'use strict';

const { parseBoundedInteger } = require('./sse-buffer');

function streamLimitError(message) {
  const error = new RangeError(message);
  error.code = 'upstream_stream_conversion_limit';
  return error;
}

function conversionFailureCode(error) {
  return [
    'upstream_stream_event_too_large',
    'upstream_stream_conversion_limit',
    'upstream_stream_invalid_tool_arguments',
    'upstream_invalid_json_object',
  ].includes(error?.code)
    ? error.code
    : 'upstream_stream_conversion_error';
}

function createConversionStreamBudget(options = {}) {
  const maxBytes = parseBoundedInteger(
    options.maxConversionStreamBytes,
    32 * 1024 * 1024,
    1,
    64 * 1024 * 1024
  );
  const maxToolBytes = parseBoundedInteger(
    options.maxConversionToolArgumentBytes,
    4 * 1024 * 1024,
    1,
    8 * 1024 * 1024
  );
  const maxTools = parseBoundedInteger(options.maxConversionToolCalls, 256, 1, 4096);
  return {
    consume(state, chunk) {
      const bytes = Buffer.byteLength(chunk);
      const total = (state.conversionStreamBytes || 0) + bytes;
      if (total > maxBytes) throw streamLimitError('Protocol conversion stream exceeds byte limit');
      state.conversionStreamBytes = total;
    },
    appendArguments(entry, delta) {
      if (typeof delta !== 'string') throw new TypeError('Tool argument delta must be a string');
      const bytes =
        (entry.argumentBytes ?? Buffer.byteLength(entry.arguments || '')) +
        Buffer.byteLength(delta);
      if (bytes > maxToolBytes) {
        throw streamLimitError('Protocol conversion tool arguments exceed byte limit');
      }
      entry.argumentBytes = bytes;
      return (entry.arguments || '') + delta;
    },
    addTool(state) {
      const count = (state.conversionToolCount || 0) + 1;
      if (count > maxTools) throw streamLimitError('Protocol conversion tool count exceeds limit');
      state.conversionToolCount = count;
    },
  };
}

module.exports = { createConversionStreamBudget, conversionFailureCode };
