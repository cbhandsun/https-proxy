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
