'use strict';

const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { decodeContextRecoveryResponse } = require('./context-recovery-protocol');
const { invokeRecoveryPublication } = require('./context-recovery-publication');

// Capture the final client protocol, not a provider's intermediate conversion.
// This observer never rewrites bytes or dispatches a model/tool request.
function installContextRecoveryObserver(response, kind, session) {
  const originalWrite = response.write;
  const originalEnd = response.end;
  const chunks = [];
  let bytes = 0;
  let settled = false;
  function detach() {
    if (response.write === write) response.write = originalWrite;
    if (response.end === end) response.end = originalEnd;
    response.removeListener('finish', finish);
    response.removeListener('close', abort);
    response.removeListener('error', abort);
  }
  function abort() {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    detach();
    session.abort();
  }
  function observe(value, encoding) {
    if (settled || value == null) return;
    const data = Buffer.isBuffer(value)
      ? value
      : typeof value === 'string'
        ? Buffer.from(value, typeof encoding === 'string' ? encoding : 'utf8')
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : null;
    if (!data || bytes + data.length > MAX_WIRE_BYTES) {
      abort();
      return;
    }
    bytes += data.length;
    chunks.push(Buffer.from(data));
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
  function finish() {
    if (settled) return;
    settled = true;
    detach();
    try {
      if (response.statusCode < 200 || response.statusCode >= 300 || !bytes)
        throw new TypeError('Invalid recovery response');
      const encoding = response.getHeader('content-encoding');
      if (encoding && encoding !== 'identity') throw new TypeError('Unsupported recovery response');
      const wire = Buffer.concat(chunks);
      const type = String(response.getHeader('content-type') ?? '');
      const stream =
        type.includes('text/event-stream') ||
        (!type && /^(?:event:|data:)/.test(wire.toString('utf8').trimStart()));
      const decoded = decodeContextRecoveryResponse(kind, wire, stream);
      if (Object.getOwnPropertyDescriptor(session, 'completeObservedAsync')) {
        void invokeRecoveryPublication(session, 'observed', [
          decoded.output,
          decoded.calls,
          decoded.responseId,
        ]).catch(() => {
          void invokeRecoveryPublication(session, 'abort').catch(() => {});
        });
      } else if (!session.complete(decoded.output, decoded.calls, decoded.responseId).ok)
        session.abort();
    } catch {
      session.abort();
    } finally {
      chunks.length = 0;
    }
  }
  response.write = write;
  response.end = end;
  response.once('finish', finish);
  response.once('close', abort);
  response.once('error', abort);
  return {
    close: abort,
    // Transfer ownership to the internal runner before publishing any bytes.
    // Unlike close(), this leaves the session alive for its explicit commit.
    detach() {
      if (settled || bytes !== 0) return false;
      settled = true;
      chunks.length = 0;
      detach();
      return true;
    },
  };
}

module.exports = { installContextRecoveryObserver };
