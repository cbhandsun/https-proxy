'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { parseClaudeSseEvent, deltaPartialJson } = require('../lib/proxy/sse');
const { attachClaudeChatStream } = require('../lib/proxy/handlers/claude-chat-stream');

const frame = (type, data = {}, delimiter = '\n') =>
  `event: ${type}${delimiter}data: ${JSON.stringify({ type, ...data })}${delimiter}${delimiter}`;
const startTool = (input = {}, index = 0) =>
  frame('content_block_start', {
    index,
    content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input },
  });
const args = (partial_json, index = 0) =>
  frame('content_block_delta', {
    index,
    delta: { type: 'input_json_delta', partial_json },
  });
const stopTool = frame('content_block_stop', { index: 0 });
const terminal = (reason = 'tool_use') =>
  frame('message_delta', {
    delta: { stop_reason: reason },
    usage: { output_tokens: 2 },
  }) + frame('message_stop');

function harness(options = {}, cleanToolArgs = (_name, input) => input) {
  const p = createOpenAIProtocol({
    parseClaudeSseEvent,
    deltaPartialJson,
    cleanToolArgs,
    protocolOptions: options,
  });
  const writes = [];
  const sink = {
    write: (value) => {
      writes.push(String(value));
      return true;
    },
  };
  const state = { id: 'test', model: 'synthetic', created: 1, buffer: '', toolCallIndex: 0 };
  return {
    p,
    writes,
    sink,
    state,
    feed: (value) => p.processClaudeSseChunkToOpenAI(sink, value, state),
    flush: () => p.flushClaudeSseToOpenAI(sink, state),
    payloads: () =>
      writes
        .join('')
        .split(/\n\n/)
        .filter((s) => s.startsWith('data: {'))
        .map((s) => JSON.parse(s.slice(6))),
  };
}
function assertFailed(h, code) {
  assert.equal(h.state.done, true);
  assert.equal(h.state.failed, true);
  assert.equal(h.state.failureCode, code);
  assert.equal(h.payloads().filter((p) => p.error).length, 1);
  assert.equal(
    h.payloads().some((p) => p.choices?.[0]?.finish_reason),
    false
  );
  assert.equal(
    h.payloads().some((p) => p.choices?.[0]?.delta?.tool_calls),
    false
  );
  const length = h.writes.length;
  h.feed(terminal());
  h.flush();
  assert.equal(h.writes.length, length, 'terminal and failure are emitted once');
}

// Empty or interrupted EOF never synthesizes success, even with a valid closed tool.
for (const input of [
  '',
  frame('message_start'),
  startTool() + args('{"x":1}') + stopTool,
  startTool() + args('{"x":'),
  startTool() + args('{}') + frame('message_stop'),
]) {
  const h = harness();
  h.feed(input);
  h.flush();
  assertFailed(h, 'upstream_stream_incomplete');
}
// Invalid/scalar arguments never become an executable fallback object.
for (const value of ['{"secret":"do-not-leak"', 'null', '[]', '1', '"text"', ' ']) {
  const h = harness();
  h.feed(startTool() + args(value) + stopTool + terminal());
  assertFailed(h, 'upstream_stream_invalid_tool_arguments');
  assert.equal(h.writes.join('').includes('do-not-leak'), false);
}
for (const input of [null, [], 'bad', 1]) {
  const h = harness();
  h.feed(startTool(input));
  assertFailed(h, 'upstream_stream_invalid_tool_arguments');
}
for (const delta of [42, {}, null]) {
  const h = harness();
  h.feed(startTool() + args(delta));
  assertFailed(h, 'upstream_stream_invalid_tool_arguments');
}
{
  const h = harness();
  h.feed(startTool() + args('') + args('{}') + stopTool + terminal());
  assert.equal(h.state.failed, undefined, 'empty string deltas are valid');
}
{
  const h = harness({}, () => {
    throw new Error('token-and-user-content');
  });
  h.feed(startTool() + stopTool);
  assertFailed(h, 'upstream_stream_conversion_error');
  assert.equal(h.writes.join('').includes('token-and-user-content'), false);
}
{
  const h = harness();
  h.feed(startTool() + args('{"__proto__":{"polluted":true}}') + stopTool + terminal());
  assert.equal({}.polluted, undefined);
  assert.equal(h.state.failed, undefined);
}
{
  const h = harness();
  h.feed(startTool() + args('{}', 1));
  assertFailed(h, 'upstream_stream_invalid_tool_arguments');
}
// UTF-8 byte limits are cumulative across tiny deltas and include initial input.
{
  const h = harness({ maxConversionToolArgumentBytes: 8 });
  h.feed(startTool() + args('你'));
  h.feed(args('好'));
  h.feed(args('!'));
  assertFailed(h, 'upstream_stream_conversion_limit');
}
for (const setup of [
  [{ maxConversionToolArgumentBytes: 8 }, startTool({ value: 'too long' })],
  [{ maxConversionToolCalls: 1 }, startTool() + stopTool + startTool()],
  [{ maxConversionStreamBytes: 8 }, ': heartbeat\n\n'],
  [{ maxSseBufferChars: 8 }, 'data: ' + 'x'.repeat(9)],
]) {
  const h = harness(setup[0]);
  h.feed(setup[1]);
  assertFailed(
    h,
    setup[0].maxSseBufferChars
      ? 'upstream_stream_event_too_large'
      : 'upstream_stream_conversion_limit'
  );
}
{
  const h = harness({ maxConversionToolArgumentBytes: 8 }, () => ({ expanded: 'too long' }));
  h.feed(startTool() + stopTool);
  assertFailed(h, 'upstream_stream_conversion_limit');
}
// Complete tools remain buffered until message_stop; fragmented CRLF and Unicode survive.
{
  const h = harness();
  h.feed(startTool() + args('{}') + stopTool + startTool() + args('{bad') + stopTool);
  assertFailed(h, 'upstream_stream_invalid_tool_arguments');
}
{
  const h = harness();
  h.feed(startTool() + stopTool + startTool() + stopTool + terminal());
  const calls = h.payloads().flatMap((p) => p.choices?.[0]?.delta?.tool_calls || []);
  assert.deepEqual(
    calls.map((call) => call.index),
    [0, 1]
  );
}
{
  const h = harness();
  h.feed(frame('message_start', { message: { usage: { input_tokens: 3 } } }));
  h.feed(startTool({ existing: true }) + args('{"value":"你') + args('好"}') + stopTool);
  assert.equal(
    h.payloads().some((p) => p.choices?.[0]?.delta?.tool_calls),
    false
  );
  const ending = terminal().replace(/\n/g, '\r\n');
  for (const ch of ending) h.feed(ch);
  h.flush();
  const call = h.payloads().find((p) => p.choices?.[0]?.delta?.tool_calls).choices[0].delta
    .tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), { existing: true, value: '你好' });
  assert.equal(h.payloads().at(-1).choices[0].finish_reason, 'tool_calls');
  assert.equal(h.payloads().at(-1).usage.total_tokens, 5);
  const length = h.writes.length;
  h.feed(terminal());
  h.flush();
  assert.equal(h.writes.length, length);
}
for (const reason of ['end_turn', 'max_tokens', 'refusal']) {
  const h = harness();
  h.feed(startTool() + stopTool + terminal(reason));
  assert.equal(h.state.failed, undefined);
  assert.equal(
    h.payloads().at(-1).choices[0].finish_reason,
    reason === 'max_tokens' ? 'length' : reason === 'refusal' ? 'content_filter' : 'tool_calls'
  );
  if (reason !== 'end_turn')
    assert.equal(
      h.payloads().some((p) => p.choices?.[0]?.delta?.tool_calls),
      false
    );
}
// Event caps apply per event, not to a batch of small valid events.
{
  const h = harness({ maxSseBufferChars: 160 });
  h.feed(frame('ping').repeat(20) + terminal('end_turn'));
  assert.equal(h.state.failed, undefined);
  assert.equal(h.state.done, true);
}
for (const raw of [
  'event: error\ndata: {"error":{"message":"secret"}}\n\n',
  'data: {bad\n\n',
  'data: null\n\n',
  'data: []\n\n',
]) {
  const h = harness();
  h.feed(raw);
  assertFailed(
    h,
    raw.startsWith('event: error') ? 'upstream_stream_error' : 'upstream_stream_invalid_event'
  );
  assert.equal(h.writes.join('').includes('secret'), false);
}
// Error frames propagate through the Claude -> Chat -> Responses bridge as failure.
{
  const h = harness();
  const out = [];
  const responseState = { id: 'resp', buffer: '', outputIndex: 0 };
  const sink = {
    write: (chunk) =>
      h.p.processOpenAIChatSseChunkToResponses({ write: (s) => out.push(s) }, chunk, responseState),
  };
  h.p.processClaudeSseChunkToOpenAI(sink, startTool() + args('{bad') + stopTool, h.state);
  assert.equal(responseState.failed, true);
  assert.equal(out.join('').includes('response.completed'), false);
  assert.equal(out.join('').includes('response.failed'), true);
}
// Route binding stops the upstream and logs failures once despite a later end event.
{
  const h = harness();
  const upstream = new EventEmitter();
  let ended = 0;
  const statuses = [];
  h.sink.end = () => {
    ended++;
  };
  attachClaudeChatStream({
    proxyRes: upstream,
    clientRes: h.sink,
    state: h.state,
    streamGuard: { hasFailed: () => false, markComplete() {} },
    processChunk: h.p.processClaudeSseChunkToOpenAI,
    flush: h.p.flushClaudeSseToOpenAI,
    reportEnd: (status) => statuses.push(status),
  });
  upstream.emit('end');
  assertFailed(h, 'upstream_stream_incomplete');
  assert.deepEqual(statuses, [502]);
  assert.equal(ended, 1);
}
for (const failed of [false, true]) {
  const h = harness();
  const upstream = new EventEmitter();
  let destroyed = 0;
  let ended = 0;
  upstream.destroy = () => {
    destroyed++;
  };
  const statuses = [];
  let completed = 0;
  h.sink.end = () => {
    ended++;
  };
  attachClaudeChatStream({
    proxyRes: upstream,
    clientRes: h.sink,
    state: h.state,
    streamGuard: {
      hasFailed: () => false,
      markComplete: () => {
        completed++;
      },
    },
    processChunk: h.p.processClaudeSseChunkToOpenAI,
    flush: h.p.flushClaudeSseToOpenAI,
    reportEnd: (status) => statuses.push(status),
  });
  upstream.emit('data', Buffer.from(failed ? 'data: bad\n\n' : terminal('end_turn')));
  upstream.emit('end');
  assert.deepEqual(statuses, [failed ? 502 : 200]);
  assert.equal(destroyed, 1);
  assert.equal(ended, 1);
  assert.equal(completed, 1);
}
console.log('claude-chat-stream-boundaries.test.js passed');
