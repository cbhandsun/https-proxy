'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STORAGE_TTL_MS: TTL } = require('../lib/proxy/context-recovery-storage-contract');
const {
  createCapacityRetentionWitness,
} = require('../scripts/lib/context-recovery-capacity-retention');
const safe = (error) =>
  error.message === 'capacity_retention_witness_failed' && error.cause === undefined;
const scope = 'a'.repeat(64);
const entry = (overrides = {}) => ({
  scope,
  revision: 1,
  createdAt: 1001,
  expiresAt: 1000 + TTL,
  ...overrides,
});
function fixture(overrides = {}) {
  let wall = 1000,
    mono = 50;
  const sleeps = [];
  const options = {
    now: () => wall,
    monotonic: () => mono,
    sleep: async (duration) => {
      sleeps.push(duration);
      wall += duration;
      mono += duration;
    },
    ...overrides,
  };
  const witness = createCapacityRetentionWitness(options);
  return {
    witness,
    sleeps,
    set(w, m) {
      wall = w;
      mono = m;
    },
    get mono() {
      return mono;
    },
  };
}
function storage(overrides = {}) {
  const calls = [];
  return {
    calls,
    execute(request) {
      calls.push(request);
      if (Object.hasOwn(overrides, request.operation)) return overrides[request.operation];
      if (request.operation === 'catalog') return [];
      if (request.operation === 'inspect') return { records: 0, bytes: 0 };
      return null;
    },
  };
}

test('numeric witness preserves expiry and revisions, waits TTL, and verifies two expired reopenings', async () => {
  const f = fixture();
  assert.equal(f.witness.now(), 1000);
  assert.deepEqual(f.witness.observeCatalog([entry()]), {
    roots: 1,
    minRootExpiresAt: 1000 + TTL,
    maxRootExpiresAt: 1000 + TTL,
  });
  f.witness.observeCatalog([entry({ revision: 4 })]);
  await f.witness.waitForExpiry();
  assert.equal(f.mono, 50 + TTL);
  assert.equal(f.sleeps.length, TTL / 60000);
  assert.ok(f.sleeps.every((duration) => duration > 0 && duration <= 60000));
  for (let i = 0; i < 2; i++) {
    const reopened = storage();
    assert.deepEqual(await f.witness.assertExpired(reopened), { roots: 1, expired: true });
    assert.deepEqual(
      reopened.calls.map((call) => call.operation),
      ['catalog', 'load', 'load-reference', 'inspect']
    );
  }
});

test('wall jump forward cannot skip monotonic TTL; repeated wall milliseconds use latest sample', async () => {
  const f = fixture();
  f.witness.now();
  f.set(1000, 100);
  f.witness.now();
  f.witness.observeCatalog([entry()]);
  f.set(1000 + TTL * 2, 101);
  await f.witness.waitForExpiry();
  assert.ok(f.mono >= 100 + TTL);
  assert.ok(f.sleeps.length > 1000);
});

test('all roots must have witnessed births and retain exact scopes, createdAt and expiry', () => {
  const f = fixture({ roots: 2 });
  f.witness.now();
  const second = entry({ scope: 'b'.repeat(64) });
  assert.equal(f.witness.observeCatalog([entry(), second]).roots, 2);
  f.witness.observeCatalog([entry({ revision: 3 }), { ...second, revision: 2 }]);
  for (const bad of [
    [],
    [entry()],
    [entry({ revision: 0 }), second],
    [entry({ expiresAt: 1000 + TTL - 1 }), second],
    [entry({ createdAt: 1002 }), second],
    [entry({ revision: 2 }), second],
    [entry(), entry({ scope: 'c'.repeat(64) })],
  ]) {
    const g = fixture({ roots: 2 });
    g.witness.now();
    g.witness.observeCatalog([entry({ revision: 3 }), { ...second, revision: 2 }]);
    assert.throws(() => g.witness.observeCatalog(bad), safe);
    assert.throws(() => g.witness.now(), safe);
  }
});

test('empty, missing birth, expired and malformed catalogs fail permanently without reading getters', () => {
  let touched = 0;
  const hostile = Object.defineProperty({}, 'scope', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  for (const input of [
    null,
    [],
    [hostile],
    [entry({ expiresAt: 1001 + TTL })],
    [entry({ private: 'PRIVATE' })],
  ]) {
    const f = fixture();
    f.witness.now();
    assert.throws(() => f.witness.observeCatalog(input), safe);
    assert.throws(() => f.witness.now(), safe);
  }
  assert.equal(touched, 0);
  const f = fixture();
  f.witness.now();
  f.set(1000 + TTL, TTL + 50);
  assert.throws(() => f.witness.observeCatalog([entry()]), safe);
});

test('invalid configuration and unsafe numeric clocks are rejected', () => {
  let touched = 0;
  const hostile = Object.defineProperty({}, 'now', {
    enumerable: true,
    get() {
      touched++;
      return Date.now;
    },
  });
  for (const options of [
    null,
    [],
    new Proxy({}, {}),
    hostile,
    { roots: 0 },
    { roots: 5 },
    { roots: Infinity },
    { extra: true },
    { now: async () => 1 },
    { monotonic: null },
    { sleep: function* () {} },
    { sleep: new Proxy(() => {}, {}) },
  ])
    assert.throws(() => createCapacityRetentionWitness(options), safe);
  assert.equal(touched, 0);
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER, 1.5]) {
    const f = fixture({ now: () => value });
    assert.throws(() => f.witness.now(), safe);
  }
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const f = fixture({ monotonic: () => value });
    assert.throws(() => f.witness.now(), safe);
  }
});

test('sample bound is exact and same-millisecond calls cannot evade it', () => {
  const f = fixture();
  for (let i = 0; i < 32768; i++) f.witness.now();
  assert.throws(() => f.witness.now(), safe);
  assert.throws(() => f.witness.observeCatalog([entry()]), safe);
});

test('wall or monotonic regression and broken sleeps fail permanently', async () => {
  for (const [wall, mono] of [
    [999, 51],
    [1000, 49],
  ]) {
    const f = fixture();
    f.witness.now();
    f.set(wall, mono);
    assert.throws(() => f.witness.now(), safe);
  }
  for (const sleep of [
    () => undefined,
    async () => {},
    async () => true,
    async () => {
      throw Error('PRIVATE');
    },
    () => ({
      then() {
        throw Error('PRIVATE');
      },
    }),
  ]) {
    const f = fixture({ sleep });
    f.witness.now();
    f.witness.observeCatalog([entry()]);
    await assert.rejects(f.witness.waitForExpiry(), safe);
    assert.throws(() => f.witness.now(), safe);
  }
});

test('missing witness, premature assertion, overlapping waits and repeated wait fail closed', async () => {
  const empty = fixture();
  await assert.rejects(empty.witness.waitForExpiry(), safe);
  const premature = fixture();
  premature.witness.now();
  premature.witness.observeCatalog([entry()]);
  await assert.rejects(premature.witness.assertExpired(storage()), safe);
  let release;
  const f = fixture({
    sleep: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  f.witness.now();
  f.witness.observeCatalog([entry()]);
  const first = f.witness.waitForExpiry();
  await assert.rejects(f.witness.waitForExpiry(), safe);
  release();
  await assert.rejects(first, safe);
  const g = fixture();
  g.witness.now();
  g.witness.observeCatalog([entry()]);
  await g.witness.waitForExpiry();
  await assert.rejects(g.witness.waitForExpiry(), safe);
});

test('expired assertions reject resurrection, malformed metadata, exceptions and hostile storage', async () => {
  let touched = 0;
  const hostile = Object.defineProperty({}, 'execute', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  for (const candidate of [
    null,
    hostile,
    new Proxy({}, {}),
    storage({ catalog: [entry()] }),
    storage({ load: {} }),
    storage({ 'load-reference': {} }),
    storage({ inspect: { records: 1, bytes: 1 } }),
    storage({ inspect: { records: 0, bytes: 0, private: 'PRIVATE' } }),
    storage({ catalog: thenable }),
    {
      execute() {
        throw Error('PRIVATE');
      },
    },
    {
      execute: async () => {
        throw Error('PRIVATE');
      },
    },
  ]) {
    const f = fixture();
    f.witness.now();
    f.witness.observeCatalog([entry()]);
    await f.witness.waitForExpiry();
    await assert.rejects(f.witness.assertExpired(candidate), safe);
    assert.throws(() => f.witness.now(), safe);
  }
  assert.equal(touched, 0);
});

test('aggregate inspection exposes no scope and asynchronous storage replies are supported', async () => {
  const f = fixture();
  assert.deepEqual(f.witness.inspect(), {
    rootsObserved: 0,
    minRootExpiresAt: null,
    maxRootExpiresAt: null,
    expiryWaitCompleted: false,
  });
  f.witness.now();
  f.witness.observeCatalog([entry()]);
  await f.witness.waitForExpiry();
  const backing = storage();
  await f.witness.assertExpired({ execute: async (request) => backing.execute(request) });
  assert.deepEqual(f.witness.inspect(), {
    rootsObserved: 1,
    minRootExpiresAt: 1000 + TTL,
    maxRootExpiresAt: 1000 + TTL,
    expiryWaitCompleted: true,
  });
  assert.ok(!JSON.stringify(f.witness.inspect()).includes(scope));
});

test('latest observed root birth controls the monotonic deadline and late wall arrival is required', async () => {
  let wall = 1000,
    mono = 0;
  const sleeps = [];
  const witness = createCapacityRetentionWitness({
    roots: 2,
    now: () => wall,
    monotonic: () => mono,
    sleep: async (duration) => {
      sleeps.push(duration);
      mono += duration;
      wall += Math.max(1, Math.floor(duration / 2));
    },
  });
  witness.now();
  wall = 2000;
  mono = 1000;
  witness.now();
  witness.observeCatalog([
    entry(),
    entry({ scope: 'b'.repeat(64), createdAt: 2001, expiresAt: 2000 + TTL }),
  ]);
  await witness.waitForExpiry();
  assert.ok(mono >= 1000 + TTL);
  assert.ok(wall >= 2000 + TTL);
  assert.ok(sleeps.every((duration) => duration <= 60000));
});

test('hostile inspect fields are rejected without accessing their values', async () => {
  let touched = 0;
  const result = Object.defineProperty({ records: 0 }, 'bytes', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const f = fixture();
  f.witness.now();
  f.witness.observeCatalog([entry()]);
  await f.witness.waitForExpiry();
  await assert.rejects(f.witness.assertExpired(storage({ inspect: result })), safe);
  assert.equal(touched, 0);
});
