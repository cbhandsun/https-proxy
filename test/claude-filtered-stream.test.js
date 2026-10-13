'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createClaudeStream } = require('../lib/proxy/stream-claude');
const { bindClaudeFilteredStream } = require('../lib/proxy/handlers/claude-filtered-stream');
const { createUpstreamStreamGuard } = require('../lib/proxy/handlers/upstream-stream-guard');
const { parseClaudeSseEvent, deltaPartialJson, resolveSseBlockIndex } = require('../lib/proxy/sse');
const event = (type, data) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
const start = event('message_start', {
  message: { id: 'synthetic', role: 'assistant', content: [] },
});
const toolStart = event('content_block_start', {
  index: 0,
  content_block: { type: 'tool_use', id: 'tool', name: 'lookup', input: {} },
});
const toolDelta = (text) =>
  event('content_block_delta', {
    index: 0,
    delta: { type: 'input_json_delta', partial_json: text },
  });
const toolStop = event('content_block_stop', { index: 0 });
const terminal = (reason = 'tool_use') =>
  event('message_delta', { delta: { stop_reason: reason } }) + event('message_stop', {});
function harness(options = {}, mode) {
  const upstream = new EventEmitter(),
    downstream = new EventEmitter();
  const writes = [],
    failures = [],
    reports = [];
  let pauses = 0,
    resumes = 0;
  downstream.writableLength = 0;
  downstream.write = (chunk) => {
    writes.push(String(chunk));
    if (downstream.blocked) {
      downstream.writableLength += Buffer.byteLength(chunk);
      return false;
    }
    return true;
  };
  downstream.end = () => {
    downstream.writableEnded = true;
    downstream.emit('finish');
  };
  downstream.destroy = () => {
    downstream.destroyed = true;
    downstream.emit('close');
  };
  upstream.pause = () => {
    pauses++;
  };
  upstream.resume = () => {
    resumes++;
  };
  upstream.destroy = () => {
    upstream.destroyed = true;
    upstream.emit('close');
  };
  const logRequestEnd = (...args) => reports.push(args);
  const guard = createUpstreamStreamGuard({ logRequestEnd })(upstream, {
    clientRes: downstream,
    method: 'POST',
    upstreamPath: '/synthetic',
    startTime: 1,
    label: 'Claude',
  });
  const stream = createClaudeStream({
    parseClaudeSseEvent,
    resolveSseBlockIndex,
    deltaPartialJson,
    stripEmptyOptionalToolArgs: (_name, input) => input,
    cleanToolArgs: (_name, input) => input,
    sanitizeGeminiToolCall: (call) => ({ name: call.name, args: call.args }),
    sampleGeminiToolEvent() {},
    auditToolCall() {},
    sampleOutboundSse() {},
    protocolOptions: options,
  });
  const state = { buffer: '', ...(mode ? { mode } : {}) };
  const flow = bindClaudeFilteredStream({
    proxyRes: upstream,
    clientRes: downstream,
    clientReq: { method: 'POST' },
    upstreamPath: '/synthetic',
    startTime: 1,
    state,
    streamGuard: guard,
    protocolOptions: options,
    processChunk: stream.processClaudeSseChunk,
    finish: stream.flushClaudeSseFilter,
    logRequestEnd,
    onFailure: (code) => {
      failures.push(code);
    },
    onOutputFailure: (code) => {
      failures.push(code);
    },
    onComplete: (report) => report('POST', '/synthetic', 1, 200, { type: 'complete' }),
  });
  return {
    upstream,
    downstream,
    state,
    flow,
    writes,
    failures,
    reports,
    text: () => writes.join(''),
    send: (wire) => upstream.emit('data', Buffer.from(wire)),
    end: () => {
      upstream.complete = true;
      upstream.emit('end');
    },
    drain: () => {
      downstream.blocked = false;
      downstream.writableLength = 0;
      downstream.emit('drain');
    },
    counts: () => ({ pauses, resumes }),
  };
}
for (const mode of [undefined, 'strip-empty-optionals']) {
  const inline = harness({ maxConversionToolArgumentBytes: 20 }, mode);
  inline.send(
    start +
      event('content_block_start', {
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'tool',
          name: 'lookup',
          input: { q: 'x'.repeat(50) },
        },
      }) +
      toolStop +
      terminal()
  );
  inline.end();
  assert.deepEqual(inline.failures, ['upstream_stream_conversion_limit']);
  assert.ok(!inline.text().includes('"type":"tool_use"'));
  for (const invalid of [{ id: null }, { name: '' }, { index: -1 }]) {
    const h = harness({}, mode);
    const broken = event('content_block_start', {
      index: invalid.index ?? 0,
      content_block: { type: 'tool_use', id: 'tool', name: 'lookup', input: {}, ...invalid },
    });
    h.send(start + broken + toolDelta('{}') + toolStop + terminal());
    h.end();
    assert.equal(h.failures.length, 1);
    assert.ok(!h.text().includes('"type":"tool_use"'));
  }
  const h = harness({}, mode);
  h.send(start + toolStart + toolDelta('{"q":') + toolDelta('"中文"}') + toolStop + terminal());
  assert.ok(!h.text().includes('"type":"tool_use"'));
  assert.ok(!h.text().includes('event: message_stop'));
  h.end();
  assert.equal(h.failures.length, 0);
  assert.ok(h.text().includes('"type":"tool_use"'));
  assert.ok(h.text().includes('中文'));
  assert.ok(h.text().includes('event: message_stop'));
  assert.equal(h.reports.length, 1);
  for (const invalid of ['{"private-content":', '[]', 'null', '42', '"text"']) {
    const bad = harness({}, mode);
    bad.send(start + toolStart + toolDelta(invalid) + toolStop + terminal());
    bad.end();
    assert.equal(bad.failures.length, 1);
    assert.ok(!bad.text().includes('"type":"tool_use"'));
    assert.ok(!bad.text().includes('private-content'));
    assert.ok(!bad.text().includes('event: message_stop'));
  }
  const open = harness({}, mode);
  open.send(start + toolStart + toolDelta('{}'));
  open.end();
  assert.equal(open.failures.length, 1);
  assert.ok(!open.text().includes('"type":"tool_use"'));
  const missing = harness({}, mode);
  missing.send(start + toolStart + toolDelta('{}') + toolStop);
  missing.end();
  assert.equal(missing.failures.length, 1);
  assert.ok(!missing.text().includes('"type":"tool_use"'));
  const length = harness({}, mode);
  length.send(start + toolStart + toolDelta('{}') + toolStop + terminal('max_tokens'));
  length.end();
  assert.equal(length.failures.length, 1);
  assert.ok(!length.text().includes('"type":"tool_use"'));
  const oversized = harness({ maxConversionToolArgumentBytes: 5 }, mode);
  oversized.send(start + toolStart + toolDelta('中文'));
  assert.deepEqual(oversized.failures, ['upstream_stream_conversion_limit']);
  const duplicate = harness({}, mode);
  duplicate.send(start + toolStart + toolStart);
  assert.equal(duplicate.failures.length, 1);
}
{
  const h = harness();
  h.send(start + terminal('end_turn'));
  assert.ok(!h.text().includes('event: message_stop'));
  h.end();
  assert.equal(h.failures.length, 0);
  assert.equal(h.reports[0][3], 200);
}
{
  const h = harness();
  h.send(start + toolStart + toolDelta('{}') + toolStop + terminal());
  h.upstream.emit('aborted');
  h.upstream.emit('close');
  h.end();
  assert.ok(!h.text().includes('"type":"tool_use"'));
  assert.equal(h.state.buffer, '');
  assert.equal(h.flow.queuedBytes(), 0);
  assert.equal(h.reports.length, 1);
}
{
  const h = harness();
  h.send(
    start +
      terminal('end_turn') +
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'late' } })
  );
  h.end();
  assert.equal(h.failures.length, 1);
  assert.ok(!h.text().includes('event: message_stop'));
}
{
  const h = harness({ maxConversionStreamBytes: 1 });
  h.send(start);
  assert.deepEqual(h.failures, ['upstream_stream_conversion_limit']);
}
{
  const h = harness({ maxConversionOutputBufferBytes: 100 });
  h.send(toolStart + toolDelta('{}') + toolStop + terminal());
  h.end();
  assert.equal(h.failures.length, 1);
  assert.ok(!h.text().includes('"type":"tool_use"'));
}
{
  const h = harness();
  h.downstream.blocked = true;
  h.send(start);
  assert.equal(h.counts().pauses, 1);
  h.send(terminal('end_turn'));
  h.end();
  assert.equal(h.reports.length, 0);
  h.drain();
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0][3], 200);
}
{
  const h = harness();
  h.send(start + toolStart + toolDelta('{}') + toolStop);
  h.downstream.emit('close');
  h.end();
  assert.ok(!h.text().includes('"type":"tool_use"'));
  assert.equal(h.flow.queuedBytes(), 0);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0][3], 499);
}
console.log('claude-filtered-stream regressions passed');
