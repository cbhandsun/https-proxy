'use strict';
const { convertUsageDetails } = require('./protocol-usage-details');
const { responsesFinishReason } = require('./protocol-terminal');

function safeErrorText(value, fallback, maxChars) {
  if (typeof value !== 'string') return fallback;
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  })
    .join('')
    .trim();
  if (!normalized) return fallback;
  return normalized.slice(0, maxChars);
}

function safeErrorCode(value, fallback) {
  const text = safeErrorText(value, fallback, 96);
  const normalized = text.replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || fallback;
}

function streamFailure(payload, fallback = {}) {
  const response =
    payload && payload.response && typeof payload.response === 'object' ? payload.response : {};
  const source =
    response.error && typeof response.error === 'object'
      ? response.error
      : payload && payload.error && typeof payload.error === 'object'
        ? payload.error
        : payload && payload.type === 'error'
          ? payload
          : {};
  return {
    code: safeErrorCode(source.code, fallback.code || 'upstream_response_failed'),
    type: safeErrorCode(source.type, fallback.type || 'upstream_response_error'),
    message: safeErrorText(
      source.message,
      fallback.message || 'Upstream Responses API generation failed',
      512
    ),
  };
}

function writeStreamError(clientRes, state, failure, emitFailure) {
  if (state.done) return;
  state.done = true;
  state.failed = true;
  state.terminalType = state.terminalType || 'response.failed';
  state.failure = failure;
  if (emitFailure) {
    emitFailure(clientRes, state, failure);
    return;
  }
  clientRes.write(
    'data: ' +
      JSON.stringify({
        error: {
          message: failure.message,
          type: failure.type,
          code: failure.code,
        },
      }) +
      '\n\n'
  );
}

function applyUsage(state, response) {
  if (!response || !response.usage) return;
  state.usage = {
    prompt_tokens: response.usage.input_tokens || 0,
    completion_tokens: response.usage.output_tokens || 0,
    total_tokens:
      response.usage.total_tokens ||
      (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
    ...convertUsageDetails(response.usage, false),
  };
}

function streamOutcome(state) {
  return {
    ok: state.done === true && state.failed !== true,
    failed: state.failed === true,
    incomplete: state.incomplete === true,
    terminalType: state.terminalType || '',
    failure: state.failure || null,
  };
}

function createResponsesTerminalStateMachine(options = {}) {
  const { writeChatChunk, onComplete, onFailure } = options;
  if (typeof writeChatChunk !== 'function' && typeof onComplete !== 'function') {
    throw new TypeError('createResponsesChatTerminalStateMachine requires writeChatChunk');
  }

  function complete(clientRes, state, response, terminalType) {
    if (state.done) return;
    const resp = response && typeof response === 'object' ? response : {};
    applyUsage(state, resp);
    const hasToolCalls = state.toolCalls.length > 0;
    const incomplete = terminalType === 'response.incomplete' || resp.status === 'incomplete';
    const finishReason = responsesFinishReason(resp, hasToolCalls, terminalType);

    if (onComplete)
      onComplete(clientRes, state, { response: resp, finishReason, incomplete, terminalType });
    else {
      writeChatChunk(clientRes, state, {}, finishReason);
      clientRes.write('data: [DONE]\n\n');
    }
    state.done = true;
    state.failed = false;
    state.incomplete = incomplete;
    state.terminalType = terminalType;
  }

  function handleTerminalEvent(clientRes, state, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (payload.type === 'response.completed' && payload.response) {
      if (payload.response.status === 'failed') {
        state.terminalType = 'response.failed';
        writeStreamError(clientRes, state, streamFailure(payload), onFailure);
      } else {
        complete(clientRes, state, payload.response, payload.type);
      }
      return true;
    }
    if (payload.type === 'response.incomplete' && payload.response) {
      complete(clientRes, state, payload.response, payload.type);
      return true;
    }
    if (payload.type === 'response.failed' || payload.type === 'error') {
      state.terminalType = payload.type;
      writeStreamError(clientRes, state, streamFailure(payload), onFailure);
      return true;
    }
    return false;
  }

  function flush(clientRes, state, options = {}) {
    if (!state.done) {
      const invalidEvent = state.invalidEvent === true;
      state.terminalType = options.terminalType || 'upstream_stream_ended';
      writeStreamError(
        clientRes,
        state,
        streamFailure(null, {
          code:
            options.code ||
            (invalidEvent ? 'upstream_stream_invalid_event' : 'upstream_stream_incomplete'),
          type: options.type || 'upstream_stream_error',
          message:
            options.message ||
            (invalidEvent
              ? 'Upstream Responses stream contained an invalid event'
              : 'Upstream Responses stream ended before a terminal event'),
        }),
        onFailure
      );
    }
    return streamOutcome(state);
  }

  return { flush, handleTerminalEvent };
}

function createResponsesChatTerminalStateMachine(options) {
  return createResponsesTerminalStateMachine(options);
}
module.exports = { createResponsesChatTerminalStateMachine, createResponsesTerminalStateMachine };
