'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const { createInboundActivity, inboundActivity } = require('../lib/proxy/inbound-activity');
const { createConcurrencyGuard, createUpgradeGuard } = require('../lib/proxy/inbound-controls');

test('Activity snapshots are immutable, independent and contain only safe counts', () => {
  const activity = createInboundActivity();
  const empty = activity.snapshot();
  assert.deepEqual(empty, { activeHttpRequests: 0, activeUpgradeConnections: 0, idle: true });
  assert.ok(Object.isFrozen(activity) && Object.isFrozen(empty));
  const endHttp = activity.beginHttp();
  const endUpgrade = activity.beginUpgrade();
  assert.deepEqual(activity.snapshot(), {
    activeHttpRequests: 1,
    activeUpgradeConnections: 1,
    idle: false,
  });
  assert.equal(empty.idle, true);
  assert.equal(createInboundActivity().snapshot().idle, true);
  assert.throws(() => {
    empty.idle = false;
  }, TypeError);
  endHttp();
  endHttp();
  assert.equal(activity.snapshot().activeUpgradeConnections, 1);
  endUpgrade();
  endUpgrade();
  assert.deepEqual(activity.snapshot(), empty);
});

test('Large overlapping activity releases never underflow or retain caller data', () => {
  const activity = createInboundActivity();
  const releases = Array.from({ length: 10000 }, () => activity.beginHttp());
  assert.equal(activity.snapshot().activeHttpRequests, 10000);
  for (const release of releases.reverse()) {
    release();
    release();
  }
  assert.deepEqual(activity.snapshot(), {
    activeHttpRequests: 0,
    activeUpgradeConnections: 0,
    idle: true,
  });
});

test('HTTP activity spans stream writes, aggregates guards and excludes rejected admission', () => {
  assert.equal(inboundActivity.snapshot().idle, true);
  const response = () => Object.assign(new EventEmitter(), { writeHead() {}, end() {} });
  const first = response();
  const second = response();
  const rejected = response();
  const state = { activeRequests: 0 };
  const guard = createConcurrencyGuard(() => {}, { state, maxConcurrentRequests: 2 });
  const other = createConcurrencyGuard(() => {}, { state, maxConcurrentRequests: 2 });
  guard({}, first);
  other({}, second);
  guard({}, rejected);
  assert.equal(inboundActivity.snapshot().activeHttpRequests, 2);
  first.emit('data', 'PRIVATE user content');
  first.emit('end');
  assert.equal(inboundActivity.snapshot().activeHttpRequests, 2);
  first.emit('finish');
  first.emit('close');
  assert.equal(inboundActivity.snapshot().activeHttpRequests, 1);
  second.emit('close');
  rejected.emit('finish');
  assert.equal(inboundActivity.snapshot().idle, true);
  assert.equal(first.listenerCount('close') + second.listenerCount('finish'), 0);
  assert.doesNotMatch(JSON.stringify(inboundActivity.snapshot()), /PRIVATE|content|headers|cookie/);
});

test('Management exclusion retains concurrency limits without counting the health query itself', () => {
  for (const value of [null, 0, 'false', [], {}]) {
    assert.throws(
      () => createConcurrencyGuard(() => {}, { trackActivity: value }),
      /requires boolean trackActivity/
    );
  }
  const response = () => Object.assign(new EventEmitter(), { writeHead() {}, end() {} });
  const first = response();
  const rejected = response();
  let calls = 0;
  const guarded = createConcurrencyGuard(
    () => {
      calls++;
      assert.equal(inboundActivity.snapshot().idle, true);
    },
    { trackActivity: false, maxConcurrentRequests: 1 }
  );
  guarded({}, first);
  assert.equal(guarded.getActiveRequestCount(), 1);
  guarded({}, rejected);
  assert.equal(calls, 1);
  first.emit('close');
  rejected.emit('finish');
  assert.equal(guarded.getActiveRequestCount(), 0);
  assert.equal(inboundActivity.snapshot().idle, true);
});

test('Handler failure releases HTTP activity before rethrowing the original error', () => {
  const error = new Error('PRIVATE');
  const guard = createConcurrencyGuard(() => {
    throw error;
  });
  const res = new EventEmitter();
  assert.throws(
    () => guard({}, res),
    (value) => value === error
  );
  assert.equal(inboundActivity.snapshot().idle, true);
  assert.equal(guard.getActiveRequestCount(), 0);
  assert.equal(res.listenerCount('close') + res.listenerCount('finish'), 0);
});

test('Upgrade activity ends on socket close and preserves handler arguments and result', () => {
  assert.throws(() => createUpgradeGuard(null), /requires a request handler/);
  const req = {};
  const socket = new EventEmitter();
  const head = Buffer.alloc(0);
  const guarded = createUpgradeGuard((...args) => {
    assert.deepEqual(args, [req, socket, head]);
    return 42;
  });
  assert.throws(() => guarded(req, null, head), /requires a socket/);
  assert.equal(inboundActivity.snapshot().idle, true);
  assert.equal(guarded(req, socket, head), 42);
  assert.equal(inboundActivity.snapshot().activeUpgradeConnections, 1);
  socket.emit('end');
  assert.equal(inboundActivity.snapshot().idle, false);
  socket.emit('close');
  socket.emit('close');
  assert.equal(inboundActivity.snapshot().idle, true);
  assert.equal(socket.listenerCount('close'), 0);
});

test('Synchronous upgrade failures release activity and propagate without logging', () => {
  const error = new Error('PRIVATE');
  const socket = new EventEmitter();
  const guarded = createUpgradeGuard(() => {
    throw error;
  });
  assert.throws(
    () => guarded({}, socket, Buffer.alloc(0)),
    (value) => value === error
  );
  assert.equal(inboundActivity.snapshot().idle, true);
  socket.emit('close');
  assert.equal(inboundActivity.snapshot().activeUpgradeConnections, 0);
});

test('Real HTTP keep-alive is idle after completion while an unfinished SSE response stays active', async () => {
  let pending;
  const started = new EventEmitter();
  const server = http.createServer(
    createConcurrencyGuard((req, res) => {
      if (req.url === '/stream') {
        pending = res;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': started\n\n');
        started.emit('stream');
      } else res.end('ok');
    })
  );
  const agent = new http.Agent({ keepAlive: true });
  let stream;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
          res.resume();
          res.once('end', resolve);
        })
        .once('error', reject);
    });
    assert.equal(inboundActivity.snapshot().idle, true);
    assert.ok(Object.values(agent.freeSockets).some((sockets) => sockets.length > 0));
    const streamStarted = once(started, 'stream');
    stream = http.get({ host: '127.0.0.1', port, path: '/stream', agent }, (res) => res.resume());
    stream.on('error', () => {});
    await streamStarted;
    assert.equal(inboundActivity.snapshot().activeHttpRequests, 1);
    const closed = once(pending, 'close');
    stream.destroy();
    await closed;
    assert.equal(inboundActivity.snapshot().idle, true);
  } finally {
    stream?.destroy();
    pending?.destroy();
    agent.destroy();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
