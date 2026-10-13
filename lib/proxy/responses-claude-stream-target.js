'use strict';
const { createConversionStreamBudget } = require('./conversion-stream-budget');
const { openAIChatUsageToClaudeUsage } = require('./protocol-usage-details');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function createResponsesClaudeStreamTarget({
  writeEvent,
  toolToClaude,
  protocolOptions,
  id,
  model,
  errorMessage = 'Upstream Responses stream could not be completed safely',
}) {
  const budget = createConversionStreamBudget(protocolOptions);
  const output = {};
  const tools = [];
  let index = -1;
  let open = null;
  let started = false;
  let settled = false;
  const frame = (name, data) => ({ name, data: { type: name, ...data } });
  const encode = (entry) =>
    'event: ' + entry.name + '\ndata: ' + JSON.stringify(entry.data) + '\n\n';
  const send = (sink, entry) => writeEvent(sink, entry.name, entry.data, { safeToolUse: false });
  function emit(sink, entry) {
    budget.consume(output, encode(entry));
    send(sink, entry);
  }
  function start(sink) {
    if (started) return;
    emit(
      sink,
      frame('message_start', {
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    );
    started = true;
  }
  function delta(sink, type, value) {
    start(sink);
    if (open !== type) {
      if (open) emit(sink, frame('content_block_stop', { index }));
      index++;
      open = type;
      emit(
        sink,
        frame('content_block_start', {
          index,
          content_block:
            type === 'text'
              ? { type: 'text', text: '' }
              : { type: 'thinking', thinking: '', signature: 'deepseek-reasoning' },
        })
      );
    }
    emit(
      sink,
      frame('content_block_delta', {
        index,
        delta:
          type === 'text'
            ? { type: 'text_delta', text: value }
            : { type: 'thinking_delta', thinking: value },
      })
    );
  }
  function tool(_sink, _state, call) {
    const block = toolToClaude(call);
    if (
      !block ||
      !record(block.input) ||
      typeof block.name !== 'string' ||
      !block.name.trim() ||
      typeof block.id !== 'string' ||
      !block.id
    )
      throw new TypeError('Invalid upstream Responses tool');
    const args = JSON.stringify(block.input);
    budget.appendArguments({}, args);
    tools.push({ block, args });
  }
  function fail(sink) {
    if (settled) return;
    settled = true;
    tools.length = 0;
    send(
      sink,
      frame('error', {
        error: {
          type: 'api_error',
          message: errorMessage,
        },
      })
    );
  }
  function finish(sink, usage, reason) {
    if (settled) return false;
    if (reason === 'content_filter') {
      fail(sink);
      return false;
    }
    const frames = [];
    if (open) frames.push(frame('content_block_stop', { index }));
    if (reason !== 'length') {
      for (const { block, args } of tools) {
        index++;
        frames.push(
          frame('content_block_start', {
            index,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          })
        );
        for (let offset = 0; offset < args.length; offset += 8192)
          frames.push(
            frame('content_block_delta', {
              index,
              delta: { type: 'input_json_delta', partial_json: args.slice(offset, offset + 8192) },
            })
          );
        frames.push(frame('content_block_stop', { index }));
      }
    }
    frames.push(
      frame('message_delta', {
        delta: {
          stop_reason: reason === 'length' ? 'max_tokens' : tools.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: openAIChatUsageToClaudeUsage(usage),
      })
    );
    frames.push(frame('message_stop', {}));
    for (const entry of frames) budget.consume(output, encode(entry));
    for (const entry of frames) send(sink, entry);
    tools.length = 0;
    settled = true;
    return true;
  }
  return {
    start,
    text: (sink, _state, value) => delta(sink, 'text', value),
    reasoning: (sink, _state, value) => delta(sink, 'thinking', value),
    tool,
    fail,
    finish,
    dispose() {
      tools.length = 0;
      settled = true;
    },
  };
}
module.exports = { createResponsesClaudeStreamTarget };
