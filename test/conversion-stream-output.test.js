'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { Writable } = require('node:stream');
const { createConversionStreamOutput } = require('../lib/proxy/conversion-stream-output');
const { createResponsesChatStreamHandler } = require('../lib/proxy/handlers/responses-chat-stream');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');

function harness(options = {}) {
  const downstream = new EventEmitter();
  const upstream = new EventEmitter();
  const writes = [],
    reports = [];
  let pauses = 0,
    resumes = 0,
    destroys = 0,
    ends = 0;
  downstream.writableLength = 0;
  downstream.write = (chunk) => {
    writes.push(String(chunk));
    const accepted = downstream.accepted !== false;
    if (!accepted) downstream.writableLength += Buffer.byteLength(chunk);
    return accepted;
  };
  downstream.end = () => {
    ends++;
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
    destroys++;
    upstream.emit('close');
  };
  const args = {
    proxyRes: upstream,
    clientRes: downstream,
    clientReq: { method: 'POST' },
    upstreamPath: '/synthetic',
    startTime: 1,
    protocolOptions: options,
    logRequestEnd: (...values) => reports.push(values),
  };
  const flow = createConversionStreamOutput(args);
  return {
    args,
    flow,
    sink: flow.clientRes,
    downstream,
    upstream,
    writes,
    reports,
    counts: () => ({ pauses, resumes, destroys, ends }),
    drain() {
      downstream.writableLength = 0;
      downstream.emit('drain');
    },
  };
}
function detached(h) {
  for (const event of ['drain', 'close', 'error', 'finish'])
    assert.equal(h.downstream.listenerCount(event), 0, event);
}
{
  const h = harness();
  h.downstream.accepted = false;
  assert.equal(h.sink.write('A'), false);
  const bytes = Buffer.from('你好');
  h.sink.write(bytes);
  bytes.fill(0);
  h.sink.write('C');
  assert.deepEqual(h.writes, ['A']);
  assert.equal(h.counts().pauses, 1);
  h.downstream.accepted = true;
  h.drain();
  assert.deepEqual(h.writes, ['A', '你好', 'C']);
  assert.equal(h.counts().resumes, 1);
  h.sink.end();
  detached(h);
}
{
  const h = harness();
  h.downstream.accepted = false;
  h.sink.write('A');
  h.sink.write('B');
  h.sink.end('C');
  h.flow.logRequestEnd('POST', '/synthetic', 1, 200, { type: 'synthetic' });
  assert.equal(h.counts().ends, 0);
  assert.equal(h.reports.length, 0);
  h.drain(); // B fills the writable again: C must remain queued.
  assert.deepEqual(h.writes, ['A', 'B']);
  assert.equal(h.counts().ends, 0);
  h.downstream.accepted = true;
  h.drain();
  assert.deepEqual(h.writes, ['A', 'B', 'C']);
  assert.equal(h.counts().ends, 1);
  assert.equal(h.reports[0][3], 200);
  assert.equal(h.reports.length, 1);
  h.sink.end();
  h.downstream.emit('close');
  assert.equal(h.reports.length, 1);
  detached(h);
}
for (const cause of ['limit', 'close', 'error', 'invalid', 'throw']) {
  const h = harness({ maxConversionOutputBufferBytes: 6 });
  h.downstream.accepted = false;
  h.sink.write('abc');
  h.sink.write('d');
  h.flow.logRequestEnd('POST', '/synthetic', 1, 200, {});
  if (cause === 'limit') h.sink.write('你好');
  if (cause === 'close') h.downstream.destroy();
  if (cause === 'error') h.downstream.emit('error', new Error('secret-content'));
  if (cause === 'invalid') h.sink.write({ secret: 'secret-content' });
  if (cause === 'throw') {
    h.downstream.write = () => {
      throw Error('secret-content');
    };
    h.drain();
  }
  assert.equal(h.flow.isStopped(), true);
  assert.equal(h.counts().destroys, 1);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0][3], cause === 'close' ? 499 : 502);
  assert.equal(JSON.stringify(h.reports).includes('secret-content'), false);
  h.drain();
  h.sink.end();
  assert.equal(h.counts().ends, 0);
  detached(h);
}
{
  const h = harness({ maxConversionOutputBufferBytes: 2 });
  h.sink.write('你');
  assert.equal(h.writes.length, 0);
  assert.equal(h.flow.isStopped(), true);
}
{
  const h = harness();
  h.downstream.accepted = false;
  h.sink.write('A');
  for (let i = 0; i < 8193; i++) h.sink.write('');
  assert.equal(h.flow.isStopped(), true, 'byte limits also bound empty queue entries');
  detached(h);
}
{
  const h = harness();
  h.downstream.accepted = false;
  h.sink.write('A');
  h.sink.write('B');
  h.flow.dispose();
  h.drain();
  assert.deepEqual(h.writes, ['A']);
  assert.equal(h.reports.length, 0);
  detached(h);
}
// Actual Responses conversion must keep terminal events queued until drain.
{
  const h = harness();
  h.flow.dispose();
  h.downstream.accepted = false;
  h.downstream.writeHead = () => {};
  const p = createOpenAIProtocol({});
  const handle = createResponsesChatStreamHandler({
    fallbackId: () => 'id',
    stableCreated: () => 1,
    processOpenAIResponsesSseChunkToChat: p.processOpenAIResponsesSseChunkToChat,
    flushOpenAIResponsesSseToChat: p.flushOpenAIResponsesSseToChat,
    logRequestEnd: (...a) => h.reports.push(a),
  });
  handle({ ...h.args, parsed: { model: 'synthetic', messages: [] } });
  const event = (data) => Buffer.from('data: ' + JSON.stringify(data) + '\n\n');
  h.upstream.emit('data', event({ type: 'response.output_text.delta', delta: '你好' }));
  h.upstream.emit(
    'data',
    event({ type: 'response.completed', response: { status: 'completed', output: [] } })
  );
  assert.equal(h.counts().ends, 0);
  assert.equal(h.reports.length, 0);
  h.downstream.accepted = true;
  h.drain();
  assert.equal(h.counts().ends, 1);
  assert.equal(h.reports[0][3], 200);
  assert(h.writes.join('').includes('你好'));
  assert(h.writes.join('').includes('[DONE]'));
}

(async () => {
  {
    const h = harness({ conversionDrainTimeoutMs: 5 });
    h.downstream.accepted = false;
    h.sink.write('A');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.reports[0][4].errorCode, 'downstream_stream_drain_timeout');
    detached(h);
  }
  // Real Node Writable exercises repeated drain and asynchronous finish events.
  {
    const output = [];
    const downstream = new Writable({
      highWaterMark: 4,
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        setImmediate(callback);
      },
    });
    let pauses = 0;
    const reports = [];
    const flow = createConversionStreamOutput({
      proxyRes: {
        pause() {
          pauses++;
        },
        resume() {},
        destroy() {},
      },
      clientRes: downstream,
      clientReq: { method: 'POST' },
      upstreamPath: '/synthetic',
      startTime: 1,
      logRequestEnd: (...a) => reports.push(a),
    });
    const completed = once(downstream, 'finish');
    for (let i = 0; i < 20; i++) flow.clientRes.write('你好');
    flow.clientRes.end();
    flow.logRequestEnd('POST', '/synthetic', 1, 200, {});
    await completed;
    assert.equal(output.join(''), '你好'.repeat(20));
    assert(pauses > 0);
    assert.equal(reports.length, 1);
    assert.equal(reports[0][3], 200);
  }
  console.log('conversion-stream-output.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
