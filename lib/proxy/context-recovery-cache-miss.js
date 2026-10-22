'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const lane = (value) =>
  value === undefined || (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(value));
const unavailable = () => new Error('Recovery cache-miss boundary unavailable');

function previousMiss(error) {
  return (
    record(error) &&
    error.type === 'invalid_request_error' &&
    error.code === 'previous_response_not_found' &&
    error.param === 'previous_response_id' &&
    typeof error.message === 'string'
  );
}
function wireError(result) {
  const wire = own(result, 'wire');
  if (
    !Buffer.isBuffer(wire) ||
    wire.length > MAX_WIRE_BYTES ||
    own(result, 'stream') !== false ||
    ![undefined, 'identity'].includes(own(result, 'encoding'))
  )
    return null;
  const text = wire.toString('utf8');
  if (!Buffer.from(text).equals(wire)) return null;
  const body = normalizeCompactionData(JSON.parse(text), MAX_WIRE_BYTES);
  return record(body) && Object.keys(body).join(',') === 'error' && previousMiss(body.error)
    ? body.error
    : null;
}

function isRecoveryHttpCacheMiss(request, result) {
  try {
    return (
      identity(own(request, 'previous_response_id')) &&
      own(result, 'statusCode') === 400 &&
      wireError(result) !== null
    );
  } catch {
    return false;
  }
}
function isWebSocketCacheMiss(request, result, streamId) {
  try {
    if (
      !identity(own(request, 'previous_response_id')) ||
      own(result, 'statusCode') !== 200 ||
      own(result, 'eventCount') !== 1
    )
      return false;
    const events = normalizeCompactionData(own(result, 'events'), MAX_WIRE_BYTES);
    const error = wireError(result);
    return (
      Array.isArray(events) &&
      events.length === 1 &&
      record(events[0]) &&
      events[0].type === 'error' &&
      events[0].status === 400 &&
      events[0].stream_id === streamId &&
      error !== null &&
      previousMiss(events[0].error) &&
      fingerprintContextData(error) === fingerprintContextData(events[0].error)
    );
  } catch {
    return false;
  }
}
function recoveryCacheMissBody() {
  return {
    error: {
      type: 'invalid_request_error',
      code: 'previous_response_not_found',
      param: 'previous_response_id',
      message:
        'Previous response is unavailable. Retry with previous_response_id cleared and the full input context.',
    },
  };
}
function recoveryCacheMissEvent(streamId) {
  if (!lane(streamId)) throw unavailable();
  return {
    type: 'error',
    status: 400,
    ...(streamId === undefined ? {} : { stream_id: streamId }),
    ...recoveryCacheMissBody(),
  };
}

// A request-local observation capability, never a wire-supplied retry flag.
// Remember only a boolean. Do not retain or forward provider error content,
// internal response IDs, input payloads, headers or previous model responses.
function createRecoveryCacheMissBoundary(dispatch, transport, streamId) {
  if (
    typeof dispatch !== 'function' ||
    !['http', 'websocket'].includes(transport) ||
    !lane(streamId) ||
    (transport === 'http' && streamId !== undefined)
  )
    throw unavailable();
  let matched = false;
  let active = false;
  let failed = false;
  return Object.freeze({
    async dispatch(request, context) {
      if (matched || active || failed) throw unavailable();
      active = true;
      try {
        const result = await dispatch(request, context);
        matched =
          transport === 'http'
            ? isRecoveryHttpCacheMiss(request, result)
            : isWebSocketCacheMiss(request, result, streamId);
        return result;
      } catch {
        failed = true;
        throw unavailable();
      } finally {
        active = false;
      }
    },
    matched: () => matched,
  });
}

module.exports = {
  createRecoveryCacheMissBoundary,
  isRecoveryHttpCacheMiss,
  recoveryCacheMissBody,
  recoveryCacheMissEvent,
};
