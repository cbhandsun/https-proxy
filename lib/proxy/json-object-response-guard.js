'use strict';

const { StringDecoder } = require('node:string_decoder');
const {
  jsonObjectRequested,
  assertJsonObjectCompletion,
} = require('./json-object-output-contract');
const {
  createChatCompletionCollector,
  createResponsesCollector,
} = require('./forced-stream-collector');
const { createSseEventParser } = require('./sse-buffer');
const { createConversionStreamOutput } = require('./conversion-stream-output');

function jsonObjectPassthroughRequest(buffer, requestPath) {
  const path = typeof requestPath === 'string' ? requestPath.split('?')[0] : '';
  const kind = /\/chat\/completions\/?$/.test(path)
    ? 'chat'
    : /\/responses\/?$/.test(path)
      ? 'responses'
      : null;
  if (!kind || !Buffer.isBuffer(buffer)) return null;
  let source;
  try {
    source = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  return jsonObjectRequested(source) ? { kind, source } : null;
}

// Forward deltas incrementally, but release success markers only after bounded
// collection and output validation. Late invalid events cannot follow success.
function guardJsonObjectResponse({
  proxyRes,
  clientRes,
  clientReq,
  headers,
  statusCode,
  request,
  isStream,
  clientStreaming,
  maxBytes,
  sendJsonError,
  onComplete = () => {},
  onFailure = () => {},
  protocolOptions = {},
}) {
  if (
    !request ||
    !['chat', 'responses'].includes(request.kind) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  ) {
    throw new TypeError('Invalid JSON-object response guard options');
  }
  let ended = false,
    reported = false,
    successful = false;
  let bytes = 0;
  const chunks = [],
    held = [];
  const parserState = { buffer: '' };
  const decoder = new StringDecoder('utf8');
  const parse = createSseEventParser(maxBytes);
  const collector = isStream
    ? request.kind === 'chat'
      ? createChatCompletionCollector(maxBytes)
      : createResponsesCollector(maxBytes)
    : null;
  const streaming = isStream && clientStreaming !== false;
  let holdTerminal = false;
  let sawDone = false;
  const reportFailure = (code) => {
    if (reported) return;
    reported = true;
    onFailure(code);
  };
  const flow = createConversionStreamOutput({
    proxyRes,
    clientRes,
    clientReq,
    protocolOptions,
    logRequestEnd: () => {},
    onStop: (code) => {
      ended = true;
      clear();
      reportFailure(code);
    },
  });
  const sink = flow.clientRes;
  function clear() {
    chunks.length = 0;
    held.length = 0;
    parserState.buffer = '';
    collector?.discard?.();
  }
  const safeHeaders = { ...headers };
  delete safeHeaders['content-length'];
  delete safeHeaders['transfer-encoding'];
  delete safeHeaders['content-encoding'];
  function start() {
    if (!clientRes.headersSent)
      sink.writeHead(statusCode, {
        ...safeHeaders,
        'content-type': streaming
          ? 'text/event-stream; charset=utf-8'
          : 'application/json; charset=utf-8',
      });
  }
  function fail(code = 'upstream_invalid_json_object') {
    if (ended) return;
    ended = true;
    clear();
    reportFailure(code);
    const error = {
      type: 'upstream_error',
      code,
      message: 'Upstream JSON-object response could not be completed safely',
    };
    if (!clientRes.headersSent) sendJsonError(sink, 502, { error });
    else {
      const payload =
        request.kind === 'responses'
          ? {
              type: 'response.failed',
              response: { object: 'response', status: 'failed', error, output: [] },
            }
          : { error };
      sink.write(
        (request.kind === 'responses' ? 'event: response.failed\n' : '') +
          'data: ' +
          JSON.stringify(payload) +
          '\n\n'
      );
      sink.end('data: [DONE]\n\n');
    }
    proxyRes.destroy?.();
  }
  function event(block) {
    if (ended) return;
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    const wire = block + '\n\n';
    if (sawDone && data) throw new Error('Data after terminal marker');
    collector.push(wire);
    if (data === '[DONE]') {
      holdTerminal = true;
      sawDone = true;
    } else if (data) {
      const payload = JSON.parse(data);
      if (request.kind === 'chat') {
        if (
          payload.object === 'chat.completion' ||
          payload.choices?.some((choice) => choice?.finish_reason != null)
        )
          holdTerminal = true;
      } else if (
        ['response.completed', 'response.incomplete', 'response.failed'].includes(payload.type) ||
        (payload.object === 'response' &&
          ['completed', 'incomplete', 'failed'].includes(payload.status))
      )
        holdTerminal = true;
    }
    if (!streaming) return;
    if (holdTerminal) held.push(wire);
    else {
      start();
      sink.write(wire);
    }
  }
  clientRes.once('finish', () => {
    if (!successful || reported) return;
    reported = true;
    onComplete();
  });
  proxyRes.on('data', (chunk) => {
    if (ended) return;
    try {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxBytes) {
        fail('upstream_json_object_too_large');
        return;
      }
      if (isStream) parse(parserState, decoder.write(data), 'JSON-object', event);
      else chunks.push(Buffer.from(data));
    } catch {
      fail();
    }
  });
  proxyRes.on('end', () => {
    if (ended) return;
    try {
      let payload;
      if (isStream) {
        parse(parserState, decoder.end(), 'JSON-object', event);
        if (parserState.buffer.trim()) event(parserState.buffer);
        payload = collector.finish();
      } else payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assertJsonObjectCompletion(payload, request.kind, request.source, { maxBytes });
      ended = true;
      successful = payload.status !== 'failed';
      if (!successful) reportFailure('upstream_json_object_failed');
      start();
      if (streaming) {
        for (const wire of held) sink.write(wire);
        sink.end();
      } else sink.end(JSON.stringify(payload));
      clear();
    } catch {
      fail();
    }
  });
  proxyRes.on('error', () => fail('upstream_json_object_aborted'));
  proxyRes.on('aborted', () => fail('upstream_json_object_aborted'));
  proxyRes.on('close', () => {
    if (!ended) fail('upstream_json_object_aborted');
  });
  if (headers['content-encoding'] && headers['content-encoding'] !== 'identity')
    fail('upstream_json_object_encoding');
}

module.exports = { jsonObjectPassthroughRequest, guardJsonObjectResponse };
