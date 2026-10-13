'use strict';
const { Readable } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { createConversionStreamOutput } = require('../conversion-stream-output');
const { sendConversionError } = require('./route-error-utils');
const wbipcStatuses = new Set([
  'cancelled',
  'not_available',
  'host_start_failed',
  'host_recovery_timeout',
  'host_recovery_cooldown',
  'method_unavailable',
  'protocol_error',
  'handshake_failed',
  'endpoint_untrusted',
  'timeout',
  'connection_error',
  'connection_closed',
  'request_failed',
  'error',
  'unavailable',
  'E_PAYLOAD_TOO_LARGE',
]);
function safeWbipcStatus(value) {
  if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  return wbipcStatuses.has(value) ? value : 'unavailable';
}
function createWbipcCancellation({ clientReq, clientRes, onCancel }) {
  const controller = new globalThis.AbortController();
  let settled = false;
  function detach() {
    clientReq.removeListener?.('aborted', close);
    clientRes.removeListener?.('close', close);
    clientRes.removeListener?.('error', error);
  }
  function stop(code) {
    if (settled) return;
    settled = true;
    detach();
    controller.abort();
    onCancel(code);
  }
  function close() {
    stop('client_disconnected');
  }
  function error() {
    stop('downstream_stream_error');
  }
  clientReq.once?.('aborted', close);
  clientRes.once?.('close', close);
  clientRes.once?.('error', error);
  if (clientReq.aborted || clientRes.destroyed || clientRes.writableEnded) close();
  return {
    signal: controller.signal,
    isCanceled: () => controller.signal.aborted,
    complete() {
      if (settled) return;
      settled = true;
      detach();
    },
  };
}
function streamBufferedChatToResponses(options) {
  const {
    responseBody,
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    protocolOptions,
    CORS_HEADERS,
    parsed,
    targetModel,
    chatBody,
    createChatToResponsesBridge,
    processOpenAIChatSseChunkToResponses,
    rememberResponsesFromBridge,
    logRequestEnd,
  } = options;
  const bytes = Buffer.from(responseBody);
  function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += 16384)
      yield bytes.subarray(offset, offset + 16384);
  }
  const input = Readable.from(chunks(), { objectMode: false, highWaterMark: 16384 });
  let bridge,
    settled = false;
  function release() {
    if (!bridge) return;
    const state = bridge.responseState;
    state.failed = true;
    state.done = true;
    state.buffer = '';
    state.text = '';
    for (const key of ['pendingToolCalls', 'toolCalls', 'completedOutputItems'])
      if (Array.isArray(state[key])) state[key].length = 0;
  }
  const flow = createConversionStreamOutput({
    proxyRes: input,
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    protocolOptions,
    logRequestEnd,
    onStop: release,
  });
  if (flow.isStopped()) {
    input.destroy();
    return;
  }
  const sink = flow.clientRes,
    decoder = new StringDecoder('utf8');
  try {
    sink.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS,
    });
    bridge = createChatToResponsesBridge(sink, parsed, targetModel);
  } catch (err) {
    input.destroy();
    sendConversionError({
      ...options,
      clientRes: sink,
      logRequestEnd: flow.logRequestEnd,
      err,
      label: 'WorkBuddy WBIPC Chat stream',
      logType: 'workbuddy_wbipc_chat_stream_to_responses_conversion_error',
    });
    return;
  }
  function finish(invalid = false) {
    if (settled || flow.isStopped()) return;
    settled = true;
    try {
      if (invalid) {
        bridge.responseState.invalidEvent = true;
        bridge.responseState.buffer = '';
      } else processOpenAIChatSseChunkToResponses(sink, decoder.end(), bridge.responseState);
      bridge.flush();
      if (flow.isStopped()) return;
      const failed = bridge.responseState.failed === true;
      if (!failed) rememberResponsesFromBridge(bridge, chatBody);
      sink.end();
      flow.logRequestEnd(clientReq.method, upstreamPath, startTime, failed ? 502 : 200, {
        type: failed ? 'responses_to_chat_stream_error' : 'responses_to_chat_stream',
        transport: 'workbuddy_wbipc',
        errorCode: failed ? bridge.responseState.failure?.code : undefined,
      });
    } catch (err) {
      sendConversionError({
        ...options,
        clientRes: sink,
        logRequestEnd: flow.logRequestEnd,
        err,
        label: 'WorkBuddy WBIPC Chat stream',
        logType: 'workbuddy_wbipc_chat_stream_to_responses_conversion_error',
      });
    }
  }
  input.on('data', (chunk) => {
    if (flow.isStopped() || bridge.responseState.done) return;
    try {
      processOpenAIChatSseChunkToResponses(sink, decoder.write(chunk), bridge.responseState);
    } catch (_error) {
      finish(true);
      input.destroy();
    }
  });
  input.once('end', () => finish());
  input.once('error', () => finish(true));
  return { flow, input };
}
module.exports = { createWbipcCancellation, streamBufferedChatToResponses, safeWbipcStatus };
