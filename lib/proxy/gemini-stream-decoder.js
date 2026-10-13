'use strict';

const {
  createConversionStreamBudget,
  conversionFailureCode,
} = require('./conversion-stream-budget');
const { createSseEventParser, parseBoundedInteger } = require('./sse-buffer');
const { mergeGeminiToolArgs, shouldFlushPendingGeminiToolCall } = require('./gemini-stream-tools');
const { observeGeminiRecoveryPayload } = require('./handlers/gemini-output-recovery');
const { geminiStreamTerminal } = require('./gemini-stream-terminal');
const { validateGeminiFunctionInput } = require('./gemini-function-input');
const { createGeminiPartialArguments } = require('./gemini-partial-arguments');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalidEvent(code = 'upstream_stream_invalid_event') {
  const error = new TypeError('Invalid Gemini stream event');
  error.code = code;
  return error;
}

function createGeminiStreamDecoder({ deps, target, options = {} }) {
  const {
    sanitizeGeminiToolCall,
    cleanToolArgs,
    geminiFunctionCallArgs,
    geminiClaudeToolId,
    rememberGeminiToolCall,
    geminiUsageToClaude,
    geminiInlineImageToClaudeBlock,
    protocolOptions = {},
  } = deps;
  const budget = createConversionStreamBudget(protocolOptions);
  const parse = createSseEventParser(
    parseBoundedInteger(
      options.maxChars ?? protocolOptions.maxSseBufferChars,
      1024 * 1024,
      1,
      4 * 1024 * 1024
    )
  );
  const state = {
    buffer: '',
    textIndex: -1,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: options.tools,
    responsesToolPreambleText: options.toolPreambleText,
  };
  let tools = [];
  const retainedTools = {};
  const partial = createGeminiPartialArguments(protocolOptions);
  const partialSlots = new Map();

  function fail(sink, error) {
    if (state.done) return;
    state.done = true;
    state.failed = true;
    state.streamFailed = true;
    state.pendingToolCall = null;
    state.buffer = '';
    tools = [];
    partial.clear();
    partialSlots.clear();
    const code = ['upstream_stream_invalid_event', 'upstream_stream_incomplete'].includes(
      error?.code
    )
      ? error.code
      : conversionFailureCode(error);
    target.fail(sink, code);
  }
  function text(sink, value) {
    if (typeof value !== 'string') throw invalidEvent();
    if (state.thinkingOpen) state.thinkingOpen = false;
    if (!state.textOpen) {
      state.textIndex += 1;
      state.textOpen = true;
    }
    target.text(sink, value);
    if (value.trim()) state.hasVisibleText = true;
  }
  function flushTool(sink) {
    const pending = state.pendingToolCall;
    if (!pending) return;
    state.pendingToolCall = null;
    const sanitized = sanitizeGeminiToolCall(
      { name: pending.name, args: pending.args },
      state.tools
    );
    if (sanitized.error) {
      // Keep the existing provider-specific, sanitized retry instruction.
      state.textIndex += 1;
      target.text(sink, sanitized.text);
      return;
    }
    if (
      state.responsesToolPreambleText &&
      !state.responsesToolPreambleWritten &&
      !state.hasVisibleText
    ) {
      state.textIndex += 1;
      target.text(sink, state.responsesToolPreambleText);
      state.responsesToolPreambleWritten = true;
      state.hasVisibleText = true;
    }
    state.textIndex += 1;
    const id = geminiClaudeToolId(pending, state.textIndex);
    if (!record(sanitized.args) || typeof sanitized.name !== 'string' || !sanitized.name.trim())
      throw invalidEvent('upstream_stream_invalid_tool_arguments');
    const cleaned = cleanToolArgs(sanitized.name, cleanToolArgs(sanitized.name, sanitized.args));
    if (!record(cleaned)) throw invalidEvent('upstream_stream_invalid_tool_arguments');
    const args = JSON.stringify(cleaned);
    budget.appendArguments({}, args);
    budget.consume(retainedTools, args);
    budget.addTool(state);
    rememberGeminiToolCall(
      id,
      sanitized.name,
      sanitized.args,
      pending.thoughtSignature,
      pending.id
    );
    tools.push({ id, name: sanitized.name, arguments: args });
    state.hasToolUse = true;
  }
  function payload(sink, value) {
    const data = options.unwrapPayload ? options.unwrapPayload(value) : value;
    observeGeminiRecoveryPayload(data, state);
    if (!record(data) || data.error || data.promptFeedback?.blockReason) throw invalidEvent();
    if (data.candidates !== undefined && !Array.isArray(data.candidates)) throw invalidEvent();
    const candidate = data.candidates?.[0];
    if (candidate !== undefined && !record(candidate)) throw invalidEvent();
    if (candidate?.content !== undefined && !record(candidate.content)) throw invalidEvent();
    const parts = candidate?.content?.parts;
    if (parts !== undefined && !Array.isArray(parts)) throw invalidEvent();
    if (state.providerFinished && parts?.length) throw invalidEvent();
    const names = new Set();
    for (const part of parts || []) {
      if (!record(part)) throw invalidEvent();
      if (part.text !== undefined && typeof part.text !== 'string') throw invalidEvent();
      if (part.thought !== undefined && typeof part.thought !== 'boolean') throw invalidEvent();
      const image = geminiInlineImageToClaudeBlock?.(part);
      const imageText = image
        ? image.type === 'image'
          ? `![generated image](data:${image.source.media_type};base64,${image.source.data})`
          : image.text
        : '';
      if (part.thought === true && part.text) {
        if (typeof part.text !== 'string') throw invalidEvent();
        state.textOpen = false;
        if (!state.thinkingOpen) {
          state.textIndex += 1;
          state.thinkingOpen = true;
        }
        target.reasoning(sink, part.text);
        state.hasThinkingOutput = true;
      } else if (part.text || imageText) {
        text(sink, part.text || imageText);
        if (imageText) state.hasVisibleText = true;
      } else if (part.functionCall != null) {
        const call = part.functionCall;
        if (partial.accepts(call)) {
          if (state.pendingToolCall) flushTool(sink);
          const entry = partial.append(call, part.thoughtSignature);
          if (!partialSlots.has(entry)) {
            partialSlots.set(entry, tools.length);
            tools.push(null);
            state.sawPartialTool = true;
          }
          continue;
        }
        validateGeminiFunctionInput(call, { allowMissingName: Boolean(state.pendingToolCall) });
        state.thinkingOpen = false;
        state.textOpen = false;
        const incoming = geminiFunctionCallArgs(call);
        if (!record(incoming)) throw invalidEvent('upstream_stream_invalid_tool_arguments');
        if (
          (call.name && names.has(String(call.name))) ||
          shouldFlushPendingGeminiToolCall(state.pendingToolCall, call, incoming)
        )
          flushTool(sink);
        if (call.name) names.add(String(call.name));
        const args = mergeGeminiToolArgs(state.pendingToolCall?.args, incoming);
        budget.appendArguments({}, JSON.stringify(args));
        state.pendingToolCall = {
          id: call.id || state.pendingToolCall?.id,
          name: call.name || state.pendingToolCall?.name,
          args,
          thoughtSignature: part.thoughtSignature || state.pendingToolCall?.thoughtSignature,
        };
      }
    }
    if (candidate?.finishReason !== undefined && candidate.finishReason !== null) {
      const terminal = geminiStreamTerminal(candidate.finishReason);
      if (terminal.code) throw invalidEvent(terminal.code);
      if (state.providerFinished && state.providerFinishReason !== candidate.finishReason)
        throw invalidEvent();
      state.providerFinishReason = candidate.finishReason;
      state.stopReason = terminal.reason;
      state.providerFinished = true;
    }
    if (data.usageMetadata) state.usage = geminiUsageToClaude(data.usageMetadata);
  }
  function event(sink, raw) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let value;
      try {
        value = JSON.parse(data);
      } catch {
        throw invalidEvent();
      }
      payload(sink, value);
    }
  }
  function processChunk(sink, chunk) {
    if (state.done) return;
    try {
      budget.consume(state, chunk);
      parse(state, chunk, 'Gemini', (raw) => event(sink, raw));
    } catch (error) {
      fail(sink, error);
    }
  }
  function flushInput(sink) {
    if (state.done) return;
    try {
      if (state.buffer.trim()) event(sink, state.buffer);
      state.buffer = '';
    } catch (error) {
      fail(sink, error);
    }
  }
  function finish(sink) {
    if (state.done) return;
    try {
      flushInput(sink);
      if (state.done) return;
      if (!state.providerFinished) throw invalidEvent('upstream_stream_incomplete');
      flushTool(sink);
      const discard = state.stopReason === 'max_tokens' || state.stopReason === 'refusal';
      const completedPartial = partial.finish({ discard });
      for (const [index, entry] of [...partialSlots.keys()].entries()) {
        if (discard) break;
        const slot = partialSlots.get(entry);
        state.pendingToolCall = completedPartial[index];
        const before = tools.length;
        flushTool(sink);
        tools[slot] = tools.length > before ? tools.pop() : null;
      }
      partialSlots.clear();
      tools = tools.filter(Boolean);
      if (
        state.stopReason === 'max_tokens' &&
        !state.hasVisibleText &&
        !state.hasToolUse &&
        !state.sawPartialTool &&
        !state.hasThinkingOutput
      )
        text(
          sink,
          '[Gemini stopped after reaching its output token budget before returning visible content. Please retry with a shorter context or higher output limit.]'
        );
      if (state.stopReason !== 'max_tokens' && state.stopReason !== 'refusal') {
        for (let index = 0; index < tools.length; index++) {
          const call = tools[index];
          target.tool(sink, call, index);
        }
      }
      tools = [];
      const finishReason =
        state.stopReason === 'max_tokens'
          ? 'length'
          : state.stopReason === 'refusal'
            ? 'content_filter'
            : state.hasToolUse
              ? 'tool_calls'
              : 'stop';
      target.finish(sink, { usage: state.usage, finishReason });
      state.finished = !state.failed;
      state.done = true;
    } catch (error) {
      fail(sink, error);
    }
  }
  function dispose() {
    if (state.finished) return;
    state.done = true;
    state.disposed = true;
    state.buffer = '';
    state.pendingToolCall = null;
    tools = [];
    partial.clear();
    partialSlots.clear();
  }
  return {
    state,
    processChunk,
    flushInput,
    finish,
    dispose,
    abort: (sink) => fail(sink, invalidEvent('upstream_stream_incomplete')),
  };
}

module.exports = { createGeminiStreamDecoder };
