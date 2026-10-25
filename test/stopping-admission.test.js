'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStoppingAdmission } = require('../lib/proxy/stopping-admission');

function fixture() {
  let stopping = false;
  const requests = [],
    upgrades = [],
    replies = [];
  const socket = {
    end(value) {
      replies.push(value);
      this.writableEnded = true;
    },
  };
  const gate = createStoppingAdmission({
    isStopping: () => stopping,
    handleRequest: (...args) => {
      requests.push(args);
      return 'http';
    },
    handleUpgrade: (...args) => {
      upgrades.push(args);
      return 'upgrade';
    },
  });
  return {
    gate,
    socket,
    requests,
    upgrades,
    replies,
    stop() {
      stopping = true;
    },
  };
}

test('normal HTTP and upgrade admission preserve argument and result identity', () => {
  const f = fixture(),
    req = { socket: f.socket },
    res = new EventEmitter(),
    entry = {};
  const head = Buffer.alloc(16384, 65);
  assert.equal(f.gate.request(req, res, entry), 'http');
  assert.deepEqual(f.requests, [[req, res, entry]]);
  assert.equal(f.gate.upgrade(req, f.socket, head, entry), 'upgrade');
  assert.deepEqual(f.upgrades, [[req, f.socket, head, entry]]);
  res.emit('finish');
  res.emit('close');
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.deepEqual(f.replies, []);
});

test('stopping HTTP rejects before the business handler with a fixed non-cacheable close reply', () => {
  const f = fixture();
  f.stop();
  const written = [];
  const res = {
    writeHead(...args) {
      written.push(args);
    },
    end(value) {
      written.push(value);
    },
  };
  f.gate.request({ socket: f.socket }, res, {});
  assert.deepEqual(written, [
    [503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' }],
    '{"error":"Server is stopping"}',
  ]);
  assert.deepEqual(f.requests, []);
});

test('stopping upgrades wait for every admitted response, tolerate repeated close, and never dispatch head bytes', () => {
  const f = fixture(),
    req = { socket: f.socket },
    first = new EventEmitter(),
    second = new EventEmitter();
  f.gate.request(req, first, {});
  f.gate.request(req, second, {});
  f.stop();
  for (const head of [Buffer.alloc(0), Buffer.from('PRIVATE_SYNTHETIC'), Buffer.alloc(65536)])
    f.gate.upgrade(req, f.socket, head, {});
  assert.deepEqual(f.replies, []);
  first.emit('finish');
  first.emit('close');
  assert.deepEqual(f.replies, []);
  second.emit('finish');
  second.emit('close');
  assert.deepEqual(f.replies, [
    'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  ]);
  assert.deepEqual(f.upgrades, []);
});

test('stopping upgrades with no active response close immediately, but destroyed and ended sockets are not written', () => {
  for (const status of [undefined, 'destroyed', 'writableEnded']) {
    const f = fixture();
    if (status) f.socket[status] = true;
    f.stop();
    f.gate.upgrade({}, f.socket, Buffer.alloc(0), {});
    assert.equal(f.replies.length, status ? 0 : 1);
    assert.deepEqual(f.upgrades, []);
  }
});

test('failed HTTP dispatch propagates its exact error and releases response observations', () => {
  const failure = Error('PRIVATE_SYNTHETIC'),
    res = new EventEmitter();
  const gate = createStoppingAdmission({
    isStopping: () => false,
    handleRequest() {
      throw failure;
    },
  });
  assert.throws(
    () => gate.request({ socket: {} }, res, {}),
    (error) => error === failure
  );
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('invalid trusted compositions fail before dispatch', () => {
  for (const input of [
    undefined,
    null,
    {},
    { isStopping: true, handleRequest() {} },
    { isStopping() {}, handleRequest: null },
    { isStopping() {}, handleRequest() {}, handleUpgrade: false },
  ])
    assert.throws(() => createStoppingAdmission(input), TypeError);
});
