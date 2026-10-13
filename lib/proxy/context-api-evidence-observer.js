'use strict';

const { MAX_WIRE_BYTES, decodeApiEvidenceResponse } = require('./context-api-evidence-protocol');

// Observe only the bytes actually sent to this client, after protocol conversion.
// Never rewrite them, await a model, infer a tool execution, or affect backpressure.
function installApiEvidenceResponseObserver(response, kind, capability) {
  const release = capability.acquireObservation();
  if (!release) return { close() {} };
  const chunks = [];
  let bytes = 0;
  let rejected = false;
  let settled = false;
  const originalWrite = response.write;
  const originalEnd = response.end;
  function reject() {
    if (!rejected) capability.observationFailed();
    rejected = true;
    chunks.length = 0;
  }
  function observe(value, encoding) {
    if (rejected || settled || value == null) return;
    try {
      const buffer = Buffer.isBuffer(value)
        ? value
        : typeof value === 'string'
          ? Buffer.from(value, typeof encoding === 'string' ? encoding : 'utf8')
          : value instanceof Uint8Array
            ? Buffer.from(value)
            : null;
      if (!buffer || bytes + buffer.length > MAX_WIRE_BYTES) {
        reject();
        return;
      }
      bytes += buffer.length;
      chunks.push(Buffer.from(buffer));
    } catch {
      reject();
    }
  }
  function write(chunk, encoding, callback) {
    const result = originalWrite.call(this, chunk, encoding, callback);
    observe(chunk, encoding);
    return result;
  }
  function end(chunk, encoding, callback) {
    if (typeof chunk !== 'function') observe(chunk, encoding);
    return originalEnd.call(this, chunk, encoding, callback);
  }
  function detach() {
    release();
    if (response.write === write) response.write = originalWrite;
    if (response.end === end) response.end = originalEnd;
    response.removeListener('finish', finish);
    response.removeListener('close', close);
    response.removeListener('error', close);
  }
  function close() {
    if (settled) return;
    settled = true;
    reject();
    detach();
  }
  function finish() {
    if (settled) return;
    settled = true;
    detach();
    try {
      if (rejected || response.statusCode < 200 || response.statusCode >= 300 || !bytes) return;
      const encoding = response.getHeader('content-encoding');
      if (encoding && encoding !== 'identity') {
        reject();
        return;
      }
      const wire = Buffer.concat(chunks);
      const contentType = String(response.getHeader('content-type') ?? '');
      // Some native Responses servers omit Content-Type. JSON vs SSE framing is
      // checked by the strict decoder; this fallback does not alter wire bytes.
      const stream =
        contentType.includes('text/event-stream') ||
        (!contentType && /^(?:event:|data:)/.test(wire.toString('utf8').trimStart()));
      capability.observeCalls(kind, decodeApiEvidenceResponse(kind, wire, stream));
    } catch {
      reject();
    } finally {
      chunks.length = 0;
    }
  }
  response.write = write;
  response.end = end;
  response.once('finish', finish);
  response.once('close', close);
  response.once('error', close);
  return { close };
}

module.exports = { installApiEvidenceResponseObserver };
