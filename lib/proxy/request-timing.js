'use strict';

const TIMING_KEYS = Object.freeze({
  upstreamHeaders: 'upstreamHeadersAt',
  firstUpstreamChunk: 'firstUpstreamChunkAt',
  firstClientByte: 'firstClientByteAt',
  firstVisibleText: 'firstVisibleTextAt',
});

function validTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function createRequestTiming(startTime = Date.now()) {
  return {
    startTime: validTimestamp(startTime) ? startTime : Date.now(),
    upstreamHeadersAt: null,
    firstUpstreamChunkAt: null,
    firstClientByteAt: null,
    firstVisibleTextAt: null,
  };
}

function markRequestTiming(timing, phase, now = Date.now()) {
  const key = TIMING_KEYS[phase];
  if (!timing || !key || timing[key] != null || !validTimestamp(now) || now < timing.startTime) {
    return false;
  }
  timing[key] = now;
  return true;
}

function hasResponseBytes(chunk) {
  if (chunk == null) return false;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk) > 0;
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk.byteLength > 0;
  return true;
}

function installClientResponseTiming(clientRes, timing, now = Date.now) {
  if (
    !clientRes ||
    !timing ||
    clientRes.__requestTimingCaptureInstalled ||
    typeof clientRes.write !== 'function' ||
    typeof clientRes.end !== 'function'
  ) {
    return;
  }

  const originalWrite = clientRes.write;
  const originalEnd = clientRes.end;
  const markFirstClientByte = (chunk) => {
    if (hasResponseBytes(chunk)) markRequestTiming(timing, 'firstClientByte', now());
  };

  clientRes.write = function timedWrite(chunk) {
    markFirstClientByte(chunk);
    return originalWrite.apply(this, arguments);
  };
  clientRes.end = function timedEnd(chunk) {
    markFirstClientByte(chunk);
    return originalEnd.apply(this, arguments);
  };
  clientRes.__requestTimingCaptureInstalled = true;
}

function observeUpstreamResponse(clientRes, proxyRes, now = Date.now) {
  const timing = clientRes && clientRes.__requestTiming;
  if (!timing || !proxyRes) return;

  markRequestTiming(timing, 'upstreamHeaders', now());
  const onFirstChunk = () => markRequestTiming(timing, 'firstUpstreamChunk', now());
  if (typeof proxyRes.once === 'function') {
    proxyRes.once('data', onFirstChunk);
  }
}

function withUpstreamTiming(clientRes, callback, now = Date.now) {
  if (typeof callback !== 'function') {
    throw new TypeError('withUpstreamTiming requires a callback');
  }
  return function timedUpstreamResponse(proxyRes) {
    observeUpstreamResponse(clientRes, proxyRes, now);
    return callback(proxyRes);
  };
}

function durationFromStart(startTime, eventTime) {
  return validTimestamp(eventTime) && eventTime >= startTime ? eventTime - startTime : null;
}

function snapshotRequestTiming(timing) {
  if (!timing || !validTimestamp(timing.startTime)) return null;
  return {
    upstreamHeadersMs: durationFromStart(timing.startTime, timing.upstreamHeadersAt),
    firstUpstreamChunkMs: durationFromStart(timing.startTime, timing.firstUpstreamChunkAt),
    firstClientByteMs: durationFromStart(timing.startTime, timing.firstClientByteAt),
    firstVisibleTextMs: durationFromStart(timing.startTime, timing.firstVisibleTextAt),
  };
}

module.exports = {
  createRequestTiming,
  hasResponseBytes,
  installClientResponseTiming,
  markRequestTiming,
  observeUpstreamResponse,
  snapshotRequestTiming,
  withUpstreamTiming,
};
