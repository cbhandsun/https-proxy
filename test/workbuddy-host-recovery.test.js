'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const {
  createWorkBuddyHostRecovery,
  startWorkBuddyHost,
  isWorkBuddyHostUnavailable,
} = require('../lib/proxy/workbuddy-host-recovery');
const { createWorkBuddyWbipcClient } = require('../lib/proxy/workbuddy-wbipc-client');
const { FakeWbipcSocket } = require('./helpers/workbuddy-wbipc-socket');
const { getWorkBuddyExecutablePath } = require('../lib/proxy/workbuddy-official');

const endpoint = '\\\\.\\pipe\\wbipc-recovery-test';
const ticket = 'fixture-ticket-not-a-secret';
const params = { method: 'POST', path: '/v2/chat/completions', body: '{"private":"CONTENT"}' };
function fixture(options = {}) {
  let available = options.available ?? false;
  let launches = 0;
  let fetches = 0;
  let connections = 0;
  const recovery = createWorkBuddyHostRecovery({
    timeoutMs: 150,
    intervalMs: 10,
    cooldownMs: 1000,
    async startHost() {
      launches++;
      if (options.startHost)
        return options.startHost(() => {
          available = true;
        });
      available = true;
      return { status: 'started' };
    },
    ...options.recoveryOptions,
  });
  const makeClient = () =>
    createWorkBuddyWbipcClient({
      hostRecovery: recovery,
      timeoutMs: 100,
      readEndpoint: () => (available ? { endpoint, ticket } : null),
      connect() {
        connections++;
        if (options.stale && connections === 1) throw new Error('SECRET connection failure');
        const socket = new FakeWbipcSocket(ticket, endpoint, () => {
          fetches++;
        });
        const handle = socket.handleFrame.bind(socket);
        socket.handleFrame = (frame) => {
          if (options.afterDispatch && frame.method === 'c:wb.request/http.fetch') {
            fetches++;
            if (options.afterDispatch === 'close') process.nextTick(() => socket.destroy());
            if (options.afterDispatch === 'error')
              process.nextTick(() => socket.emit('error', new Error('fixture')));
            return;
          }
          if (options.methodUnavailable && frame.method === 'broker/GetPipe') {
            socket.send({ id: frame.id, result: { channel: '', methods: [] } });
            return;
          }
          handle(frame);
        };
        const send = socket.send.bind(socket);
        socket.send = (frame) => {
          if (options.untrusted && frame.type === 'session_challenge')
            frame.server_proof = 'invalid';
          if (options.httpStatus && frame.result?.body_b64)
            frame.result.status = options.httpStatus;
          send(frame);
        };
        return socket;
      },
    });
  return { makeClient, counts: () => ({ launches, fetches, connections }) };
}

test('missing discovery automatically starts host, proves readiness without fetch, then sends once', async () => {
  const f = fixture();
  const result = await f.makeClient().request(params);
  assert.equal(result.status, 200);
  assert.deepEqual(f.counts(), { launches: 1, connections: 2, fetches: 1 });
});

test('already ready host needs no launch or extra probe', async () => {
  const f = fixture({ available: true });
  assert.equal((await f.makeClient().request(params)).status, 200);
  assert.deepEqual(f.counts(), { launches: 0, connections: 1, fetches: 1 });
});

test('different client instances share one launch; each original request is sent once', async () => {
  let release;
  const f = fixture({
    startHost: (ready) =>
      new Promise((resolve) => {
        release = () => {
          ready();
          resolve({ status: 'started' });
        };
      }),
  });
  const a = f.makeClient().request(params);
  const b = f.makeClient().request(params);
  await nextTurn();
  assert.equal(f.counts().launches, 1);
  release();
  const results = await Promise.all([a, b]);
  assert.ok(results.every((r) => r.status === 200));
  assert.deepEqual(f.counts(), { launches: 1, connections: 3, fetches: 2 });
});

test('discovery and pipe can become ready after launch instead of requiring a new token', async () => {
  let probes = 0;
  const recovery = createWorkBuddyHostRecovery({
    startHost: async () => ({ status: 'already_running' }),
    timeoutMs: 200,
    intervalMs: 10,
  });
  assert.equal(
    await recovery.ensureReady(async () => (++probes < 3 ? 'method_unavailable' : 'ready')),
    'ready'
  );
  assert.equal(probes, 3);
});

test('a late concurrent request joins recovery while discovery exists but pipe publication is pending', async () => {
  const options = { methodUnavailable: true };
  const f = fixture(options);
  const first = f.makeClient().request(params);
  await nextTurn();
  const second = f.makeClient().request(params);
  await nextTurn();
  options.methodUnavailable = false;
  const results = await Promise.all([first, second]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(f.counts().launches, 1);
  assert.equal(f.counts().fetches, 2);
});

test('stale discovery connection error before dispatch can recover once', async () => {
  const f = fixture({ available: true, stale: true });
  assert.equal((await f.makeClient().request(params)).status, 200);
  assert.deepEqual(f.counts(), { launches: 1, connections: 3, fetches: 1 });
});

test('close, error and timeout after dispatch never launch or resend', async () => {
  for (const afterDispatch of ['close', 'error', 'timeout']) {
    const f = fixture({ available: true, afterDispatch });
    const result = await f.makeClient().request(params);
    assert.equal(result.ok, false);
    assert.equal(
      result.status,
      { close: 'connection_closed', error: 'connection_error', timeout: 'timeout' }[afterDispatch]
    );
    assert.deepEqual(f.counts(), { launches: 0, connections: 1, fetches: 1 });
  }
});

test('untrusted endpoint, unsupported pipe and actual upstream 401 do not launch', async () => {
  for (const [options, status] of [
    [{ untrusted: true }, 'endpoint_untrusted'],
    [{ methodUnavailable: true }, 'method_unavailable'],
    [{ httpStatus: 401 }, 401],
  ]) {
    const f = fixture({ available: true, ...options });
    assert.equal((await f.makeClient().request(params)).status, status);
    assert.equal(f.counts().launches, 0);
  }
});

test('invalid inputs cannot start host or send credentials', async () => {
  for (const invalid of [
    null,
    {},
    { path: '//evil.test' },
    { path: '/a/../b' },
    { path: '/a\nb' },
    { path: '/a', headers: { authorization: 'SECRET' } },
    { path: '/a', headers: [] },
  ]) {
    const f = fixture();
    const result = await f.makeClient().request(invalid);
    assert.equal(result.status, 'request_failed');
    assert.deepEqual(f.counts(), { launches: 0, connections: 0, fetches: 0 });
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('launch failure is sanitized and cooldown prevents repeated launches', async () => {
  const f = fixture({
    startHost: async () => {
      throw new Error('SECRET CONTENT');
    },
  });
  assert.deepEqual(await f.makeClient().request(params), {
    ok: false,
    status: 'host_start_failed',
  });
  assert.deepEqual(await f.makeClient().request(params), {
    ok: false,
    status: 'host_recovery_cooldown',
  });
  assert.equal(f.counts().launches, 1);
});

test('bounded timeout applies even when launcher or probe never resolves', async () => {
  for (const hanging of ['start', 'probe']) {
    const recovery = createWorkBuddyHostRecovery({
      timeoutMs: 100,
      startHost: () => (hanging === 'start' ? new Promise(() => {}) : { status: 'started' }),
    });
    assert.equal(await recovery.ensureReady(() => new Promise(() => {})), 'host_recovery_timeout');
    assert.equal(await recovery.ensureReady(() => 'ready'), 'host_recovery_cooldown');
  }
});

test('one cancelled waiter does not cancel another; pre-aborted requests never launch', async () => {
  let release;
  const f = fixture({
    startHost: (ready) =>
      new Promise((resolve) => {
        release = () => {
          ready();
          resolve({ status: 'started' });
        };
      }),
  });
  const controller = new globalThis.AbortController();
  const a = f.makeClient().request(params, { signal: controller.signal });
  const b = f.makeClient().request(params);
  await nextTurn();
  controller.abort();
  assert.equal((await a).status, 'cancelled');
  release();
  assert.equal((await b).status, 200);
  assert.deepEqual(f.counts(), { launches: 1, connections: 2, fetches: 1 });
  assert.equal(
    (await f.makeClient().request(params, { signal: controller.signal })).status,
    'cancelled'
  );
});

test('cooldown expires and successful recovery leaves no cooldown', async () => {
  let launches = 0;
  const recovery = createWorkBuddyHostRecovery({
    cooldownMs: 0,
    startHost: () => ({ status: ++launches === 1 ? 'missing_executable' : 'started' }),
  });
  assert.equal(await recovery.ensureReady(() => 'ready'), 'host_start_failed');
  assert.equal(await recovery.ensureReady(() => 'ready'), 'ready');
  assert.equal(await recovery.ensureReady(() => 'ready'), 'ready');
  assert.equal(launches, 3);
});

test('cancelling all waiters aborts shared work, releases the flight and does not impose cooldown', async () => {
  let launches = 0;
  let sharedSignal;
  const recovery = createWorkBuddyHostRecovery({
    startHost: ({ signal }) => {
      sharedSignal = signal;
      launches++;
      return { status: 'started' };
    },
  });
  const controller = new globalThis.AbortController();
  const pending = recovery.ensureReady(() => new Promise(() => {}), controller.signal);
  await nextTurn();
  controller.abort();
  assert.equal(await pending, 'cancelled');
  assert.equal(sharedSignal.aborted, true);
  assert.equal(await recovery.ensureReady(() => 'ready'), 'ready');
  assert.equal(launches, 2);
});

test('recovery aborts probe and returns no authentication or content details', async () => {
  let probeSignal;
  const recovery = createWorkBuddyHostRecovery({
    timeoutMs: 100,
    startHost: () => ({ status: 'started' }),
  });
  const result = await recovery.ensureReady((signal) => {
    probeSignal = signal;
    return new Promise(() => {});
  });
  assert.equal(result, 'host_recovery_timeout');
  assert.equal(probeSignal.aborted, true);
  for (const status of [
    'not_available',
    'method_unavailable',
    'host_start_failed',
    'host_recovery_timeout',
    'host_recovery_cooldown',
  ])
    assert.equal(isWorkBuddyHostUnavailable(status), true);
  for (const status of [401, 'endpoint_untrusted', undefined])
    assert.equal(isWorkBuddyHostUnavailable(status), false);
});

test('launcher handles missing executable, synchronous failure, async failure, success and cancellation', async () => {
  assert.deepEqual(await startWorkBuddyHost({ exists: () => false }), {
    status: 'missing_executable',
  });
  assert.deepEqual(
    await startWorkBuddyHost({
      exists: () => true,
      spawn: () => {
        throw new Error('SECRET');
      },
    }),
    { status: 'start_failed' }
  );
  for (const outcome of ['spawn', 'error']) {
    const child = new EventEmitter();
    let unref = 0;
    child.unref = () => {
      unref++;
    };
    const result = startWorkBuddyHost({
      exists: () => true,
      spawn: (_exe, args, options) => {
        assert.deepEqual(args, []);
        assert.deepEqual(options, { detached: true, stdio: 'ignore', windowsHide: true });
        process.nextTick(() => child.emit(outcome, new Error('SECRET')));
        return child;
      },
    });
    assert.deepEqual(await result, { status: outcome === 'spawn' ? 'started' : 'start_failed' });
    assert.equal(unref, outcome === 'spawn' ? 1 : 0);
    child.emit('error', new Error('late failure must remain handled'));
  }
  const controller = new globalThis.AbortController();
  controller.abort();
  assert.deepEqual(
    await startWorkBuddyHost({
      signal: controller.signal,
      spawn: () => assert.fail('must not launch'),
    }),
    { status: 'cancelled' }
  );
});

test('executable discovery supports renamed installer folder and older executable without arbitrary paths', () => {
  const localAppData = path.resolve('fixture-local-appdata');
  const candidates = [
    path.join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(localAppData, 'Programs', 'WorkBuddyAI', 'WorkBuddy.exe'),
    path.join(localAppData, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
  ];
  for (const candidate of candidates)
    assert.equal(
      getWorkBuddyExecutablePath({ localAppData, exists: (p) => p === candidate }),
      candidate
    );
  assert.equal(getWorkBuddyExecutablePath({ localAppData, exists: () => true }), candidates[0]);
  assert.equal(getWorkBuddyExecutablePath({ localAppData, exists: () => false }), candidates[0]);
});

test('extreme and malformed recovery options are bounded without coercing objects', async () => {
  for (const value of [NaN, Infinity, -1, 1e20, '', 'invalid', null, {}, Symbol('invalid')]) {
    const recovery = createWorkBuddyHostRecovery({
      timeoutMs: value,
      intervalMs: value,
      cooldownMs: value,
      startHost: () => ({ status: 'started' }),
    });
    assert.equal(await recovery.ensureReady(() => 'ready'), 'ready');
  }
});
