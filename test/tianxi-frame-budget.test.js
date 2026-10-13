'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTianxiFrameBudget } = require('../lib/proxy/tianxi-frame-budget');
const { createTacServerTransport } = require('../lib/proxy/tianxi-agentcore-local');

test('frame budget retains ordered records and counts malformed wire input', () => {
  const budget = createTianxiFrameBudget({ messageBytes: 100, totalBytes: 200, messages: 6 });
  for (const text of ['', '{', 'null', '[]']) assert.equal(budget.parse(text), null);
  const frame = budget.parse('{"type":"task_output"}');
  budget.appendLocal({ type: 'task_status' });
  assert.deepEqual(budget.frames, [frame, { type: 'task_status' }]);
  assert.throws(() => budget.parse('{}'), /tianxi_tac_server_output_limit/);
});

test('per-message and cumulative budgets measure UTF-8 and fail atomically', () => {
  const budget = createTianxiFrameBudget({ messageBytes: 8, totalBytes: 10, messages: 10 });
  assert.equal(budget.parse('"界界"'), null); // exactly eight bytes
  assert.throws(() => budget.parse('"界界界"'), /tianxi_tac_server_output_limit/);
  assert.deepEqual(budget.parse('{}'), {}); // rejected input consumed no budget
  assert.throws(() => budget.appendLocal({}), /tianxi_tac_server_output_limit/);
  assert.deepEqual(budget.frames, [{}]);
});

test('unsafe policy, invalid input and local serialization failures have fixed errors', () => {
  for (const value of [null, [], 'invalid'])
    assert.throws(() => createTianxiFrameBudget(value), /Invalid Tianxi frame budget/);
  for (const value of [0, -1, 1.5, Infinity, '1', 1048577])
    assert.throws(
      () => createTianxiFrameBudget({ messageBytes: value, totalBytes: 10, messages: 10 }),
      /Invalid Tianxi frame budget/
    );
  const budget = createTianxiFrameBudget();
  for (const value of [null, {}, undefined])
    assert.throws(() => budget.parse(value), /tianxi_tac_server_output_limit/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => budget.appendLocal(circular), /tianxi_tac_server_output_limit/);
  assert.deepEqual(budget.frames, []);
});

test('transport overflow closes once and suppresses callbacks and late terminal events', async () => {
  let socket,
    closes = 0,
    callbacks = 0;
  class FakeWebSocket {
    constructor() {
      socket = this;
      this.listeners = {};
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {}
    close() {
      closes++;
    }
  }
  const controller = new globalThis.AbortController();
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    autoStart: false,
    discoverWsUrls: () => [],
  });
  const pending = transport.sendQuery(
    { type: 'query' },
    {
      signal: controller.signal,
      onFrame() {
        callbacks++;
      },
    }
  );
  const rejected = assert.rejects(
    pending,
    (error) => error.message === 'tianxi_tac_server_output_limit'
  );
  socket.listeners.message({
    data: JSON.stringify({ type: 'task_output', data: { content: 'SECRET'.repeat(180000) } }),
  });
  socket.listeners.message({ data: '{"type":"task_status","data":{"status":"COMPLETED"}}' });
  controller.abort();
  await rejected;
  assert.equal(closes, 1);
  assert.equal(callbacks, 0);
});

test('normal transport completes and malformed events remain safely ignored', async () => {
  let socket;
  class FakeWebSocket {
    constructor() {
      socket = this;
      this.listeners = {};
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {}
    close() {}
  }
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    autoStart: false,
    discoverWsUrls: () => [],
  });
  const pending = transport.sendQuery({ type: 'query' });
  for (const data of ['{', 'null', '[]', '{"type":"task_status","data":{"status":"COMPLETED"}}'])
    socket.listeners.message({ data });
  assert.equal((await pending).length, 1);
});
