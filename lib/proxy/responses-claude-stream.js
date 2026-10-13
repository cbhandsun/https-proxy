'use strict';
const { createConversionStreamBudget } = require('./conversion-stream-budget');
const { createSseEventParser, parseBoundedInteger } = require('./sse-buffer');
const { createResponsesTerminalStateMachine } = require('./protocol-openai-responses-stream');
const { createResponsesStreamDecoder } = require('./responses-stream-decoder');
const { createResponsesClaudeStreamTarget } = require('./responses-claude-stream-target');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const toolTypes = ['function_call', 'custom_tool_call'];
const deltaTypes = [
  'response.output_text.delta',
  'response.reasoning.delta',
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
  'response.function_call_arguments.delta',
];

function createResponsesClaudeStream({ deps, options }) {
  const state = { buffer: '', toolCalls: [], usage: null, done: false };
  const target = createResponsesClaudeStreamTarget({
    ...options,
    toolToClaude: deps.toolToClaude,
    protocolOptions: deps.protocolOptions,
  });
  let terminalInfo;
  let completed = false;
  function abort(sink) {
    state.failed = true;
    state.done = true;
    target.fail(sink);
  }
  function validateEvent(payload) {
    if (typeof payload.type !== 'string' || !payload.type)
      throw new TypeError('Invalid Responses event');
    if (deltaTypes.includes(payload.type) && typeof payload.delta !== 'string')
      throw new TypeError('Invalid Responses delta');
    if (payload.item_id != null && (typeof payload.item_id !== 'string' || !payload.item_id))
      throw new TypeError('Invalid Responses item ID');
    for (const key of ['output_index', 'item_index'])
      if (payload[key] != null && (!Number.isSafeInteger(payload[key]) || payload[key] < 0))
        throw new TypeError('Invalid Responses item index');
    if (
      [
        'response.created',
        'response.in_progress',
        'response.completed',
        'response.incomplete',
      ].includes(payload.type) &&
      !record(payload.response)
    )
      throw new TypeError('Invalid Responses metadata');
    if (
      payload.type.startsWith('response.refusal.') ||
      payload.type.startsWith('response.output_audio.')
    )
      throw new TypeError('Unsupported Responses content');
    if (
      payload.type === 'response.content_part.added' &&
      (!record(payload.part) ||
        !['output_text', 'text', 'reasoning_text'].includes(payload.part.type) ||
        typeof payload.part.text !== 'string')
    )
      throw new TypeError('Unsupported Responses content');
    if (['response.output_item.added', 'response.output_item.done'].includes(payload.type)) {
      const item = payload.item;
      if (
        !record(item) ||
        !['message', 'reasoning', 'web_search_call', 'file_search_call', ...toolTypes].includes(
          item.type
        )
      )
        throw new TypeError('Unsupported Responses item');
      if (item.type === 'message' && item.role !== 'assistant')
        throw new TypeError('Invalid Responses role');
      if (item.status != null && !['completed', 'incomplete', 'in_progress'].includes(item.status))
        throw new TypeError('Invalid Responses item status');
      if (item.type === 'message' && item.content != null && typeof item.content !== 'string') {
        if (
          !Array.isArray(item.content) ||
          item.content.some(
            (part) =>
              !record(part) ||
              !['output_text', 'text'].includes(part.type) ||
              typeof part.text !== 'string'
          )
        )
          throw new TypeError('Unsupported Responses content');
      }
      if (toolTypes.includes(item.type)) {
        for (const key of ['name', 'id', 'call_id'])
          if (item[key] != null && typeof item[key] !== 'string')
            throw new TypeError('Invalid Responses tool');
        if (
          item.type === 'custom_tool_call' &&
          item.input !== undefined &&
          typeof item.input !== 'string' &&
          !record(item.input)
        )
          throw new TypeError('Invalid Responses custom input');
        if (
          payload.type === 'response.output_item.done' &&
          item.status !== 'incomplete' &&
          item.type === 'function_call' &&
          item.arguments === null
        )
          throw new TypeError('Invalid Responses arguments');
      }
    }
  }
  const terminal = createResponsesTerminalStateMachine({
    onFailure: (sink) => target.fail(sink),
    onComplete(_sink, providerState, info) {
      const response = info.response;
      if (response.error != null) throw new TypeError('Failed Responses terminal');
      if (!info.incomplete && response.incomplete_details != null)
        throw new TypeError('Conflicting Responses terminal');
      if (response.status != null && !['completed', 'incomplete'].includes(response.status))
        throw new TypeError('Invalid Responses terminal');
      if (info.terminalType === 'response.incomplete' && response.status === 'completed')
        throw new TypeError('Conflicting Responses terminal');
      if (
        info.incomplete &&
        (!record(response.incomplete_details) ||
          response.incomplete_details.reason !== 'max_output_tokens')
      )
        throw new TypeError('Unsupported Responses terminal');
      if (
        !info.incomplete &&
        [...(providerState.responseToolCallBuffers?.values() || [])].some((entry) => !entry.emitted)
      )
        throw new TypeError('Unfinished Responses tool');
      if (response.output != null && !Array.isArray(response.output))
        throw new TypeError('Invalid Responses output');
      if (Array.isArray(response.output)) {
        for (const item of response.output) {
          if (!info.incomplete && item?.status && item.status !== 'completed')
            throw new TypeError('Unfinished Responses item');
          validateEvent({ type: 'response.output_item.done', item });
        }
        const count = response.output.filter((item) => toolTypes.includes(item?.type)).length;
        if (!info.incomplete && count > 0 && count !== providerState.toolCalls.length)
          throw new TypeError('Missing Responses tool events');
      }
      terminalInfo = { finishReason: info.finishReason };
    },
  });
  const decoder = createResponsesStreamDecoder({
    streamBudget: createConversionStreamBudget(deps.protocolOptions),
    parseSseEvents: createSseEventParser(
      parseBoundedInteger(deps.protocolOptions?.maxSseBufferChars, 1024 * 1024, 1, 4 * 1024 * 1024)
    ),
    toolToSemantic: deps.toolToSemantic,
    terminal,
    target: { ...target, validateEvent },
  });
  return {
    state,
    abort,
    dispose() {
      if (state.finished) return;
      completed = true;
      state.disposed = true;
      state.done = true;
      state.buffer = '';
      state.toolCalls = [];
      state.responseToolCallBuffers?.clear();
      state.responseToolCallAliases?.clear();
      target.dispose();
    },
    start: (sink) => {
      try {
        target.start(sink);
      } catch {
        abort(sink);
      }
    },
    processChunk: (sink, chunk) => decoder.processChunk(sink, chunk, state),
    finish(sink) {
      if (completed) return !state.failed && !state.disposed;
      completed = true;
      decoder.flush(sink, state);
      if (state.failed) return false;
      try {
        const ok = target.finish(sink, state.usage, terminalInfo.finishReason);
        state.finished = ok;
        return ok;
      } catch {
        abort(sink);
        return false;
      }
    },
  };
}
module.exports = { createResponsesClaudeStream };
