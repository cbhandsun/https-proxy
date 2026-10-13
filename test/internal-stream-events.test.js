'use strict';

const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createClaudeStream } = require('../lib/proxy/stream-claude');
const { parseClaudeSseEvent, deltaPartialJson } = require('../lib/proxy/sse');
const { finishGeminiClaudeStream } = require('../lib/proxy/handlers/route-gemini-utils');
const {
  CLAUDE_STREAM_EVENT,
  CHAT_STREAM_CHUNK,
  checkInternalEventSize,
} = require('../lib/proxy/internal-stream-events');

const noop = () => {};
function harness(internal, options = {}, collect = true) {
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (_name, input) => input,
    fallbackId: (prefix) => prefix + '_fixture',
    stableCreated: () => 1,
    parseClaudeSseEvent,
    deltaPartialJson,
    protocolOptions: options,
  });
  const stream = createClaudeStream({
    cleanToolArgs: (_name, input) => input,
    stripEmptyOptionalToolArgs: (input) => input,
    sanitizeGeminiToolCall: (call) => ({ name: call.name, args: call.args }),
    sampleGeminiToolEvent: noop,
    auditToolCall: noop,
    sampleOutboundSse: noop,
    geminiFunctionCallArgs: (call) => call.args,
    geminiClaudeToolId: (index) => 'call_' + index,
    rememberGeminiToolCall: noop,
    claudeStopReasonFromGemini: (reason) => (reason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn'),
    geminiUsageToClaude: () => ({ input_tokens: 12, output_tokens: 8 }),
    geminiInlineImageToClaudeBlock: (part) =>
      part.inlineData ? { type: 'image', source: part.inlineData } : null,
  });
  const writes = [];
  let bytes = 0;
  const sink = {
    write(value) {
      bytes += Buffer.byteLength(value);
      if (collect) writes.push(value);
    },
  };
  const responses = {
    id: 'resp_fixture',
    created_at: 1,
    model: 'fixture',
    buffer: '',
    outputIndex: 0,
    text: '',
    pendingToolCalls: [],
    toolCalls: [],
    completedOutputItems: [],
  };
  const chat = { id: 'chat_fixture', created: 1, model: 'fixture', buffer: '' };
  const chatSink = {
    write: (wire) => protocol.processOpenAIChatSseChunkToResponses(sink, wire, responses),
  };
  const claudeSink = {
    write: (wire) => protocol.processClaudeSseChunkToOpenAI(chatSink, wire, chat),
  };
  if (internal) {
    chatSink[CHAT_STREAM_CHUNK] = (payload, wire) =>
      protocol.processOpenAIChatChunkToResponses(sink, payload, wire, responses);
    claudeSink[CLAUDE_STREAM_EVENT] = (name, data, wire) =>
      protocol.processClaudeEventToOpenAI(chatSink, name, data, wire, chat);
  }
  const send = (name, data = {}) =>
    stream.writeClaudeSseEvent(claudeSink, name, { type: name, ...data }, { safeToolUse: false });
  const finish = () => {
    protocol.flushClaudeSseToOpenAI(chatSink, chat);
    protocol.flushOpenAIChatSseToResponses(sink, responses);
  };
  return {
    protocol,
    stream,
    sink,
    claudeSink,
    chatSink,
    chat,
    responses,
    send,
    finish,
    writes,
    bytes: () => bytes,
  };
}

function compare(run, options) {
  const wire = harness(false, options);
  const direct = harness(true, options);
  run(wire);
  run(direct);
  wire.finish();
  direct.finish();
  assert.deepEqual(direct.writes, wire.writes, 'outward frames must be byte identical');
  assert.deepEqual(direct.chat, wire.chat, 'Claude state and resource accounting match');
  assert.deepEqual(direct.responses, wire.responses, 'Responses state and accounting match');
  return direct;
}

const text = (h, value) =>
  h.send('content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: value },
  });
const tool = (h, value, index = 1) => {
  h.send('content_block_start', {
    index,
    content_block: { type: 'tool_use', id: 'call_' + index, name: 'lookup', input: {} },
  });
  h.send('content_block_delta', {
    index,
    delta: { type: 'input_json_delta', partial_json: value },
  });
  h.send('content_block_stop', { index });
};
const end = (h, reason = 'end_turn') => {
  h.send('message_delta', { delta: { stop_reason: reason }, usage: { output_tokens: 8 } });
  h.send('message_stop');
};

if (require.main === module) {
  for (const reason of ['end_turn', 'max_tokens', 'refusal', 'tool_use']) {
    const h = compare((h) => {
      h.send('message_start', {
        message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
      });
      h.send('content_block_start', { index: 0, content_block: { type: 'thinking' } });
      h.send('content_block_delta', {
        index: 0,
        delta: { type: 'thinking_delta', thinking: '思考' },
      });
      h.send('content_block_stop', { index: 0 });
      text(h, '中文 😀 \n " \\');
      tool(h, '{"q":"你好"}');
      tool(h, '{"q":2}', 2);
      end(h, reason);
      text(h, 'ignored after terminal');
    });
    assert.equal(h.responses.usage.input_tokens, 15);
    assert.equal(h.responses.usage.cached_input_tokens, 3);
    assert.equal(h.responses.usage.output_tokens, 8);
    const calls = h.responses.completedOutputItems.filter((item) => item.type === 'function_call');
    assert.equal(calls.length, reason === 'max_tokens' || reason === 'refusal' ? 0 : 2);
  }
  for (const run of [
    noop,
    (h) => text(h, ''),
    (h) => text(h, 'unfinished'),
    (h) => h.send('error', { error: { message: 'secret-token-do-not-leak' } }),
    (h) => {
      tool(h, '{"q":1}');
      tool(h, '{"secret":"do-not-leak"');
      end(h);
    },
    (h) => {
      h.send('content_block_delta', { delta: null });
      end(h);
    },
  ]) {
    const h = compare(run);
    assert.equal(h.responses.failed, true);
    assert.equal(h.writes.join('').includes('do-not-leak'), false);
  }
  for (const options of [
    { maxConversionStreamBytes: 250 },
    { maxSseBufferChars: 100 },
    { maxConversionToolArgumentBytes: 8 },
    { maxConversionToolCalls: 1 },
  ]) {
    const h = compare((h) => {
      tool(h, '{"q":"中文😀long"}');
      tool(h, '{}', 2);
      end(h);
    }, options);
    assert.equal(h.responses.failed, true);
  }
  // Exact event-character boundary agrees with the network parser.
  const frame = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  for (const limit of [frame.length - 3, frame.length - 2, frame.length - 1]) {
    compare((h) => h.send('message_stop'), { maxSseBufferChars: limit });
  }
  for (const value of [undefined, null, 3, {}, 'bad'])
    assert.throws(() => checkInternalEventSize(value, 100), TypeError);
  // The second stage must enforce its own caps even if a Claude event fits.
  const oversizedChat = compare((h) => text(h, 'x'.repeat(200)), { maxSseBufferChars: 300 });
  assert.equal(oversizedChat.responses.failed, true);
  assert.equal(oversizedChat.chat.failed, true, 'EOF still fails the unterminated Claude message');
  for (const payload of [null, [], 3, { error: { message: 'secret-do-not-leak' } }]) {
    const h = harness(true);
    const wire = 'data: ' + JSON.stringify(payload) + '\n\n';
    h.protocol.processOpenAIChatChunkToResponses(h.sink, payload, wire, h.responses);
    assert.equal(h.responses.failed, true);
    assert.equal(h.writes.join('').includes('do-not-leak'), false);
    const count = h.writes.length;
    h.protocol.processOpenAIChatChunkToResponses(h.sink, payload, wire, h.responses);
    assert.equal(h.writes.length, count, 'an internal failure is terminal');
  }
  // Gemini emitter, image, repeated-name tools, signatures and terminal usage.
  compare((h) => {
    const state = {
      textIndex: -1,
      buffer: '',
      usage: {},
      tools: [],
      responsesToolPreambleText: 'Working.',
    };
    h.send('message_start', { message: { usage: {} } });
    h.stream.processGeminiSseEvent(
      h.claudeSink,
      'data: ' +
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'reason' },
                  { text: 'visible' },
                  { inlineData: { media_type: 'image/png', data: 'AA==' } },
                  {
                    functionCall: { name: 'lookup', args: { q: 1 } },
                    thoughtSignature: 'signature',
                  },
                  { functionCall: { name: 'lookup', args: { q: 2 } } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 12 },
        }),
      state,
      'fixture'
    );
    finishGeminiClaudeStream({ sink: h.claudeSink, state, targetModel: 'fixture', ...h.stream });
  });
  // Internal callbacks do not accidentally replace a real response's write API.
  const h = harness(false);
  h.chatSink.chatStreamChunk = () => assert.fail('string property must not be called');
  text(h, 'ok');
  end(h);
  h.finish();
  assert.equal(h.responses.done, true);
  console.log('internal-stream-events.test.js passed');
}

module.exports = { harness, text, end };
