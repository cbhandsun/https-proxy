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
  const socket = Object.assign(new EventEmitter(), {
    end(value) {
      replies.push(value);
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
    },
  });
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

test('upgrade drain waits for actual close, is idempotent, and refuses late upgrade admission', async () => {
  const f = fixture();
  let closes = 0;
  f.socket.destroySoon = () => {
    closes++;
    f.socket.destroyed = true;
  };
  const head = Buffer.from('PRIVATE_SYNTHETIC');
  f.gate.upgrade({}, f.socket, head, {});
  const drain = f.gate.closeUpgrades();
  assert.equal(f.gate.closeUpgrades(), drain);
  let settled = false;
  void drain.then(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal(closes, 1);
  f.gate.upgrade({}, f.socket, head, {});
  assert.equal(f.upgrades.length, 1);
  f.socket.emit('close');
  assert.equal(await drain, true);
  f.socket.emit('close');
  assert.equal(f.socket.listenerCount('close'), 0);
  assert.equal(closes, 1);
});

test('upgrade drain preserves admitted HTTP responses before closing their shared connection', async () => {
  const f = fixture(),
    first = new EventEmitter(),
    second = new EventEmitter();
  f.gate.request({ socket: f.socket }, first, {});
  f.gate.request({ socket: f.socket }, second, {});
  f.gate.upgrade({}, f.socket, Buffer.alloc(0), {});
  let closes = 0;
  f.socket.destroySoon = () => {
    closes++;
    f.socket.emit('close');
  };
  const drain = f.gate.closeUpgrades();
  assert.equal(closes, 0);
  first.emit('finish');
  first.emit('close');
  assert.equal(closes, 0);
  second.emit('finish');
  second.emit('close');
  assert.equal(await drain, true);
  assert.equal(closes, 1);
  assert.equal(first.listenerCount('close'), 0);
  assert.equal(second.listenerCount('finish'), 0);
});

test('closed, absent and synchronously failed upgrade handlers leave no pending drain observations', async () => {
  const f = fixture();
  assert.equal(await f.gate.closeUpgrades(), true);
  const g = fixture();
  g.socket.destroyed = true;
  g.gate.upgrade({}, g.socket, Buffer.alloc(0), {});
  assert.equal(await g.gate.closeUpgrades(), true);
  const failure = Error('PRIVATE_UPGRADE');
  const socket = new EventEmitter();
  socket.destroy = () => {};
  const gate = createStoppingAdmission({
    isStopping: () => false,
    handleRequest() {},
    handleUpgrade() {
      throw failure;
    },
  });
  assert.throws(
    () => gate.upgrade({}, socket, Buffer.alloc(0), {}),
    (error) => error === failure
  );
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(await gate.closeUpgrades(), true);
});

for (const afterClose of [false, true]) {
  test(
    'failed upgrade close cannot authorize successful drain: emitted-close=' + afterClose,
    async () => {
      const f = fixture();
      f.socket.destroySoon = () => {
        if (afterClose) f.socket.emit('close');
        throw Error('PRIVATE_CLOSE');
      };
      f.gate.upgrade({}, f.socket, Buffer.alloc(0), {});
      const drain = f.gate.closeUpgrades();
      assert.equal(await drain, false);
      assert.equal(f.gate.closeUpgrades(), drain);
      assert.equal(f.socket.listenerCount('close'), 0);
    }
  );
}

test('natural upgrade close before shutdown and while HTTP is active does not leak a wait callback', async () => {
  for (const beforeStop of [false, true]) {
    const f = fixture(),
      response = new EventEmitter();
    f.gate.request({ socket: f.socket }, response, {});
    f.gate.upgrade({}, f.socket, Buffer.alloc(0), {});
    let drain;
    if (!beforeStop) drain = f.gate.closeUpgrades();
    f.socket.destroyed = true;
    f.socket.emit('close');
    if (beforeStop) drain = f.gate.closeUpgrades();
    assert.equal(await drain, true);
    response.emit('close');
    response.emit('finish');
    assert.equal(f.socket.listenerCount('close'), 0);
    assert.deepEqual(f.replies, []);
  }
});
