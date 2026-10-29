'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');
const { encodeContextRecoveryClientWire } = require('./context-recovery-client-wire');
const { createSseJsonDecoder } = require('./forced-stream-collector');

const invalid = () => new Error('Recovery WebSocket protocol unavailable');
const streamId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(value);

function parseRecoveryWebSocketMessage(bytes, historyFormat = 2) {
  if (!Buffer.isBuffer(bytes) || bytes.length > recoveryHistoryRequestLimit(historyFormat))
    throw invalid();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw invalid();
  const input = JSON.parse(text);
  const event =
    historyFormat === 3 && input?.type === 'response.create'
      ? normalizeRecoveryRequestBody('responses', input, 3)
      : normalizeCompactionData(input, MAX_WIRE_BYTES);
  if (!event || Array.isArray(event) || typeof event.type !== 'string') throw invalid();
  if (event.stream_id !== undefined && !streamId(event.stream_id))
    throw Object.assign(invalid(), { code: 'invalid_stream_id' });
  return event;
}

// Fixed protocol diagnostics only; never echo invalid IDs or request content.
function recoveryWebSocketStreamError(code, id) {
  const limit = code === 'websocket_stream_limit_reached';
  if ((!limit && code !== 'invalid_stream_id') || (limit && !streamId(id))) throw invalid();
  return {
    type: 'error',
    status: 400,
    ...(limit ? { stream_id: id } : {}),
    error: {
      type: 'invalid_request_error',
      code,
      message: limit
        ? 'This WebSocket connection has reached its maximum number of distinct stream IDs (32). Reuse an existing stream_id or open a new WebSocket connection.'
        : "The 'stream_id' field must be a non-empty string with at most 256 characters and may only contain letters, numbers, underscores, hyphens, and periods.",
      param: 'stream_id',
    },
  };
}

function recoveryWebSocketBody(event) {
  const { type, stream_id: _stream, stream, ...body } = event;
  // Native Codex sends the redundant HTTP-style stream=true on WS creates,
  // including generate=false warmup. WS is already a streaming transport;
  // normalize only that exact value, never false or a coerced truthy value.
  if (
    type !== 'response.create' ||
    (stream !== undefined && stream !== true) ||
    body.background !== undefined
  )
    throw invalid();
  return body;
}

function recoveryWebSocketEvents(response, usage, streamId) {
  const encoded = encodeContextRecoveryClientWire('responses', response, usage, true);
  const events = [];
  const decoder = createSseJsonDecoder(MAX_WIRE_BYTES, (event) => {
    events.push(streamId === undefined ? event : { ...event, stream_id: streamId });
  });
  decoder.push(encoded.wire);
  decoder.finish();
  return { events, response: encoded.response };
}

module.exports = {
  parseRecoveryWebSocketMessage,
  recoveryWebSocketStreamError,
  recoveryWebSocketBody,
  recoveryWebSocketEvents,
};
