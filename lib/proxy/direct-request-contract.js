'use strict';
const { Transform } = require('node:stream');

function directRequestError(statusCode = 400) {
  const error = new TypeError('Direct request could not be processed safely');
  error.statusCode = statusCode;
  error.code =
    statusCode === 413
      ? 'request_too_large'
      : statusCode === 502
        ? 'upstream_request_error'
        : 'invalid_request_error';
  return error;
}

// Observe the bounded upload without delaying its bytes. Keep only protocol
// controls once the body is complete; never expose captured user content.
function createDirectRequestObserver(maxBytes, onParsedBody) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Invalid direct request byte limit');
  if (onParsedBody !== undefined && typeof onParsedBody !== 'function')
    throw new TypeError('Invalid direct request observer');
  const { convertedOutputFormat } = require('./converted-output-format');
  const chunks = [];
  let bytes = 0;
  let metadata;
  const observer = new Transform({
    transform(chunk, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxBytes) {
        chunks.length = 0;
        callback(directRequestError(413));
        return;
      }
      chunks.push(Buffer.from(data));
      callback(null, chunk);
    },
    flush(callback) {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          (body.stream != null && typeof body.stream !== 'boolean')
        )
          throw directRequestError();
        const format = convertedOutputFormat(body, 'responses', 'Chat', body.model);
        metadata = {
          stream: body.stream === true,
          request:
            format?.type === 'json_object'
              ? {
                  kind: 'chat',
                  source: {
                    response_format: body.response_format,
                    text: body.text,
                    tools: body.tools,
                  },
                }
              : null,
        };
        if (onParsedBody) onParsedBody(body);
        chunks.length = 0;
        callback();
      } catch {
        chunks.length = 0;
        callback(directRequestError());
      }
    },
    destroy(error, callback) {
      chunks.length = 0;
      callback(error);
    },
  });
  return { observer, metadata: () => metadata };
}

function deferDirectResponse({ capture, proxyRes, onReady, onFailure }) {
  let settled = false;
  const observer = capture.observer;
  function detach() {
    observer.removeListener('finish', ready);
    observer.removeListener('error', failed);
    observer.removeListener('close', requestClosed);
    proxyRes.removeListener('error', upstreamFailed);
    proxyRes.removeListener('aborted', upstreamFailed);
    proxyRes.removeListener('close', upstreamFailed);
  }
  function fail(error) {
    if (settled) return;
    settled = true;
    detach();
    onFailure(error);
    proxyRes.destroy?.();
  }
  function failed(error) {
    fail(directRequestError(error?.statusCode === 413 ? 413 : 400));
  }
  function upstreamFailed() {
    fail(directRequestError(502));
  }
  function requestClosed() {
    if (!capture.metadata()) fail(directRequestError());
  }
  function ready() {
    if (settled) return;
    const metadata = capture.metadata();
    if (!metadata) {
      failed();
      return;
    }
    settled = true;
    detach();
    onReady(metadata);
    proxyRes.resume?.();
  }
  proxyRes.pause?.();
  if (proxyRes.destroyed) {
    upstreamFailed();
    return;
  }
  if (capture.metadata()) {
    ready();
    return;
  }
  if (observer.destroyed) {
    failed();
    return;
  }
  observer.once('finish', ready);
  observer.once('error', failed);
  observer.once('close', requestClosed);
  proxyRes.once('error', upstreamFailed);
  proxyRes.once('aborted', upstreamFailed);
  proxyRes.once('close', upstreamFailed);
}

module.exports = { createDirectRequestObserver, deferDirectResponse };
