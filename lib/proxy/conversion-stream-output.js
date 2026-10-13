'use strict';

const { parseBoundedInteger } = require('./sse-buffer');
const CONVERSION_OUTPUT_LOG = Symbol('conversionOutputLog');

function createConversionStreamOutput({
  proxyRes,
  clientRes,
  clientReq,
  upstreamPath,
  startTime,
  logRequestEnd,
  protocolOptions = {},
  onStop = () => {},
}) {
  const maxBytes = parseBoundedInteger(
    protocolOptions.maxConversionOutputBufferBytes,
    8 * 1024 * 1024,
    1,
    32 * 1024 * 1024
  );
  const timeoutMs = parseBoundedInteger(protocolOptions.conversionDrainTimeoutMs, 30000, 1, 120000);
  const queue = [];
  let queuedBytes = 0;
  let blocked = false;
  let ending = false;
  let stopped = false;
  let finished = false;
  let timer;
  let endArgs;
  let endReport;
  let reported = false;

  function detach() {
    clearTimeout(timer);
    clientRes.removeListener?.('drain', drain);
    clientRes.removeListener?.('close', close);
    clientRes.removeListener?.('error', downstreamError);
    clientRes.removeListener?.('finish', finish);
  }
  function report(status, code) {
    if (reported) return;
    reported = true;
    logRequestEnd(clientReq.method, upstreamPath, startTime, status, {
      type: status === 499 ? 'conversion_client_disconnected' : 'conversion_output_error',
      errorCode: code,
    });
  }
  function stop(code, disconnected = false) {
    if (stopped || finished) return;
    stopped = true;
    detach();
    queue.length = 0;
    queuedBytes = 0;
    endReport = undefined;
    onStop(code);
    report(disconnected ? 499 : 502, code);
    proxyRes.destroy?.();
    if (!disconnected) clientRes.destroy?.();
  }
  function close() {
    if (!finished) stop('client_disconnected', true);
  }
  function downstreamError() {
    stop('downstream_stream_error');
  }
  function finish() {
    if (stopped || finished) return;
    finished = true;
    detach();
    queue.length = 0;
    queuedBytes = 0;
    if (endReport && !reported) {
      reported = true;
      logRequestEnd(...endReport);
    }
  }
  function pressure() {
    blocked = true;
    proxyRes.pause?.();
    if (!timer) {
      timer = setTimeout(() => stop('downstream_stream_drain_timeout'), timeoutMs);
      timer.unref?.();
    }
  }
  function bufferedBytes() {
    const length = clientRes.writableLength;
    return queuedBytes + (Number.isSafeInteger(length) && length > 0 ? length : 0);
  }
  function flushEnd() {
    if (!ending || stopped || blocked || queue.length) return;
    clientRes.end(...endArgs);
    // Lightweight injected sinks have no stream lifecycle events.
    if (typeof clientRes.once !== 'function') finish();
  }
  function rawWrite(entry) {
    try {
      const accepted = clientRes.write(entry.chunk, entry.encoding, entry.callback);
      if (accepted === false) pressure();
      if (bufferedBytes() > maxBytes) stop('downstream_stream_buffer_limit');
      return !stopped && accepted !== false;
    } catch {
      stop('downstream_stream_write_error');
      return false;
    }
  }
  function write(chunk, encoding, callback) {
    if (stopped || ending || finished || clientRes.destroyed) return false;
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      stop('downstream_stream_invalid_chunk');
      return false;
    }
    let bytes;
    try {
      bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    } catch {
      stop('downstream_stream_invalid_chunk');
      return false;
    }
    if (bufferedBytes() + bytes > maxBytes) {
      stop('downstream_stream_buffer_limit');
      return false;
    }
    const entry = { chunk, encoding, callback, bytes };
    if (blocked) {
      if (queue.length >= 8192) {
        stop('downstream_stream_buffer_limit');
        return false;
      }
      // Own queued byte arrays so caller mutation cannot alter deferred output.
      if (typeof chunk !== 'string') entry.chunk = Buffer.from(chunk);
      queue.push(entry);
      queuedBytes += bytes;
      return false;
    }
    return rawWrite(entry);
  }
  function drain() {
    if (stopped || finished) return;
    blocked = false;
    clearTimeout(timer);
    timer = undefined;
    while (queue.length && !blocked && !stopped) {
      const entry = queue.shift();
      queuedBytes -= entry.bytes;
      rawWrite(entry);
    }
    if (stopped || blocked) return;
    if (ending) flushEnd();
    else proxyRes.resume?.();
  }
  function end(chunk, encoding, callback) {
    if (stopped || ending || finished) return;
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    }
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk != null) write(chunk, encoding);
    if (stopped) return;
    ending = true;
    endArgs = callback ? [callback] : [];
    flushEnd();
  }
  function deferredLog(...args) {
    if (stopped || reported) return;
    endReport = args;
    if (finished) {
      reported = true;
      logRequestEnd(...args);
    }
  }
  const sink = new Proxy(clientRes, {
    get(target, property) {
      if (property === CONVERSION_OUTPUT_LOG) return deferredLog;
      if (property === 'write') return write;
      if (property === 'end') return end;
      if (property === 'writableEnded') return ending || target.writableEnded;
      if (property === 'destroyed') return stopped || target.destroyed;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  clientRes.on?.('drain', drain);
  clientRes.once?.('close', close);
  clientRes.once?.('error', downstreamError);
  clientRes.once?.('finish', finish);
  if (clientRes.destroyed) stop('client_disconnected', true);
  return {
    clientRes: sink,
    logRequestEnd: deferredLog,
    isStopped: () => stopped,
    dispose() {
      stopped = true;
      detach();
      queue.length = 0;
      queuedBytes = 0;
    },
  };
}

module.exports = { createConversionStreamOutput, CONVERSION_OUTPUT_LOG };
