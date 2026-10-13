'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { harness } = require('./internal-stream-events.test');
const { createResponsesClaudeBridge } = require('../lib/proxy/responses-claude-bridge');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const frame = (type, data = {}) => 'data: ' + JSON.stringify({ type, ...data }) + '\n\n';
const tool = frame('response.output_item.done', {
  output_index: 0,
  item: {
    type: 'function_call',
    id: 'item1',
    call_id: 'call1',
    name: 'lookup',
    arguments: '{"q":1}',
  },
});
function run(frames, internal = true, options = {}, route = false) {
  const h = harness(false, options);
  const state = {
    buffer: '',
    textIndex: -1,
    textOpen: false,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input_tokens: 0, output_tokens: 0 },
    done: false,
  };
  let wireParses = 0;
  const deps = {
    ...h.stream,
    processOpenAISseChunkToClaude: (...args) => {
      wireParses++;
      h.stream.processOpenAISseChunkToClaude(...args);
    },
  };
  if (!internal) delete deps.writeClaudeFromOpenAIStreamChunk;
  if (route) {
    const upstream = new EventEmitter();
    upstream.statusCode = 200;
    upstream.setEncoding = () => {};
    upstream.pause = () => {};
    upstream.resume = () => {};
    const request = new EventEmitter();
    request.method = 'POST';
    request.reqId = 'fixture';
    const sink = new EventEmitter();
    sink.write = (wire) => {
      h.sink.write(wire);
      return route !== 'slow' || h.writes.length !== 1;
    };
    sink.writeHead = () => {};
    sink.end = () => {
      sink.writableEnded = true;
      sink.emit('finish');
    };
    const logs = [];
    const ctx = {
      ...h.protocol,
      ...deps,
      claudeMessagesToOpenAIChat: () => ({ messages: [], stream: true }),
      openAIChatToResponsesRequest: (body) => body,
      onProxyTimeout: () => () => {},
      onProxyError: () => () => {},
      protocolOptions: options,
      http: {
        request: (_options, callback) => {
          const req = new EventEmitter();
          req.end = () => {
            callback(upstream);
            for (const raw of frames) {
              upstream.emit('data', Buffer.from(raw));
              if (route === 'cancel') sink.emit('close');
              if (route === 'abort') upstream.emit('aborted');
            }
            upstream.emit('end');
          };
          return req;
        },
      },
      parseProxyBody: () => ({
        model: 'fixture',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      upstreamRequestOptions: () => ({}),
      fallbackId: (prefix) => prefix + '_fixture',
      stableCreated: () => 1,
      logRequestEnd: (...args) => logs.push(args),
      logProxyEvent: () => {},
      CORS_HEADERS: {},
    };
    createRouteHandlers(ctx).handleClaudeMessagesToOpenAIResponses(
      request,
      sink,
      { buffer: Buffer.from('{}'), rewriteTo: '-', profile: {} },
      { protocol: 'http:', path: '/v1' },
      '',
      '/v1/messages',
      1
    );
    if (route === 'slow') {
      assert.equal(logs.length, 0);
      assert.equal(sink.writableEnded, undefined);
      sink.emit('drain');
      assert.equal(sink.writableEnded, true);
    }
    return { writes: h.writes, wireParses, logs };
  }
  const bridge = createResponsesClaudeBridge(deps, h.sink, state);
  const chat = {
    id: 'fixture',
    created: 1,
    model: 'fixture',
    buffer: '',
    toolCalls: [],
    done: false,
  };
  for (const raw of frames) h.protocol.processOpenAIResponsesSseChunkToChat(bridge.sink, raw, chat);
  const outcome = h.protocol.flushOpenAIResponsesSseToChat(bridge.sink, chat);
  bridge.finish(outcome, chat.usage);
  const count = h.writes.length;
  bridge.finish(outcome, chat.usage);
  assert.equal(h.writes.length, count);
  return { writes: h.writes, wireParses, state };
}
const completed = frame('response.completed', {
  response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 8 }, output: [] },
});
const text = frame('response.output_text.delta', { delta: '中文 😀 " \\ \n' });
for (const frames of [
  [completed],
  [text, completed],
  [frame('response.reasoning_text.delta', { delta: 'reason' }), text, tool, completed],
]) {
  const direct = run(frames);
  const legacy = run(frames, false);
  assert.deepEqual(direct.writes, legacy.writes);
  assert.ok(direct.wireParses < legacy.wireParses);
  assert.deepEqual(direct.state.usage, { input_tokens: 12, output_tokens: 8 });
  const wired = run(frames, true, {}, true);
  assert.ok(wired.writes.join('').includes('message_stop'));
  assert.equal(wired.logs.at(-1)[3], 200);
}
for (const frames of [
  [],
  [text],
  ['data: {malformed\n\n'],
  [tool, frame('response.failed', { response: { error: { message: 'SECRET' } } })],
  [tool, frame('error', { message: 'SECRET' })],
  [
    tool,
    frame('response.incomplete', {
      response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
    }),
  ],
]) {
  const result = run(frames);
  const wire = result.writes.join('');
  assert.ok(wire.includes('event: error'));
  assert.ok(!wire.includes('message_stop'));
  assert.ok(!wire.includes('"type":"tool_use"'));
  assert.ok(!wire.includes('SECRET'));
  const wired = run(frames, true, {}, true);
  assert.ok(wired.writes.join('').includes('event: error'));
  assert.equal(wired.logs.at(-1)[3], 502);
}
const truncated = run([
  tool,
  frame('response.incomplete', {
    response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
  }),
]);
assert.ok(truncated.writes.join('').includes('max_tokens'));
assert.ok(!truncated.writes.join('').includes('"type":"tool_use"'));
const capped = run([text, completed], true, { maxConversionStreamBytes: 8 });
assert.ok(capped.writes.join('').includes('event: error'));
const split = run([...text].map((character) => character).concat(completed));
assert.deepEqual(split.writes, run([text, completed]).writes);
const slow = run([text, tool, completed], true, {}, 'slow');
assert.deepEqual(slow.writes, run([text, tool, completed], true, {}, true).writes);
assert.equal(slow.logs.at(-1)[3], 200);
const cancelled = run([text, tool, completed], true, {}, 'cancel');
assert.equal(cancelled.logs.at(-1)[3], 499);
assert.ok(!cancelled.writes.join('').includes('message_stop'));
const aborted = run([text, tool, completed], true, {}, 'abort');
assert.equal(aborted.logs.at(-1)[3], 502);
assert.ok(!aborted.writes.join('').includes('message_stop'));
console.log('responses-claude-bridge.test.js passed');
