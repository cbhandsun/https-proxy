'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { harness } = require('./internal-stream-events.test');
const { createResponsesClaudeBridge } = require('../lib/proxy/responses-claude-bridge');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const frame = (type, data = {}) => 'data: ' + JSON.stringify({ type, ...data }) + '\n\n';
const complete = (extra = {}) =>
  frame('response.completed', {
    response: {
      status: 'completed',
      usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 3 } },
      output: [],
      ...extra,
    },
  });
const text = (value) => frame('response.output_text.delta', { delta: value });
const reasoning = (value) => frame('response.reasoning_summary_text.delta', { delta: value });
const call = (index = 0, args = '{"q":"中文 😀"}') =>
  frame('response.output_item.done', {
    output_index: index,
    item: {
      type: 'function_call',
      id: 'item' + index,
      call_id: 'call' + index,
      name: 'lookup',
      arguments: args,
    },
  });
function run(frames, direct = true, options = {}, split = false, poison = false) {
  const h = harness(false, options);
  let factory = h.protocol;
  if (poison)
    factory = createOpenAIProtocol({
      fallbackId: (prefix) => prefix + '_fixture',
      stableCreated: () => 1,
      cleanToolArgs: () => {
        throw new Error('SECRET');
      },
      protocolOptions: options,
    });
  if (direct) {
    const converter = factory.createResponsesClaudeStream({
      id: 'msg_fixture',
      model: 'client',
      writeEvent: h.stream.writeClaudeSseEvent,
    });
    converter.start(h.sink);
    for (const raw of frames)
      for (const part of split ? [...raw] : [raw]) converter.processChunk(h.sink, part);
    assert.ok(!h.writes.join('').includes('"type":"tool_use"'), 'hold tools until transport end');
    const ok = converter.finish(h.sink);
    const count = h.writes.length;
    converter.finish(h.sink);
    assert.equal(h.writes.length, count);
    assert.equal(converter.state.responseToolCallBuffers?.size || 0, 0);
    return { ...h, ok, state: converter.state };
  }
  const state = {
    buffer: '',
    textIndex: -1,
    textOpen: false,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input_tokens: 0, output_tokens: 0 },
    done: false,
  };
  const bridge = createResponsesClaudeBridge(h.stream, h.sink, state);
  h.stream.writeClaudeSseEvent(h.sink, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'client',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: state.usage,
    },
  });
  const chat = {
    id: 'chat_fixture',
    created: 1,
    model: 'client',
    buffer: '',
    toolCalls: [],
    done: false,
  };
  for (const raw of frames) h.protocol.processOpenAIResponsesSseChunkToChat(bridge.sink, raw, chat);
  const outcome = h.protocol.flushOpenAIResponsesSseToChat(bridge.sink, chat);
  bridge.finish(outcome, chat.usage);
  return h;
}
const toolFrames = [
  frame('response.output_item.added', {
    output_index: 0,
    item: { type: 'function_call', id: 'item0', call_id: 'call0', name: 'lookup' },
  }),
  frame('response.function_call_arguments.delta', { item_id: 'item0', delta: '{"q":' }),
  frame('response.function_call_arguments.delta', { item_id: 'item0', delta: '"hello"}' }),
  frame('response.output_item.done', {
    output_index: 0,
    item: { type: 'function_call', id: 'item0', call_id: 'call0', name: 'lookup' },
  }),
];
// DeepSeek announces reasoning content before its already-supported deltas.
const reasoningPart = (part) => frame('response.content_part.added', { part });
const deepSeekReasoningFrames = [
  frame('response.output_item.added', {
    output_index: 0,
    item: { type: 'reasoning', status: 'in_progress', content: [] },
  }),
  reasoningPart({ type: 'reasoning_text', text: '' }),
  frame('response.reasoning_text.delta', { output_index: 0, delta: '思考 😀' }),
  frame('response.output_item.done', {
    output_index: 0,
    item: {
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: '思考 😀' }],
    },
  }),
  text('answer'),
  complete(),
];
assert.equal(run(deepSeekReasoningFrames).ok, true, 'reasoning content markers must not abort');
assert.deepEqual(
  run(deepSeekReasoningFrames, true, {}, true).writes,
  run(deepSeekReasoningFrames).writes
);
assert.deepEqual(run(deepSeekReasoningFrames).writes, run(deepSeekReasoningFrames, false).writes);
for (const frames of [
  [complete()],
  [text('中文 😀 " \\ \n'), complete()],
  [reasoning('thinking'), text('answer'), reasoning('again'), text('more'), complete()],
  [call(), complete()],
  [text('before'), ...toolFrames, complete()],
  [
    frame('response.output_item.done', {
      output_index: 0,
      item: { type: 'custom_tool_call', name: 'custom', call_id: 'custom0', input: 'raw input' },
    }),
    complete(),
  ],
  [call(0, JSON.stringify({ content: 'x'.repeat(20000) })), complete()],
]) {
  const direct = run(frames);
  assert.equal(direct.ok, true);
  assert.deepEqual(direct.writes, run(frames, false).writes, 'outward writes retain compatibility');
  assert.deepEqual(run(frames, true, {}, true).writes, direct.writes);
  assert.ok(
    direct.writes
      .join('')
      .includes('"input_tokens":9,"output_tokens":8,"cache_read_input_tokens":3')
  );
}
const truncatedFrames = [
  text('partial'),
  ...toolFrames.slice(0, 2),
  frame('response.incomplete', {
    response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
  }),
];
const truncated = run(truncatedFrames);
assert.equal(truncated.ok, true);
assert.ok(truncated.writes.join('').includes('max_tokens'));
assert.ok(!truncated.writes.join('').includes('"type":"tool_use"'));
const failures = [
  [],
  [text('unfinished')],
  ['data: {"SECRET":broken}\n\n'],
  [call(), frame('response.failed', { response: { error: { message: 'SECRET' } } })],
  [frame('error', { message: 'SECRET' })],
  [complete({ status: 'in_progress' })],
  [complete({ error: { message: 'SECRET' } })],
  [frame('response.incomplete', { response: { status: 'completed' } })],
  [frame('response.incomplete', { response: { incomplete_details: { reason: 'OTHER' } } })],
  [
    call(),
    frame('response.incomplete', {
      response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
    }),
  ],
  [toolFrames[0], complete()],
  [text({ secret: 'SECRET' }), complete()],
  [frame('response.output_item.added', { item: { type: 'image_generation_call' } }), complete()],
  [frame('response.completed', { response: [] })],
  [complete({ output: [{ type: 'function_call', name: 'lookup', arguments: '{}' }] })],
  [complete({ output: {} })],
  ...[
    null,
    [],
    {},
    { type: 'reasoning_text' },
    { type: 'reasoning_text', text: null },
    { type: 'reasoning_text', text: { secret: 'SECRET' } },
    { type: 'input_audio', text: 'SECRET' },
    { type: 'refusal', text: 'SECRET' },
  ].map((part) => [reasoningPart(part), complete()]),
  [call(0, '[1]'), complete()],
  [
    frame('response.output_item.done', {
      item: { type: 'custom_tool_call', name: 'custom', input: [] },
    }),
    complete(),
  ],
];
for (const frames of failures) {
  const result = run(frames);
  const wire = result.writes.join('');
  assert.equal(result.ok, false);
  assert.equal(result.state.failed, true);
  assert.ok(wire.includes('event: error'));
  assert.ok(!wire.includes('message_stop'));
  assert.ok(!wire.includes('"type":"tool_use"'));
  assert.ok(!wire.includes('SECRET'));
}
for (const [frames, options] of [
  [[text('x'.repeat(2048)), complete()], { maxConversionStreamBytes: 800 }],
  [[call(0), call(1), call(2), complete()], { maxConversionStreamBytes: 1200 }],
  [[call(), complete()], { maxConversionToolArgumentBytes: 1 }],
  [[call(0), call(1), complete()], { maxConversionToolCalls: 1 }],
  [[text('x'), complete()], { maxSseBufferChars: 8 }],
]) {
  const result = run(frames, true, options);
  assert.equal(result.ok, false);
  assert.ok(!result.writes.join('').includes('"type":"tool_use"'));
}
assert.ok(!run([call(), complete()], true, {}, false, true).writes.join('').includes('SECRET'));
function route(frames, { slow = false, cancel = false, abort = false } = {}) {
  const h = harness(false);
  const logs = [];
  let callback;
  const client = new EventEmitter();
  client.writeHead = () => {};
  client.write = (wire) => {
    h.sink.write(wire);
    return !slow || h.writes.length !== 1;
  };
  client.end = () => {
    client.writableEnded = true;
    client.emit('finish');
  };
  const noop = () => {};
  const ctx = {
    ...h.protocol,
    ...h.stream,
    http: {
      request: (_options, cb) => {
        callback = cb;
        return { on: noop, end: noop };
      },
    },
    parseProxyBody: () => ({ model: 'client', stream: true, messages: [] }),
    claudeMessagesToOpenAIChat: () => ({ messages: [] }),
    openAIChatToResponsesRequest: (body) => body,
    upstreamRequestOptions: () => ({}),
    fallbackId: (prefix) => prefix + '_fixture',
    stableCreated: () => 1,
    logRequestEnd: (...args) => logs.push(args),
    logProxyEvent: noop,
    CORS_HEADERS: {},
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    processOpenAIResponsesSseChunkToChat: () => assert.fail('Chat stream adapter selected'),
    writeClaudeFromOpenAIStreamChunk: () => assert.fail('Chat-shaped emitter selected'),
  };
  createRouteHandlers(ctx).handleClaudeMessagesToOpenAIResponses(
    { method: 'POST' },
    client,
    { rewriteTo: '-', buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', path: '/v1' },
    '',
    '/messages',
    1
  );
  const upstream = new EventEmitter();
  upstream.statusCode = 200;
  upstream.setEncoding = noop;
  upstream.pause = noop;
  upstream.resume = noop;
  upstream.destroy = noop;
  callback(upstream);
  for (const raw of frames) {
    upstream.emit('data', Buffer.from(raw));
    if (cancel) client.emit('close');
    if (abort) upstream.emit('aborted');
  }
  upstream.emit('end');
  if (slow) {
    assert.equal(client.writableEnded, undefined);
    assert.equal(logs.length, 0);
    client.emit('drain');
  }
  return { writes: h.writes, logs };
}
const goodFrames = [reasoning('thinking'), text('answer'), call(), complete()];
assert.equal(route(goodFrames).logs.at(-1)[3], 200);
assert.equal(route(deepSeekReasoningFrames).logs.at(-1)[3], 200);
assert.deepEqual(
  route(deepSeekReasoningFrames, { slow: true }).writes,
  route(deepSeekReasoningFrames).writes
);
assert.equal(route(deepSeekReasoningFrames, { cancel: true }).logs.at(-1)[3], 499);
assert.equal(route(deepSeekReasoningFrames, { abort: true }).logs.at(-1)[3], 502);
assert.deepEqual(route(goodFrames, { slow: true }).writes, route(goodFrames).writes);
assert.equal(route(goodFrames, { cancel: true }).logs.at(-1)[3], 499);
assert.equal(route(goodFrames, { abort: true }).logs.at(-1)[3], 502);
for (const frames of failures) {
  const result = route(frames);
  assert.equal(result.logs.at(-1)[3], 502);
  assert.ok(!result.writes.join('').includes('"type":"tool_use"'));
  assert.ok(!JSON.stringify(result.logs).includes('SECRET'));
}
const h = harness(false);
const chat = { buffer: '', toolCalls: [] };
h.protocol.processOpenAIResponsesSseChunkToChat(h.sink, reasoning('summary'), chat);
assert.ok(h.writes.join('').includes('"reasoning_content":"summary"'));
console.log('direct-responses-claude-stream.test.js passed');
