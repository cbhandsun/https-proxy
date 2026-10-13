'use strict';
const { createResponsesClaudeStreamTarget } = require('./responses-claude-stream-target');
const { createConversionStreamBudget } = require('./conversion-stream-budget');
const { createSseEventParser, parseBoundedInteger } = require('./sse-buffer');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function createChatClaudeStream({ options, deps }) {
  const state = { buffer: '', toolCalls: [], usage: null };
  const target = createResponsesClaudeStreamTarget({
    ...options,
    toolToClaude: deps.toolToClaude,
    protocolOptions: deps.protocolOptions,
    errorMessage: 'Upstream Chat stream could not be completed safely',
  });
  const budget = createConversionStreamBudget(deps.protocolOptions);
  const parse = createSseEventParser(
    parseBoundedInteger(deps.protocolOptions?.maxSseBufferChars, 1024 * 1024, 1, 4 * 1024 * 1024)
  );
  const calls = new Map();
  let reason = null;
  let ended = false;
  function abort(sink) {
    if (state.failed) return;
    state.failed = true;
    state.done = true;
    state.buffer = '';
    calls.clear();
    target.fail(sink);
  }
  function payload(sink, value) {
    if (!record(value) || value.error || !Array.isArray(value.choices))
      throw new TypeError('Invalid Chat event');
    if (value.usage != null) {
      if (!record(value.usage)) throw new TypeError('Invalid Chat usage');
      state.usage = value.usage;
    }
    if (!value.choices.length) return;
    if (value.choices.length !== 1) throw new TypeError('Multiple Chat choices unsupported');
    const choice = value.choices[0];
    if (!record(choice) || (choice.index != null && choice.index !== 0) || !record(choice.delta))
      throw new TypeError('Invalid Chat choice');
    const delta = choice.delta;
    if (reason && Object.keys(delta).some((key) => delta[key] != null && delta[key] !== ''))
      throw new TypeError('Chat data after terminal');
    for (const key of ['content', 'reasoning_content', 'reasoning', 'thought'])
      if (delta[key] != null && typeof delta[key] !== 'string')
        throw new TypeError('Invalid Chat text');
    if (delta.refusal || delta.audio || delta.function_call)
      throw new TypeError('Unsupported Chat output');
    const thinking = delta.reasoning_content ?? delta.reasoning ?? delta.thought;
    if (thinking) target.reasoning(sink, state, thinking);
    if (delta.content) target.text(sink, state, delta.content);
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls)) throw new TypeError('Invalid Chat tools');
      for (const call of delta.tool_calls) {
        if (
          !record(call) ||
          !Number.isSafeInteger(call.index) ||
          call.index < 0 ||
          (call.type != null && call.type !== 'function') ||
          (call.id != null && (typeof call.id !== 'string' || !call.id)) ||
          (call.function != null && !record(call.function))
        )
          throw new TypeError('Invalid Chat tool');
        const fn = call.function || {};
        if (
          (fn.name != null && (typeof fn.name !== 'string' || !fn.name.trim())) ||
          (fn.arguments != null && typeof fn.arguments !== 'string')
        )
          throw new TypeError('Invalid Chat arguments');
        let entry = calls.get(call.index);
        if (!entry) {
          budget.addTool(state);
          entry = { arguments: '' };
          calls.set(call.index, entry);
        }
        if (
          (entry.id && call.id && entry.id !== call.id) ||
          (entry.name && fn.name && entry.name !== fn.name)
        )
          throw new TypeError('Conflicting Chat tool');
        if (call.id) entry.id = call.id;
        if (fn.name) entry.name = fn.name;
        if (fn.arguments != null) entry.arguments = budget.appendArguments(entry, fn.arguments);
      }
    }
    if (choice.finish_reason != null) {
      if (
        !['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason) ||
        (reason && reason !== choice.finish_reason)
      )
        throw new TypeError('Invalid Chat terminal');
      reason = choice.finish_reason;
    }
  }
  function event(sink, raw) {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
    if (ended) throw new TypeError('Chat data after DONE');
    if (data === '[DONE]') {
      if (!reason) throw new TypeError('Missing Chat terminal');
      ended = true;
      return;
    }
    payload(sink, JSON.parse(data));
  }
  function start(sink) {
    try {
      target.start(sink);
    } catch {
      abort(sink);
    }
  }
  function processChunk(sink, chunk) {
    if (state.done) return;
    try {
      budget.consume(state, chunk);
      parse(state, chunk, 'Chat', (raw) => event(sink, raw));
    } catch {
      abort(sink);
    }
  }
  function finish(sink) {
    if (state.done) return !state.failed && !state.disposed;
    try {
      if (state.buffer.trim()) event(sink, state.buffer);
      state.buffer = '';
      if (!reason) throw new TypeError('Missing Chat terminal');
      if (reason !== 'length' && reason !== 'content_filter') {
        if (reason === 'tool_calls' && !calls.size) throw new TypeError('Missing Chat tools');
        for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
          if (!call.name || !call.arguments.trim() || !record(JSON.parse(call.arguments)))
            throw new TypeError('Incomplete Chat tool');
          target.tool(sink, state, {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          });
        }
      }
      const ok = target.finish(sink, state.usage, reason);
      state.done = true;
      state.failed = !ok;
      state.finished = ok;
      calls.clear();
      return ok;
    } catch {
      abort(sink);
      return false;
    }
  }
  function dispose() {
    if (state.finished) return;
    state.disposed = true;
    state.done = true;
    state.buffer = '';
    calls.clear();
    target.dispose();
  }
  return { state, start, processChunk, finish, abort, dispose };
}
module.exports = { createChatClaudeStream };
