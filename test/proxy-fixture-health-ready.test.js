'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createProxyFixtureHealthProbe } = require('./helpers/proxy-fixture-health');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');

const options = { port: 23001, entryPort: 23002, pid: 1234, token: 'synthetic-management-token' };
const health = {
  ok: true,
  appId: 'https-proxy-manager',
  status: 'running',
  pid: options.pid,
  ports: {
    management: options.port,
    entries: [{ listenPort: options.entryPort, protocol: 'openai-responses', tls: false }],
  },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function transport({
  status = 200,
  body = JSON.stringify(health),
  error = false,
  timedOut = false,
  partial = false,
  invalidChunk = false,
} = {}) {
  let destroyed = 0;
  return {
    destroyed: () => destroyed,
    request(input, callback) {
      assert.equal(input.host, '127.0.0.1');
      assert.equal(input.port, options.port);
      assert.equal(input.method, 'GET');
      assert.equal(input.path, '/v1/local/health');
      assert.deepEqual(input.headers, { 'x-mgmt-token': options.token });
      const req = new EventEmitter();
      req.destroy = () => {
        destroyed += 1;
      };
      req.setTimeout = (delay, expire) => {
        assert.equal(delay, 500);
        req.expire = expire;
      };
      req.end = () =>
        setImmediate(() => {
          if (error) {
            req.emit('error', new Error('PRIVATE_NETWORK'));
            return;
          }
          if (timedOut) {
            req.expire();
            return;
          }
          const res = new EventEmitter();
          res.statusCode = status;
          callback(res);
          if (status !== 200) return;
          res.emit('data', invalidChunk ? {} : Buffer.from(body));
          res.emit(partial ? 'aborted' : 'end');
        });
      return req;
    },
  };
}

test('authenticated readiness proves app, PID, management port and entry identity with bounded responses', async () => {
  const t = transport();
  const probe = createProxyFixtureHealthProbe({ ...options, request: t.request });
  assert.equal(await probe(new globalThis.AbortController().signal), true);
  assert.equal(t.destroyed(), 1);
  for (const body of [
    null,
    [],
    {},
    { ...health, ok: false },
    { ...health, pid: 9 },
    { ...health, appId: 'other' },
    { ...health, status: 'starting' },
    { ...health, ports: { ...health.ports, management: 9 } },
    { ...health, ports: { ...health.ports, entries: [{ ...health.ports.entries[0], tls: true }] } },
    {
      ...health,
      ports: { ...health.ports, entries: [{ ...health.ports.entries[0], listenPort: 9 }] },
    },
    {
      ...health,
      ports: { ...health.ports, entries: [{ ...health.ports.entries[0], protocol: 'other' }] },
    },
    { ...health, ports: { ...health.ports, entries: {} } },
  ]) {
    const mismatch = transport({ body: JSON.stringify(body) });
    assert.equal(
      await createProxyFixtureHealthProbe({ ...options, request: mismatch.request })(
        new globalThis.AbortController().signal
      ),
      false
    );
    assert.equal(mismatch.destroyed(), 1);
  }
});

test('network, authentication, malformed, oversized, truncated and timeout failures never report readiness', async () => {
  for (const mode of [
    { error: true },
    { timedOut: true },
    { status: 401 },
    { status: 500 },
    { body: '' },
    { body: '{invalid' },
    { body: 'x'.repeat(4097) },
    { partial: true },
    { invalidChunk: true },
  ]) {
    const t = transport(mode);
    assert.equal(
      await createProxyFixtureHealthProbe({ ...options, request: t.request })(
        new globalThis.AbortController().signal
      ),
      false
    );
    assert.ok(t.destroyed() >= 1);
  }
  const throwing = createProxyFixtureHealthProbe({
    ...options,
    request() {
      throw new Error('PRIVATE_FACTORY');
    },
  });
  await assert.rejects(throwing(new globalThis.AbortController().signal), {
    message: 'Fixture health probe failed',
  });
});

test('invalid/extreme/accessor/prototype options and cancelled signals cannot initiate a probe', async () => {
  for (const value of [
    null,
    [],
    Object.create(options),
    { ...options, extra: true },
    { ...options, port: 0 },
    { ...options, port: 65536 },
    { ...options, port: '23001' },
    { ...options, pid: 0 },
    { ...options, pid: Infinity },
    { ...options, token: '' },
    { ...options, token: 'x'.repeat(4097) },
    { ...options, token: 'SECRET\n' },
    { ...options, request: 1 },
  ])
    assert.throws(() => createProxyFixtureHealthProbe(value), {
      message: 'Invalid fixture health probe input',
    });
  let accessed = false;
  const getter = Object.defineProperty({}, 'token', {
    enumerable: true,
    get() {
      accessed = true;
      return 'SECRET';
    },
  });
  assert.throws(() => createProxyFixtureHealthProbe(getter));
  assert.equal(accessed, false);
  const probe = createProxyFixtureHealthProbe({
    ...options,
    request() {
      throw new Error('Must not dispatch');
    },
  });
  const controller = new globalThis.AbortController();
  controller.abort();
  assert.equal(await probe(controller.signal), false);
  await assert.rejects(probe({}), { message: 'Invalid fixture health probe signal' });
});

test('abort explicitly cancels an in-flight request even when an injected transport ignores signal', async () => {
  const controller = new globalThis.AbortController();
  let destroyed = 0;
  const probe = createProxyFixtureHealthProbe({
    ...options,
    request() {
      const req = new EventEmitter();
      req.destroy = () => {
        destroyed++;
      };
      req.setTimeout = () => {};
      req.end = () => {};
      return req;
    },
  });
  const pending = probe(controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(destroyed, 1);
});

function readiness(probeReady) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const timers = new Map(),
    cleared = [];
  let id = 0;
  const promise = waitForProxyFixtureReady(child, {
    probeReady,
    setTimer(callback, delay) {
      timers.set(++id, { callback, delay });
      return id;
    },
    clearTimer(timer) {
      cleared.push(timer);
      timers.delete(timer);
    },
  });
  return {
    child,
    timers,
    cleared,
    outcome: promise.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    ),
  };
}

test('health readiness does not trust log markers and can succeed with no stdout within the original deadline', async () => {
  let ready = false,
    signal;
  const f = readiness(async (value) => {
    signal = value;
    return ready;
  });
  await tick();
  f.child.stdout.emit('data', 'Mgmt: this is not proof');
  assert.equal(f.timers.get(1).delay, 15000);
  const retry = [...f.timers.values()].find((timer) => timer.delay === 100);
  assert.ok(retry);
  ready = true;
  retry.callback();
  assert.equal((await f.outcome).ok, true);
  assert.equal(signal.aborted, true);
  assert.equal(f.child.stdout.listenerCount('data'), 0);
  assert.equal(f.child.listenerCount('exit'), 0);
  assert.equal(f.timers.size, 0);
  const quiet = readiness(async () => true);
  assert.equal((await quiet.outcome).ok, true);
});

test('deadlines, child exit, rejection and invalid probe results abort work and cannot accept late success', async () => {
  for (const action of ['deadline', 'exit']) {
    let release, signal;
    const f = readiness((value) => {
      signal = value;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await tick();
    if (action === 'deadline') f.timers.get(1).callback();
    else f.child.emit('exit', 1);
    const result = await f.outcome;
    assert.equal(result.ok, false);
    assert.equal(signal.aborted, true);
    assert.equal(f.timers.size, 0);
    release(true);
    await tick();
    assert.equal(f.child.listenerCount('error'), 0);
    assert.equal(f.child.stdout.listenerCount('data'), 0);
  }
  const throwing = readiness(() => {
    throw new Error('SECRET_PROVIDER');
  });
  assert.equal((await throwing.outcome).error.message, 'Fixture readiness probe failed');
  const invalid = readiness(async () => ({}));
  assert.equal((await invalid.outcome).error.message, 'Invalid fixture readiness probe result');
});
