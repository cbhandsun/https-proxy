/**
 * Golden fixture tests for stream-claude.js
 *
 * 重点验证 OpenAI Chat Completions -> Claude Messages SSE 互转:
 *   - role chunk -> message_start
 *   - text delta -> content_block_delta (text_delta)
 *   - reasoning_content -> thinking block
 *   - tool_calls 流式累积 + flush
 *   - [DONE] 收尾
 */

const assert = require('assert');
const { createClaudeStream } = require('../lib/proxy/stream-claude');
const { finishGeminiClaudeStream } = require('../lib/proxy/handlers/route-gemini-utils');

const cleanToolArgs = (name, args) => args;
const noopSanitize = (call) => ({ name: call && call.name, args: call && call.args });
const noopSample = () => {};
const noopAudit = () => {};
const noopRemember = () => {};
const noopUsage = (usage) => ({
  input_tokens: usage && usage.promptTokenCount ? usage.promptTokenCount : 0,
  output_tokens: usage && usage.candidatesTokenCount ? usage.candidatesTokenCount : 0,
});

function createTestStream(protocolOptions = {}) {
  return createClaudeStream({
    cleanToolArgs,
    stripEmptyOptionalToolArgs: (a) => a,
    sanitizeGeminiToolCall: noopSanitize,
    sampleGeminiToolEvent: noopSample,
    auditToolCall: noopAudit,
    sampleOutboundSse: noopSample,
    parseClaudeSseEvent: (raw) => {
      const text = String(raw || '').trim();
      const lines = text.split('\n');
      let eventName = '';
      let dataText = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventName = line.substring(7).trim();
        else if (line.startsWith('data: ')) dataText += line.substring(6);
      }
      let data = null;
      if (dataText && dataText !== '[DONE]') {
        try {
          data = JSON.parse(dataText);
        } catch (e) {}
      }
      return { eventName, dataText, data };
    },
    resolveSseBlockIndex: () => 0,
    deltaPartialJson: (d) => (d && typeof d.partial_json === 'string' ? d.partial_json : ''),
    geminiFunctionCallArgs: (a) => a,
    geminiClaudeToolId: (i) => 'tool_' + i,
    rememberGeminiToolCall: noopRemember,
    claudeStopReasonFromGemini: (r) => (r === 'MAX_TOKENS' ? 'max_tokens' : r),
    geminiUsageToClaude: noopUsage,
    fallbackId: (p) => p + '_mock',
    protocolOptions,
  });
}

const stream = createTestStream();

let pass = 0,
  fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok -', name);
  } catch (err) {
    fail += 1;
    console.error('  FAIL -', name, '\n   ', err.message);
  }
}

function makeRes() {
  const buf = [];
  return {
    write: (chunk) => buf.push(chunk),
    chunks: buf,
    full: () => buf.join(''),
  };
}

function makeState() {
  return {
    buffer: '',
    textIndex: -1,
    textOpen: false,
    thinkingOpen: false,
    toolCalls: [],
    finishReason: null,
  };
}

console.log('stream-claude golden fixture tests');

// 1. role chunk is a no-op (used as a stream start signal, no Claude events emitted yet)
t('role chunk is buffered and emits no Claude events', () => {
  const res = makeRes();
  const state = makeState();
  stream.processOpenAISseChunkToClaude(
    res,
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    state
  );
  assert.strictEqual(res.full(), '', 'role chunk alone should not emit any Claude event');
});

// 1b. role + text chunk together emits content_block_start + delta
t('role + text content chunk emits content_block_start + content_block_delta', () => {
  const res = makeRes();
  const state = makeState();
  const payload = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  ].join('');
  stream.processOpenAISseChunkToClaude(res, payload, state);
  const text = res.full();
  assert.ok(text.includes('content_block_start'), 'should emit content_block_start');
  assert.ok(text.includes('content_block_delta'), 'should emit content_block_delta');
  assert.ok(text.includes('hi'));
});

// 2. text delta -> text content_block_delta
t('text delta emits content_block_start + content_block_delta', () => {
  const res = makeRes();
  const state = makeState();
  stream.processOpenAISseChunkToClaude(
    res,
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    state
  );
  const text = res.full();
  assert.ok(text.includes('content_block_start'));
  assert.ok(text.includes('"text"'));
  assert.ok(text.includes('content_block_delta'));
  assert.ok(text.includes('"text_delta"'));
  assert.ok(text.includes('hi'));
});

// 3. reasoning_content -> thinking block
t('reasoning_content opens thinking block', () => {
  const res = makeRes();
  const state = makeState();
  stream.processOpenAISseChunkToClaude(
    res,
    'data: {"choices":[{"delta":{"reasoning_content":"deep thought"}}]}\n\n',
    state
  );
  const text = res.full();
  assert.ok(text.includes('"thinking"'));
  assert.ok(text.includes('thinking_delta'));
  assert.ok(text.includes('deep thought'));
});

// 4. reasoning then text - both blocks emitted in order
t('reasoning_content followed by content emits both blocks', () => {
  const res = makeRes();
  const state = makeState();
  const payload = [
    'data: {"choices":[{"delta":{"reasoning_content":"think..."}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
  ].join('');
  stream.processOpenAISseChunkToClaude(res, payload, state);
  const text = res.full();
  const thinkIdx = text.indexOf('thinking');
  const answerIdx = text.indexOf('answer');
  assert.ok(thinkIdx >= 0, 'thinking should be in output');
  assert.ok(answerIdx >= 0, 'answer should be in output');
  assert.ok(thinkIdx < answerIdx, 'thinking should appear before answer');
});

// 5. tool_calls streaming accumulation + flush
t('tool_calls are accumulated then flushed with tool_use block', () => {
  const res = makeRes();
  const state = makeState();
  const payload = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}\n\n',
  ].join('');
  stream.processOpenAISseChunkToClaude(res, payload, state);
  // tool_calls shouldn't emit tool_use until flush
  assert.ok(!res.full().includes('"type":"tool_use"'), 'tool_use should not appear before flush');
  // flush
  stream.flushOpenAISseToClaude(res, state);
  const flushed = res.full();
  assert.ok(flushed.includes('"name":"Bash"'), 'flushed tool_use must contain name');
});

// 6. [DONE] is handled gracefully
t('[DONE] sets state.done', () => {
  const res = makeRes();
  const state = makeState();
  stream.processOpenAISseEventToClaude(res, 'data: [DONE]\n\n', state);
  assert.strictEqual(state.done, true);
});

// 7. finish_reason is captured
t('finish_reason is stored in state', () => {
  const res = makeRes();
  const state = makeState();
  stream.processOpenAISseChunkToClaude(
    res,
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    state
  );
  assert.strictEqual(state.finishReason, 'stop');
});

// 8. Empty / malformed payload is ignored
t('malformed JSON does not throw', () => {
  const res = makeRes();
  const state = makeState();
  stream.processOpenAISseChunkToClaude(res, 'data: {not-json}\n\n', state);
  // No throw, no state corruption
  assert.strictEqual(state.finishReason, null);
});

t('malformed Gemini SSE log omits raw frame content', () => {
  const res = makeRes();
  const state = makeState();
  let captured = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = function write(chunk, ...args) {
    captured += String(chunk);
    return originalStdoutWrite.call(this, chunk, ...args);
  };
  process.stderr.write = function write(chunk, ...args) {
    captured += String(chunk);
    return originalStderrWrite.call(this, chunk, ...args);
  };
  try {
    stream.processGeminiSseEvent(
      res,
      'data: {"secret_prompt":"do not log me"\n\n',
      state,
      'gemini-3.8-flash-tiered'
    );
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  assert.ok(captured.includes('gemini stream parse skipped'));
  assert.ok(captured.includes('data_bytes='));
  assert.ok(!captured.includes('secret_prompt'));
  assert.ok(!captured.includes('do not log me'));
});

// 9. Splits buffer across chunks
t('buffer is split correctly across chunk boundaries', () => {
  const res = makeRes();
  const state = makeState();
  // First chunk ends mid-event
  stream.processOpenAISseChunkToClaude(res, 'data: {"choices":[{"delta":{"role":"assis', state);
  assert.strictEqual(
    state.buffer,
    'data: {"choices":[{"delta":{"role":"assis',
    'incomplete data should be buffered'
  );
  // Second chunk completes it
  stream.processOpenAISseChunkToClaude(res, 'tant"}}]}\n\n', state);
  // role chunk alone emits no events; verify the buffer was processed
  assert.strictEqual(state.buffer, '', 'buffer should be empty after event boundary');
  assert.strictEqual(res.full(), '', 'role chunk alone should not emit any Claude event');
});

t('partial chunk: split inside content delta still emits text', () => {
  const res = makeRes();
  const state = makeState();
  stream.processOpenAISseChunkToClaude(res, 'data: {"choices":[{"delta":{"content":"hel', state);
  stream.processOpenAISseChunkToClaude(res, 'lo"}}]}\n\n', state);
  const text = res.full();
  assert.ok(text.includes('content_block_start'), 'should emit start');
  assert.ok(text.includes('hello'), 'should emit text delta');
});

t('oversized incomplete OpenAI SSE event is rejected', () => {
  const cappedStream = createTestStream({ maxSseBufferChars: 8 });
  const res = makeRes();
  const state = makeState();
  assert.throws(
    () => cappedStream.processOpenAISseChunkToClaude(res, 'data: {"choices":[', state),
    /OpenAI SSE event too large/
  );
  assert.strictEqual(state.buffer, '');
});

t('Gemini Responses stream emits fallback text before first tool call', () => {
  const res = makeRes();
  const state = {
    textIndex: -1,
    textOpen: false,
    thinkingOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: [{ name: 'exec', input_schema: { type: 'object', required: ['input'] } }],
    pendingToolCall: null,
    responsesToolPreambleText: '我先看一下。',
  };

  stream.processGeminiSseEvent(
    res,
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"exec","args":{"input":"return 1;"}}}]}}]}\n\n',
    state,
    'gemini-3.8-flash-tiered'
  );
  stream.flushPendingGeminiToolCall(res, state, state.tools);
  const text = res.full();
  const preambleIndex = text.indexOf('我先看一下。');
  const toolIndex = text.indexOf('"type":"tool_use"');
  assert.ok(preambleIndex >= 0, 'fallback preamble should be emitted');
  assert.ok(toolIndex >= 0, 'tool_use should still be emitted');
  assert.ok(preambleIndex < toolIndex, 'fallback preamble must precede the tool call');
});

t('Gemini max_tokens with no visible content emits diagnostic text', () => {
  const res = makeRes();
  const state = {
    textIndex: -1,
    textOpen: false,
    thinkingOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 1 },
    tools: [],
    pendingToolCall: null,
  };

  stream.processGeminiSseEvent(
    res,
    'data: {"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}\n\n',
    state,
    'gemini-3.8-flash-tiered'
  );
  finishGeminiClaudeStream({
    sink: res,
    state,
    targetModel: 'gemini-3.8-flash-tiered',
    processGeminiSseEvent: stream.processGeminiSseEvent,
    flushPendingGeminiToolCall: stream.flushPendingGeminiToolCall,
    writeClaudeSseEvent: stream.writeClaudeSseEvent,
    geminiClaudeStopReason: stream.geminiClaudeStopReason,
  });

  const text = res.full();
  assert.ok(text.includes('Gemini stopped after reaching its output token budget'));
  assert.ok(text.includes('"stop_reason":"max_tokens"'));
  assert.ok(text.includes('"output_tokens":1'));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('stream-claude tests ok');
