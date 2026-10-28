'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const {
  createPublicResponseInterruption,
} = require('../../scripts/context-hosted/n09-business/public-response-interruption');
const safe = { message: 'n09_public_response_interruption_failed' };

function fixture(t, methods = {}) {
  let settle;
  const state = { bytes: 0, reason: 'pending', cancelled: 0, upstreamCancelled: 0 };
  const result = new Promise((resolve) => {
    settle = resolve;
  });
  const observer = {
    result,
    bytes: () => state.bytes,
    termination: () => state.reason,
    cancel: () => {
      state.cancelled++;
      if (state.reason === 'pending') {
        state.reason = 'cancelled';
        settle({ failed: true });
      }
      return true;
    },
  };
  Object.assign(observer, methods);
  const hold = createPublicResponseInterruption({}, () => observer);
  t.after(() => hold.close());
  return {
    hold,
    state,
    observer,
    settle: (reason, value = { failed: true }) => {
      state.reason = reason;
      settle(value);
    },
    arrive: () =>
      hold.arrive(() => {
        state.upstreamCancelled++;
        return true;
      }),
  };
}

test('held public response requires a pending request and transport interruption with zero bytes', async (t) => {
  const f = fixture(t);
  f.arrive();
  assert.deepEqual(await f.hold.waitHeld(), { publicResponseHeld: true, publicBytes: 0 });
  f.settle('transport-error');
  assert.deepEqual(await f.hold.afterKill(), { interrupted: true, publicBytes: 0 });
  await assert.rejects(f.hold.afterKill(), safe);
  f.hold.close();
  f.hold.close();
  assert.equal(f.state.cancelled, 1);
  assert.equal(f.state.upstreamCancelled, 1);
});

test('timeouts, cancellation, setup errors, successful replies and output bytes cannot qualify', async (t) => {
  for (const reason of ['timeout', 'cancelled', 'setup-error', 'response']) {
    const f = fixture(t);
    f.arrive();
    await f.hold.waitHeld();
    f.settle(
      reason,
      reason === 'response'
        ? { response: { status: 200, bytes: Buffer.alloc(0) } }
        : { failed: true }
    );
    await assert.rejects(f.hold.afterKill(), safe);
  }
  const before = fixture(t);
  before.state.bytes = 1;
  assert.throws(before.arrive, safe);
  const after = fixture(t);
  after.arrive();
  await after.hold.waitHeld();
  after.state.bytes = 1;
  after.settle('transport-error');
  await assert.rejects(after.hold.afterKill(), safe);
});

test('early completion, duplicate hold, close and arbitrary observer failures reject safely', async (t) => {
  const f = fixture(t);
  f.settle('transport-error');
  await assert.rejects(f.hold.waitHeld(), safe);
  assert.throws(f.arrive, safe);
  const duplicate = fixture(t);
  duplicate.arrive();
  assert.throws(duplicate.arrive, safe);
  const closed = fixture(t);
  closed.hold.close();
  await assert.rejects(closed.hold.waitHeld(), safe);
  assert.throws(closed.arrive, safe);
  const throwing = fixture(t, {
    bytes() {
      throw new Error('PRIVATE_OBSERVER_SENTINEL');
    },
  });
  assert.throws(throwing.arrive, safe);
  const invalid = fixture(t);
  invalid.state.bytes = Number.NaN;
  assert.throws(invalid.arrive, safe);
});

test('invalid observer construction cancels an already started resource and drains safe rejections', async () => {
  for (const change of [
    { bytes: 0 },
    { termination: async () => 'pending' },
    { result: {} },
    { extra: true },
  ]) {
    let cancels = 0;
    const result = Promise.reject(new Error('PRIVATE_RESULT_SENTINEL'));
    const value = {
      result,
      bytes: () => 0,
      termination: () => 'pending',
      cancel() {
        cancels++;
        return Promise.reject(new Error('PRIVATE_CANCEL_SENTINEL'));
      },
      ...change,
    };
    // The replaced promise is owned by this test rather than the returned observer.
    if (value.result !== result) void result.catch(() => {});
    assert.throws(() => createPublicResponseInterruption({}, () => value), safe);
    assert.equal(cancels, 1);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test('construction cleanup does not execute unknown cancel accessors, proxies or generator bodies', () => {
  let traps = 0;
  const trap = () => {
    traps++;
    throw Error('PRIVATE_SENTINEL');
  };
  for (const cancel of [
    new Proxy(() => true, { apply: trap }),
    async () => {
      traps++;
    },
    function* () {
      traps++;
      yield true;
    },
  ]) {
    assert.throws(
      () =>
        createPublicResponseInterruption({}, () => ({
          result: Promise.resolve({}),
          bytes: 0,
          termination: () => 'pending',
          cancel,
        })),
      safe
    );
  }
  assert.throws(
    () =>
      createPublicResponseInterruption({}, () =>
        Object.defineProperty({}, 'cancel', { get: trap })
      ),
    safe
  );
  assert.equal(traps, 0);
});

test('close tries both owned cancellations and remembers a cleanup failure', async () => {
  let first = 0,
    second = 0;
  const hold = createPublicResponseInterruption({}, () => ({
    result: new Promise(() => {}),
    bytes: () => 0,
    termination: () => 'pending',
    cancel() {
      second++;
      return false;
    },
  }));
  hold.arrive(() => {
    first++;
    throw Error('PRIVATE_CANCEL_SENTINEL');
  });
  await hold.waitHeld();
  assert.throws(() => hold.close(), safe);
  assert.throws(() => hold.close(), safe);
  assert.equal(first, 1);
  assert.equal(second, 1);
});

test('malformed and executable observer capabilities are rejected without evaluating accessors', () => {
  let traps = 0;
  const getter = {
    get result() {
      traps++;
      return Promise.resolve({ failed: true });
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        return [];
      },
    }
  );
  for (const value of [
    null,
    {},
    getter,
    proxy,
    { result: Promise.resolve({}), bytes: 0, termination: () => 'pending', cancel: () => true },
  ])
    assert.throws(() => createPublicResponseInterruption({}, () => value), safe);
  for (const start of [null, {}, async () => ({}), new Proxy(() => ({}), {})])
    assert.throws(() => createPublicResponseInterruption({}, start), safe);
  assert.equal(traps, 0);
});

test(
  'real loopback transport reports forced socket interruption and no client response bytes',
  { timeout: 10000 },
  async (t) => {
    const owned = { hold: undefined };
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () =>
        owned.hold.arrive(() => {
          response.destroy();
          return true;
        })
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      owned.hold?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    owned.hold = createPublicResponseInterruption({
      entryPort: server.address().port,
      entryKey: 'a'.repeat(48),
      body: Buffer.from('{}'),
    });
    await owned.hold.waitHeld();
    server.closeAllConnections();
    assert.deepEqual(await owned.hold.afterKill(), { interrupted: true, publicBytes: 0 });
  }
);

test('released upstream keeps zero public bytes until the independent boundary and permits a complete positive reply', async (t) => {
  const f = fixture(t);
  let releases = 0;
  f.hold.arrive(
    () => true,
    () => {
      releases++;
      return true;
    }
  );
  await f.hold.waitHeld();
  assert.deepEqual(f.hold.releaseUpstream(), { upstreamReleased: true, publicBytes: 0 });
  assert.deepEqual(f.hold.assertReleasedPending(), { upstreamReleased: true, publicBytes: 0 });
  assert.throws(() => f.hold.releaseUpstream(), safe);
  const body = Buffer.from('synthetic public');
  f.state.bytes = body.length;
  f.settle('response', { response: { status: 200, bytes: body } });
  assert.deepEqual(await f.hold.afterRelease(), { response: { status: 200, bytes: body } });
  assert.equal(releases, 1);
  await assert.rejects(f.hold.afterKill(), safe);
  await assert.rejects(f.hold.afterRelease(), safe);
});

test('a completed public wire is observed separately from publication completion or an interrupted request', async (t) => {
  for (const kill of [true, false]) {
    const f = fixture(t);
    f.hold.arrive(
      () => true,
      () => true
    );
    await f.hold.waitHeld();
    f.hold.releaseUpstream();
    const body = Buffer.from('public-wire-only');
    f.state.bytes = body.length;
    f.settle('response', { response: { status: 200, bytes: body } });
    assert.deepEqual(await f.hold.observePublished(), { response: { status: 200, bytes: body } });
    if (kill)
      assert.deepEqual(await f.hold.afterPublishedKill(), {
        publicTransportCompleted: true,
        publicBytes: body.length,
      });
    else assert.deepEqual(await f.hold.afterRelease(), { response: { status: 200, bytes: body } });
    await assert.rejects(f.hold.afterKill(), safe);
    await assert.rejects(f.hold.afterPublishedKill(), safe);
  }
});

test('published observation rejects timeouts, malformed wire, stale bytes and content replacement without a retry', async (t) => {
  for (const mode of ['timeout', 'empty', 'oversized', 'status', 'counter', 'changed']) {
    const f = fixture(t);
    f.hold.arrive(
      () => true,
      () => true
    );
    await f.hold.waitHeld();
    f.hold.releaseUpstream();
    if (mode === 'timeout') {
      await assert.rejects(f.hold.observePublished(1), safe);
      await assert.rejects(f.hold.observePublished(), safe);
      continue;
    }
    const body =
      mode === 'empty'
        ? Buffer.alloc(0)
        : mode === 'oversized'
          ? Buffer.alloc(262145)
          : Buffer.from('wire-fact');
    f.state.bytes = body.length + (mode === 'counter' ? 1 : 0);
    f.settle('response', { response: { status: mode === 'status' ? 201 : 200, bytes: body } });
    if (mode === 'changed') {
      await f.hold.observePublished();
      body[0] ^= 1;
      await assert.rejects(f.hold.afterPublishedKill(), safe);
      body[0] ^= 1;
      await assert.rejects(f.hold.afterPublishedKill(), safe);
    } else await assert.rejects(f.hold.observePublished(), safe);
  }
});

test('published observation refuses illegal witness bounds and concurrent completion or closure during callbacks', async (t) => {
  for (const bound of [0, 751, NaN, Infinity, null, {}, '750']) {
    const f = fixture(t);
    await assert.rejects(f.hold.observePublished(bound), safe);
  }
  const pending = fixture(t);
  pending.hold.arrive(
    () => true,
    () => true
  );
  await pending.hold.waitHeld();
  pending.hold.releaseUpstream();
  const observed = assert.rejects(pending.hold.observePublished(), safe);
  await assert.rejects(pending.hold.afterRelease(), safe);
  pending.state.bytes = 1;
  pending.settle('response', { response: { status: 200, bytes: Buffer.from('a') } });
  await observed;
  for (const method of ['observePublished', 'afterRelease']) {
    let closing = false;
    const closed = fixture(t, {
      bytes() {
        if (closing) {
          closed.hold.close();
          return 1;
        }
        return 0;
      },
    });
    closed.hold.arrive(
      () => true,
      () => true
    );
    await closed.hold.waitHeld();
    closed.hold.releaseUpstream();
    closed.state.bytes = 1;
    closed.settle('response', { response: { status: 200, bytes: Buffer.from('a') } });
    closing = true;
    await assert.rejects(closed.hold[method](), safe);
  }
});

test(
  'real loopback release completes the original pending HTTP request with exact response bytes',
  { timeout: 10000 },
  async (t) => {
    const owned = {};
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests++;
      request.resume();
      request.on('end', () =>
        owned.hold.arrive(
          () => {
            response.destroy();
            return true;
          },
          () => {
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            response.end('public-release-control');
            return true;
          }
        )
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      owned.hold?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const hold = (owned.hold = createPublicResponseInterruption({
      entryPort: server.address().port,
      entryKey: 'a'.repeat(48),
      body: Buffer.from('{}'),
    }));
    assert.deepEqual(await hold.waitHeld(), { publicResponseHeld: true, publicBytes: 0 });
    assert.deepEqual(hold.releaseUpstream(), { upstreamReleased: true, publicBytes: 0 });
    const observed = await hold.observePublished();
    assert.equal(observed.response.bytes.toString(), 'public-release-control');
    const result = await hold.afterRelease();
    assert.equal(result.response.status, 200);
    assert.equal(result.response.bytes.toString(), 'public-release-control');
    await assert.rejects(hold.afterRelease(), safe);
    assert.equal(requests, 1);
  }
);

test('release requires one synchronous true and never retries or assimilates another capability', async (t) => {
  let traps = 0;
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      traps++;
      throw Error('PRIVATE');
    },
  });
  for (const value of [false, undefined, thenable, Promise.reject(Error('PRIVATE'))]) {
    const f = fixture(t);
    let calls = 0;
    f.hold.arrive(
      () => true,
      () => {
        calls++;
        return value;
      }
    );
    assert.throws(() => f.hold.releaseUpstream(), safe);
    assert.throws(() => f.hold.releaseUpstream(), safe);
    f.settle('transport-error');
    await assert.rejects(f.hold.afterKill(), safe);
    assert.equal(calls, 1);
  }
  const invalid = [
    new Proxy(() => true, {
      apply() {
        traps++;
        throw Error('PRIVATE');
      },
    }),
    async () => true,
    function* () {
      traps++;
      yield true;
    },
  ];
  for (const release of invalid) {
    const f = fixture(t);
    assert.throws(() => f.hold.arrive(() => true, release), safe);
  }
  assert.equal(traps, 0);
});

test('released interruption still requires an actual transport error and zero client bytes', async (t) => {
  const f = fixture(t);
  f.hold.arrive(
    () => true,
    () => true
  );
  f.hold.releaseUpstream();
  f.settle('transport-error');
  assert.deepEqual(await f.hold.afterKill(), { interrupted: true, publicBytes: 0 });
  for (const reason of ['timeout', 'cancelled']) {
    const denied = fixture(t);
    denied.hold.arrive(
      () => true,
      () => true
    );
    denied.hold.releaseUpstream();
    denied.settle(reason);
    await assert.rejects(denied.hold.afterKill(), safe);
  }
  const leaked = fixture(t);
  leaked.hold.arrive(
    () => true,
    () => true
  );
  leaked.hold.releaseUpstream();
  leaked.state.bytes = 1;
  assert.throws(() => leaked.hold.assertReleasedPending(), safe);
});

test('closing before an already completed result is consumed cannot grant interruption or release success', async (t) => {
  const interrupted = fixture(t);
  interrupted.arrive();
  const failed = assert.rejects(interrupted.hold.afterKill(), safe);
  interrupted.settle('transport-error');
  interrupted.hold.close();
  await failed;
  const released = fixture(t);
  released.hold.arrive(
    () => true,
    () => true
  );
  released.hold.releaseUpstream();
  const finished = assert.rejects(released.hold.afterRelease(), safe);
  released.state.bytes = 1;
  released.settle('response', { response: { status: 200, bytes: Buffer.from('x') } });
  released.hold.close();
  await finished;
});
