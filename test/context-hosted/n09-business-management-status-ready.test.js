'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  waitForPrivatePreload,
} = require('../../scripts/context-hosted/n09-business/management-status-ready.js');
const bad = /^Error: n09_management_status_not_ready$/;
const ready = () => ({ alive: true, credentialsPrivate: true, preloadPhase: 'passed' });
function fixture(statuses, initial = 0) {
  let time = initial,
    reads = 0;
  const sleeps = [];
  return {
    read: async () => statuses[Math.min(reads++, statuses.length - 1)],
    dependencies: {
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    },
    reads: () => reads,
    sleeps,
  };
}
test('private preload readiness accepts immediate ready and cold ordered startup', async () => {
  for (const statuses of [
    [ready()],
    [
      { ...ready(), preloadPhase: 'unobserved', credentialsPrivate: false },
      { ...ready(), preloadPhase: 'entered', credentialsPrivate: false },
      { ...ready(), credentialsPrivate: false },
      ready(),
    ],
  ]) {
    const f = fixture(statuses);
    await waitForPrivatePreload(f.read, 15000, f.dependencies);
    assert.equal(f.reads(), statuses.length);
    assert.deepEqual(f.sleeps, Array(statuses.length - 1).fill(50));
  }
});
test('private preload readiness rejects exited, failed, malformed and executable metadata immediately', async () => {
  let traps = 0;
  for (const value of [
    null,
    {},
    [],
    { ...ready(), alive: false },
    { ...ready(), alive: 1 },
    { ...ready(), credentialsPrivate: 'true' },
    { ...ready(), preloadPhase: 'failed' },
    { ...ready(), preloadPhase: 'unknown' },
    { ...ready(), extra: true },
    {
      get alive() {
        traps++;
        return true;
      },
    },
    new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          return [];
        },
      }
    ),
  ]) {
    const f = fixture([value]);
    await assert.rejects(waitForPrivatePreload(f.read, 15000, f.dependencies), bad);
    assert.equal(f.reads(), 1);
    assert.equal(f.sleeps.length, 0);
  }
  assert.equal(traps, 0);
});
test('private preload readiness retains original finite deadline and bounded polls', async () => {
  const f = fixture([{ ...ready(), credentialsPrivate: false }]);
  await assert.rejects(waitForPrivatePreload(f.read, 125, f.dependencies), bad);
  assert.equal(f.reads(), 3);
  assert.deepEqual(f.sleeps, [50, 50, 25]);
  const frozen = fixture([{ ...ready(), preloadPhase: 'entered' }]);
  frozen.dependencies.sleep = async () => {};
  await assert.rejects(waitForPrivatePreload(frozen.read, 15000, frozen.dependencies), bad);
  assert.equal(frozen.reads(), 300);
});
test('private preload readiness rejects late success and backward or invalid clocks', async () => {
  for (const end of [15000, -1, NaN, Infinity]) {
    let time = 0;
    await assert.rejects(
      waitForPrivatePreload(
        async () => {
          time = end;
          return ready();
        },
        15000,
        { now: () => time, sleep: async () => {} }
      ),
      bad
    );
  }
  for (const deadline of [0, -1, NaN, Infinity, 15001, '15000', null]) {
    const f = fixture([ready()]);
    await assert.rejects(waitForPrivatePreload(f.read, deadline, f.dependencies), bad);
    assert.equal(f.reads(), 0);
  }
});
test('private preload readiness sanitizes status, clock and sleep failures', async () => {
  const sensitive = () => {
    throw new Error('PRIVATE_READY_SENTINEL');
  };
  await assert.rejects(waitForPrivatePreload(sensitive, 15000, { now: () => 0 }), bad);
  await assert.rejects(
    waitForPrivatePreload(async () => ready(), 15000, { now: sensitive }),
    bad
  );
  await assert.rejects(
    waitForPrivatePreload(async () => ({ ...ready(), credentialsPrivate: false }), 15000, {
      now: () => 0,
      sleep: sensitive,
    }),
    bad
  );
});
test('private preload readiness rejects invalid dependency shapes and callables without proxy traps', async () => {
  let traps = 0;
  const proxy = new Proxy(() => {}, {
    get() {
      traps++;
      throw new Error('private');
    },
  });
  for (const dependencies of [
    null,
    [],
    { extra: () => {} },
    { now: null },
    { sleep: 0 },
    { now: proxy },
    {
      get now() {
        traps++;
        return () => 0;
      },
    },
  ]) {
    await assert.rejects(
      waitForPrivatePreload(async () => ready(), 15000, dependencies),
      bad
    );
  }
  await assert.rejects(waitForPrivatePreload(proxy, 15000), bad);
  assert.equal(traps, 0);
});
