'use strict';

const { setUtf8StreamEncoding } = require('../utf8-stream');

function createChatToResponsesStreamFinalizer(options = {}) {
  const {
    clientRes,
    state,
    flushOpenAIResponsesSseToChat,
    logRequestEnd,
    method,
    upstreamPath,
    startTime,
  } = options;
  if (!clientRes || typeof clientRes.end !== 'function') {
    throw new TypeError('createChatToResponsesStreamFinalizer requires clientRes');
  }
  if (!state || typeof state !== 'object') {
    throw new TypeError('createChatToResponsesStreamFinalizer requires state');
  }
  if (typeof flushOpenAIResponsesSseToChat !== 'function') {
    throw new TypeError('createChatToResponsesStreamFinalizer requires stream flush handler');
  }
  if (typeof logRequestEnd !== 'function') {
    throw new TypeError('createChatToResponsesStreamFinalizer requires request end logger');
  }

  let settled = false;
  return function finalizeChatToResponsesStream(failureOptions) {
    if (settled) return false;
    settled = true;
    let outcome;
    try {
      outcome = flushOpenAIResponsesSseToChat(clientRes, state, failureOptions || {});
    } catch (_error) {
      outcome = {
        failed: true,
        incomplete: false,
        terminalType: 'stream_finalization_error',
        failure: { code: 'stream_finalization_error' },
      };
      if (typeof clientRes.write === 'function' && clientRes.writableEnded !== true) {
        clientRes.write(
          'data: ' +
            JSON.stringify({
              error: {
                message: 'Failed to finalize upstream Responses stream',
                type: 'upstream_stream_error',
                code: 'stream_finalization_error',
              },
            }) +
            '\n\n'
        );
      }
    }
    clientRes.end();
    const failed = !outcome || outcome.failed === true;
    logRequestEnd(method, upstreamPath, startTime, failed ? 502 : 200, {
      type: failed
        ? 'chat_to_responses_stream_error'
        : outcome.incomplete
          ? 'chat_to_responses_stream_incomplete'
          : 'chat_to_responses_stream',
      upstreamEvent: (outcome && outcome.terminalType) || 'unknown',
      errorCode:
        failed && outcome && outcome.failure ? outcome.failure.code || 'unknown' : undefined,
    });
    return true;
  };
}

function createResponsesChatStreamHandler(dependencies = {}) {
  const {
    CORS_HEADERS = {},
    fallbackId,
    flushOpenAIResponsesSseToChat,
    logRequestEnd,
    processOpenAIResponsesSseChunkToChat,
    stableCreated,
  } = dependencies;

  return function handleResponsesChatStream(options = {}) {
    const { clientReq, clientRes, parsed, proxyRes, startTime, targetModel, upstreamPath } =
      options;
    if (!clientReq || typeof clientReq.method !== 'string') {
      throw new TypeError('handleResponsesChatStream requires clientReq');
    }
    if (!clientRes || typeof clientRes.writeHead !== 'function') {
      throw new TypeError('handleResponsesChatStream requires clientRes');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('handleResponsesChatStream requires parsed request body');
    }
    if (!proxyRes || typeof proxyRes.on !== 'function' || typeof proxyRes.once !== 'function') {
      throw new TypeError('handleResponsesChatStream requires proxyRes');
    }
    if (typeof fallbackId !== 'function' || typeof stableCreated !== 'function') {
      throw new TypeError('handleResponsesChatStream requires stable identifier helpers');
    }
    if (typeof processOpenAIResponsesSseChunkToChat !== 'function') {
      throw new TypeError('handleResponsesChatStream requires stream processor');
    }

    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS,
    });
    const streamSeed = {
      model: parsed.model || targetModel,
      messages: parsed.messages,
      route: targetModel,
    };
    const state = {
      id: fallbackId('chatcmpl', streamSeed),
      created: stableCreated(streamSeed),
      model: parsed.model || targetModel,
      buffer: '',
      started: false,
      toolCalls: [],
      usage: null,
      done: false,
    };
    const finalizeStream = createChatToResponsesStreamFinalizer({
      clientRes,
      state,
      flushOpenAIResponsesSseToChat,
      logRequestEnd,
      method: clientReq.method,
      upstreamPath,
      startTime,
    });

    setUtf8StreamEncoding(proxyRes);
    proxyRes.on('data', (chunk) =>
      processOpenAIResponsesSseChunkToChat(clientRes, chunk.toString('utf8'), state)
    );
    proxyRes.once('end', () => finalizeStream());
    proxyRes.once('aborted', () =>
      finalizeStream({
        terminalType: 'upstream_stream_aborted',
        code: 'upstream_stream_aborted',
        message: 'Upstream Responses stream was aborted before completion',
      })
    );
    proxyRes.once('error', () =>
      finalizeStream({
        terminalType: 'upstream_stream_error',
        code: 'upstream_stream_error',
        message: 'Upstream Responses stream failed before completion',
      })
    );
    proxyRes.once('close', () => {
      if (proxyRes.complete !== true) {
        finalizeStream({
          terminalType: 'upstream_stream_closed',
          code: 'upstream_stream_closed',
          message: 'Upstream Responses stream closed before completion',
        });
      }
    });
    return state;
  };
}

module.exports = {
  createChatToResponsesStreamFinalizer,
  createResponsesChatStreamHandler,
};
