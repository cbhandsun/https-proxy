'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProxyStopControl, parseStopIdentity } = require('../lib/proxy/proxy-stop-control');
const flush = () => new Promise(setImmediate);

function exchange(
  control,
  body,
  type = 'application/json',
  socket = { localPort: 3543, localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' }
) {
  const req = new EventEmitter();
  req.headers = { 'content-type': type };
  req.socket = socket;
  const res = new EventEmitter();
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.end = (text) => {
    res.body = JSON.parse(text);
  };
  control.handle(req, res);
  if (body !== undefined) {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  }
  return { req, res };
}

test('stop identity rejects empty, illegal, extreme and executable object inputs without hooks', () => {
  const good = { pid: 1, instanceId: 'a'.repeat(32) };
  assert.deepEqual(parseStopIdentity(good), good);
  let hooks = 0;
  const getter = { ...good };
  Object.defineProperty(getter, 'pid', {
    get() {
      hooks++;
      return 1;
    },
    enumerable: true,
  });
  const proxy = new Proxy(good, {
    get() {
      hooks++;
      throw new Error('private');
    },
  });
  for (const input of [
    null,
    [],
    {},
    '',
    false,
    good.pid,
    { ...good, extra: 1 },
    getter,
    proxy,
    ...[0, -1, 1.5, NaN, Infinity, 0x100000000, '1'].map((pid) => ({ ...good, pid })),
    ...['', 'A'.repeat(32), '0'.repeat(31), 'f'.repeat(33), 'x'.repeat(4096), {}, null].map(
      (instanceId) => ({ ...good, instanceId })
    ),
    Object.assign(Object.create({ inherited: true }), good),
  ])
    assert.equal(parseStopIdentity(input), null);
  assert.equal(hooks, 0);
  assert.deepEqual(parseStopIdentity({ ...good, pid: 0xffffffff }), { ...good, pid: 0xffffffff });
});

test('stop intent binds once, preserves target identity and runs only after its response finishes', async () => {
  const control = createProxyStopControl();
  let calls = 0;
  assert.equal(Object.isFrozen(control.identity), true);
  assert.equal(control.identity.pid, process.pid);
  control.bind(() => {
    calls++;
  }, 3543);
  assert.throws(() => control.bind(() => {}, 3543));
  const { res } = exchange(control, JSON.stringify(control.identity));
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { accepted: true, ...control.identity });
  assert.equal(res.headers.Connection, 'close');
  assert.equal(res.headers['Content-Length'], Buffer.byteLength(JSON.stringify(res.body)));
  await flush();
  assert.equal(calls, 0);
  assert.equal(exchange(control, JSON.stringify(control.identity)).res.status, 409);
  res.emit('finish');
  res.emit('close');
  await flush();
  assert.equal(calls, 1);
});

test('malformed, oversized, stale, aborted and disconnected requests cannot stop the runtime', async () => {
  const control = createProxyStopControl();
  let calls = 0;
  control.bind(() => {
    calls++;
  }, 3543);
  for (const body of [
    '',
    'null',
    '[]',
    '{}',
    '{',
    ' '.repeat(129),
    JSON.stringify({ ...control.identity, pid: process.pid + 1 }),
    JSON.stringify({ ...control.identity, instanceId: '0'.repeat(32) }),
  ]) {
    const { res } = exchange(control, body);
    assert.ok([400, 409].includes(res.status));
    res.emit('finish');
  }
  assert.equal(exchange(control, '{}', 'text/plain').res.status, 415);
  const aborted = exchange(control);
  aborted.req.emit('aborted');
  aborted.req.emit('data', Buffer.from(JSON.stringify(control.identity)));
  aborted.req.emit('end');
  assert.equal(aborted.res.status, undefined);
  const disconnected = exchange(control, JSON.stringify(control.identity));
  disconnected.res.emit('close');
  disconnected.res.emit('finish');
  await flush();
  assert.equal(calls, 0);
  const next = exchange(control, JSON.stringify(control.identity));
  assert.equal(next.res.status, 202);
  next.res.emit('finish');
  await flush();
  assert.equal(calls, 1);
});

test('unbound and asynchronous shutdown compositions fail closed', () => {
  const control = createProxyStopControl();
  assert.equal(exchange(control, JSON.stringify(control.identity)).res.status, 503);
  for (const invalid of [null, {}, async () => {}, function* () {}, new Proxy(() => {}, {})])
    assert.throws(() => control.bind(invalid, 3543));
});

test('stop control refuses other listeners and invalid port bindings without starting shutdown', async () => {
  const control = createProxyStopControl();
  let calls = 0;
  for (const port of [undefined, 0, -1, 65536, 1.5, NaN, '3543'])
    assert.throws(() => control.bind(() => {}, port));
  control.bind(() => {
    calls++;
  }, 3543);
  for (const socket of [
    null,
    {},
    { localPort: 3544, localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' },
    { localPort: 3543, localAddress: '0.0.0.0', remoteAddress: '127.0.0.1' },
    { localPort: 3543, localAddress: '127.0.0.1', remoteAddress: '192.0.2.1' },
  ]) {
    const { res } = exchange(control, JSON.stringify(control.identity), 'application/json', socket);
    assert.equal(res.status, 403);
    res.emit('finish');
  }
  await flush();
  assert.equal(calls, 0);
});
