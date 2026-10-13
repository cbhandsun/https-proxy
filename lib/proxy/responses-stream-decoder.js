'use strict';
const { resolveCreatedTimestamp } = require('./ids');
const { conversionFailureCode } = require('./conversion-stream-budget');
const { createResponsesCollector } = require('./forced-stream-collector');
const { assertJsonObjectCompletion } = require('./json-object-output-contract');
function createResponsesStreamDecoder({
  streamBudget,
  parseSseEvents,
  toolToSemantic,
  target,
  terminal,
}) {
  function responseToolCallKeys(payload, fallbackIndex) {
    const keys = [];
    const addKey = (prefix, value) => {
      if (value == null) return;
      const key = `${prefix}:${String(value)}`;
      if (!keys.includes(key)) keys.push(key);
    };
    addKey('item', payload && payload.item_id);
    const item = payload && payload.item;
    if (item) {
      addKey('item', item.call_id);
      addKey('item', item.id);
    }
    addKey('index', payload && payload.output_index);
    addKey('index', payload && payload.item_index);
    if (keys.length === 0) keys.push(`index:${String(fallbackIndex)}`);
    return keys;
  }

  function canonicalResponseToolCallKey(state, keys) {
    if (!state.responseToolCallAliases) state.responseToolCallAliases = new Map();
    if (!state.responseToolCallBuffers) state.responseToolCallBuffers = new Map();
    for (const key of keys) {
      const canonical = state.responseToolCallAliases.get(key) || key;
      if (state.responseToolCallBuffers.has(canonical)) return canonical;
    }
    const canonical = keys[0];
    for (const key of keys) state.responseToolCallAliases.set(key, canonical);
    return canonical;
  }

  function responseToolCallBuffer(state, keys) {
    if (!state.responseToolCallBuffers) state.responseToolCallBuffers = new Map();
    const candidateKeys =
      Array.isArray(keys) && keys.length > 0
        ? keys
        : [`index:${state.responseToolCallBuffers.size}`];
    const id = canonicalResponseToolCallKey(state, candidateKeys);
    let entry = state.responseToolCallBuffers.get(id);
    if (!entry) {
      streamBudget.addTool(state);
      entry = { id, arguments: '', emitted: false };
      state.responseToolCallBuffers.set(id, entry);
    }
    if (!state.responseToolCallAliases) state.responseToolCallAliases = new Map();
    for (const key of candidateKeys) state.responseToolCallAliases.set(key, id);
    return entry;
  }

  function emitBufferedResponseToolCall(clientRes, state, payload) {
    const item = payload.item;
    const entry = responseToolCallBuffer(
      state,
      responseToolCallKeys(
        payload,
        state.responseToolCallBuffers ? state.responseToolCallBuffers.size : 0
      )
    );
    const toolCall = toolToSemantic(item, entry.arguments);
    if (!toolCall) return;

    let toolIndex = state.toolCalls.indexOf(entry.id);
    if (toolIndex === -1) {
      toolIndex = state.toolCalls.length;
      state.toolCalls.push(entry.id);
    }
    if (entry.emitted) return;
    entry.emitted = true;
    streamBudget.appendArguments({}, toolCall.function.arguments);
    target.tool(clientRes, state, toolCall, toolIndex);
  }

  function processEvent(clientRes, event, state) {
    if (state.done) return;
    const lines = String(event || '').split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.indexOf('data:') === 0)
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return;
    const dataText = dataLines.join('\n');
    if (!dataText || dataText === '[DONE]') {
      flush(clientRes, state);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch (err) {
      state.invalidEvent = true;
      terminal.flush(clientRes, state);
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      state.invalidEvent = true;
      terminal.flush(clientRes, state);
      return;
    }
    target.validateEvent?.(payload, state);
    if (
      !state.started &&
      [
        'response.created',
        'response.in_progress',
        'response.completed',
        'response.incomplete',
        'response.failed',
      ].includes(payload.type)
    ) {
      state.created = resolveCreatedTimestamp(payload.response?.created_at, () =>
        resolveCreatedTimestamp(state.created)
      );
    }
    if (state.jsonObjectOutput) {
      state.jsonObjectCollector ||= createResponsesCollector(16 * 1024 * 1024);
      state.jsonObjectCollector.push(event + '\n\n');
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(payload.type)) {
        const response = state.jsonObjectCollector.finish();
        assertJsonObjectCompletion(response, 'responses', {
          text: { format: { type: 'json_object' } },
        });
        if (state.jsonTextSeen && response.status === 'completed') {
          const completedText = (response.output || [])
            .filter((item) => item.type === 'message')
            .flatMap((item) => item.content || [])
            .filter((part) => part.type === 'output_text')
            .map((part) => part.text)
            .join('');
          if (completedText !== state.jsonText) {
            const error = new TypeError('Upstream JSON-object stream output is inconsistent');
            error.code = 'upstream_invalid_json_object';
            throw error;
          }
        }
        if (response.status !== 'failed') {
          if (!state.started) {
            state.started = true;
            target.start(clientRes, state);
          }
          for (const [index, item] of (response.output || []).entries()) {
            if (item.type === 'message') {
              for (const part of item.content || []) {
                if (part.type === 'output_text' && !state.jsonTextSeen)
                  target.text(clientRes, state, part.text);
                else if (part.type === 'refusal' && !state.jsonRefusalSeen)
                  target.refusal?.(clientRes, state, part.refusal);
              }
            } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              emitBufferedResponseToolCall(clientRes, state, { item, output_index: index });
            }
          }
        }
        payload = { ...payload, response };
      }
    }
    if (payload.type === 'response.created' || payload.type === 'response.in_progress') {
      const response = payload.response || {};
      if (response.id) state.id = String(response.id).replace(/^resp/, 'chatcmpl');
      if (!state.started) {
        state.started = true;
        target.start(clientRes, state);
      }
      return;
    }

    if (payload.type === 'response.output_item.added' && payload.item) {
      const item = payload.item;
      if (item.type === 'message' && item.role === 'assistant') {
        if (!state.started) {
          state.started = true;
          target.start(clientRes, state);
        }
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        responseToolCallBuffer(
          state,
          responseToolCallKeys(
            payload,
            state.responseToolCallBuffers ? state.responseToolCallBuffers.size : 0
          )
        );
      }
      return;
    }

    if (payload.type === 'response.output_text.delta' && payload.delta) {
      if (state.jsonObjectOutput) {
        if (typeof payload.delta !== 'string')
          throw new TypeError('Invalid JSON-object text delta');
        state.jsonText = (state.jsonText || '') + payload.delta;
      }
      state.jsonTextSeen = true;
      if (!state.started) {
        state.started = true;
        target.start(clientRes, state);
      }
      target.text(clientRes, state, payload.delta);
      return;
    }
    if (payload.type === 'response.refusal.delta' && typeof payload.delta === 'string') {
      state.jsonRefusalSeen = state.jsonRefusalSeen || Boolean(payload.delta);
      target.refusal?.(clientRes, state, payload.delta);
      return;
    }

    if (
      (payload.type === 'response.reasoning.delta' ||
        payload.type === 'response.reasoning_text.delta' ||
        payload.type === 'response.reasoning_summary_text.delta') &&
      payload.delta
    ) {
      if (!state.started) {
        state.started = true;
        target.start(clientRes, state);
      }
      target.reasoning(clientRes, state, payload.delta);
      return;
    }

    if (payload.type === 'response.function_call_arguments.delta' && payload.delta) {
      const entry = responseToolCallBuffer(
        state,
        responseToolCallKeys(
          payload,
          state.responseToolCallBuffers ? state.responseToolCallBuffers.size : 0
        )
      );
      entry.arguments = streamBudget.appendArguments(entry, payload.delta);
      return;
    }

    if (payload.type === 'response.output_item.done' && payload.item) {
      const item = payload.item;
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        emitBufferedResponseToolCall(clientRes, state, payload);
      }
      return;
    }

    terminal.handleTerminalEvent(clientRes, state, payload);
  }

  function processChunk(clientRes, chunkText, state) {
    if (state.done) return;
    try {
      streamBudget.consume(state, chunkText);
      parseSseEvents(state, chunkText, 'OpenAI Responses', (event) =>
        processEvent(clientRes, event, state)
      );
    } catch (error) {
      state.buffer = '';
      flush(clientRes, state, {
        code: conversionFailureCode(error),
        message: 'Upstream Responses stream exceeded protocol conversion limits',
      });
    }
  }

  function flush(clientRes, state, options = {}) {
    const pendingEvent = state.buffer;
    state.buffer = '';
    if (pendingEvent && pendingEvent.trim()) {
      try {
        processEvent(clientRes, pendingEvent, state);
      } catch (error) {
        options = {
          ...options,
          code: conversionFailureCode(error),
          message: 'Upstream Responses stream could not be converted safely',
        };
      }
    }
    const outcome = terminal.flush(clientRes, state, options);
    if (state.responseToolCallBuffers) state.responseToolCallBuffers.clear();
    if (state.responseToolCallAliases) state.responseToolCallAliases.clear();
    state.jsonObjectCollector?.discard();
    state.jsonObjectCollector = undefined;
    return outcome;
  }

  return { processChunk, flush };
}
module.exports = { createResponsesStreamDecoder };
