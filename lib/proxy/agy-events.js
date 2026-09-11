'use strict';

const { StringDecoder } = require('node:string_decoder');
const { AgyError, record } = require('./agy-chat-request');

function usageFromResult(value) {
  const count = (key) => (Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0);
  const input = count('input_tokens');
  const output = count('output_tokens') + count('thinking_tokens');
  if (!Number.isSafeInteger(input + output)) throw new AgyError('agy_invalid_output');
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function createEventParser({ onDelta = () => {}, maxBytes = 4 * 1024 * 1024 } = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '',
    bytes = 0,
    initialized = false,
    result = null,
    streamed = '';
  function line(text) {
    if (!text.trim()) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      throw new AgyError('agy_invalid_output');
    }
    if (!record(event) || typeof event.event !== 'string' || result)
      throw new AgyError('agy_invalid_output');
    if (event.event === 'init') {
      if (initialized || !record(event.init)) throw new AgyError('agy_invalid_output');
      initialized = true;
      return;
    }
    if (!initialized) throw new AgyError('agy_invalid_output');
    if (event.event === 'step_update') {
      const step = event.step_update;
      if (!record(step)) throw new AgyError('agy_invalid_output');
      // Defense in depth: refuse tool-using runs. CLI deny policies are the
      // preventative boundary; observing an event alone cannot prevent a tool.
      if (step.step_type === 'tool') throw new AgyError('agy_tools_not_allowed', 422);
      if (step.step_type === 'agent_response' && step.text_delta !== undefined) {
        if (typeof step.text_delta !== 'string') throw new AgyError('agy_invalid_output');
        streamed += step.text_delta;
        onDelta(step.text_delta);
      }
      return;
    }
    if (event.event === 'result') {
      const value = event.result;
      if (!record(value)) throw new AgyError('agy_invalid_output');
      if (value.status !== 'SUCCESS') {
        const message = typeof value.error === 'string' ? value.error : '';
        if (/authentication required/i.test(message))
          throw new AgyError('agy_authentication_required', 503);
        if (/permission.denied|caller does not have permission/i.test(message))
          throw new AgyError('agy_permission_denied', 403);
        throw new AgyError('agy_generation_failed');
      }
      if (typeof value.response !== 'string' || !value.response.trim())
        throw new AgyError('agy_empty_response');
      if (streamed && streamed !== value.response) throw new AgyError('agy_inconsistent_stream');
      if (!streamed) onDelta(value.response);
      result = { text: value.response, usage: usageFromResult(value.usage) };
      return;
    }
    throw new AgyError('agy_invalid_output');
  }
  return {
    push(chunk) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new AgyError('agy_output_too_large');
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const next = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        line(next);
      }
      if (buffer.length > 512 * 1024) throw new AgyError('agy_output_too_large');
    },
    finish() {
      buffer += decoder.end();
      if (buffer.trim()) line(buffer);
      if (!result) throw new AgyError('agy_incomplete_output');
      return result;
    },
  };
}

module.exports = { createEventParser, usageFromResult };
