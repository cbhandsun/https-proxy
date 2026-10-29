'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  waitForRejectedStorage,
} = require('../../scripts/context-hosted/n09-backup/rejected-storage');
const safe = (error) => error?.message === 'n09_restored_storage_not_rejected';
const health = (change = {}) => ({
  status: 200,
  body: {
    pid: 101,
    contextRecovery: {
      configValid: true,
      requestedEnabled: true,
      appliedEnabled: false,
      state: 'unavailable',
      storage: 'persistent',
      ...change,
    },
  },
});
function fixture(read) {
  let now = 0,
    reads = 0,
    alive = 0,
    sleeps = 0;
  return {
    run: () =>
      waitForRejectedStorage(
        async () => {
          reads++;
          return read(reads);
        },
        async () => {
          alive++;
          return true;
        },
        101,
        15000,
        {
          now: () => now,
          sleep: async (ms) => {
            sleeps++;
            now += ms;
          },
        }
      ),
    counts: () => ({ reads, alive, sleeps }),
  };
}

test('rollback requires explicit unavailable storage on a live same-PID daemon', async () => {
  const f = fixture(() => health());
  assert.equal(await f.run(), true);
  assert.deepEqual(f.counts(), { reads: 1, alive: 1, sleeps: 0 });
  const pending = fixture((count) =>
    health(
      count === 1
        ? {
            state: 'pending_application',
            appliedEnabled: null,
            storage: 'memory',
          }
        : {}
    )
  );
  assert.equal(await pending.run(), true);
  assert.deepEqual(pending.counts(), { reads: 2, alive: 2, sleeps: 1 });
});

test('successful old storage, disabled enhancement and malformed health never qualify', async () => {
  for (const change of [
    { state: 'enabled_restricted', appliedEnabled: true },
    { state: 'disabled', requestedEnabled: false },
    { configValid: false },
    { requestedEnabled: false },
    { storage: 'memory' },
    { appliedEnabled: true },
    { appliedEnabled: null },
    { state: 'failed' },
    { state: undefined },
  ])
    await assert.rejects(fixture(() => health(change)).run(), safe);
  for (const value of [
    null,
    [],
    {},
    { ...health(), status: 503 },
    { status: 200, body: { ...health().body, pid: 102 } },
  ])
    await assert.rejects(fixture(() => value).run(), safe);
});

test('dead owner, transport errors and deadline expiry cannot masquerade as rejection', async () => {
  await assert.rejects(
    waitForRejectedStorage(
      async () => health(),
      async () => false,
      101,
      15000,
      { now: () => 0 }
    ),
    safe
  );
  await assert.rejects(
    fixture(() => {
      throw new Error('PRIVATE_TRANSPORT_SENTINEL');
    }).run(),
    safe
  );
  const pending = fixture(() => health({ state: 'pending_application' }));
  await assert.rejects(pending.run(), safe);
  assert.deepEqual(pending.counts(), { reads: 150, alive: 150, sleeps: 150 });
  for (const deadline of [-1, 0, 15001, Infinity, NaN])
    await assert.rejects(
      waitForRejectedStorage(
        async () => health(),
        async () => true,
        101,
        deadline,
        { now: () => 0 }
      ),
      safe
    );
});

test('unsafe accessors, Proxy input and backwards clocks reject without evaluating data', async () => {
  let evaluated = 0;
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        evaluated++;
        return [];
      },
    }
  );
  const getter = Object.defineProperty({}, 'body', {
    get() {
      evaluated++;
      return health().body;
    },
  });
  for (const input of [proxy, getter]) await assert.rejects(fixture(() => input).run(), safe);
  const fn = new Proxy(() => health(), {
    apply() {
      evaluated++;
      return health();
    },
  });
  await assert.rejects(
    waitForRejectedStorage(fn, async () => true, 101, 15000),
    safe
  );
  assert.equal(evaluated, 0);
  let time = 4;
  await assert.rejects(
    waitForRejectedStorage(
      async () => health(),
      async () => true,
      101,
      15000,
      { now: () => time-- }
    ),
    safe
  );
});
