'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPublicationAckBoundary,
} = require('../../scripts/context-hosted/n09-business/publication-ack-boundary');
const safe = { message: 'n09_publication_ack_boundary_failed' };
const base = {
  generation: 1,
  callOrdinal: 2,
  rootId: 'hbs_' + 'a'.repeat(32),
  expiresAt: 86400100,
  expectedRevision: 3,
  transition: 'prepared',
};
function fixture(overrides = {}) {
  let time = 0,
    polls = 0;
  const receipts = [];
  const observed = {
    ...base,
    callOrdinal: 3,
    activeCount: 0,
    operation: 'save-reference-state',
    status: 'completed',
  };
  const config = {
    inspect: () => observed,
    publish: (value) => {
      receipts.push(value);
    },
    released: () => ++polls >= 3,
    sleep: (ms) => {
      time += ms;
    },
    now: () => time,
    ...overrides,
  };
  const boundary = createPublicationAckBoundary(config);
  const facts = { rootId: base.rootId, expiresAt: base.expiresAt, revision: 4 };
  return { boundary, config, observed, receipts, facts, time: () => time };
}

test('all five transitions hold only their exact completed store revision and release the original path', () => {
  for (const transition of [
    'prepared',
    'sending',
    'transport-finished',
    'uncertain',
    'withdrawn',
  ]) {
    const f = fixture();
    f.observed.transition = transition;
    assert.equal(f.boundary.afterDurableAck(null), undefined);
    f.boundary.arm({ ...base, transition });
    assert.equal(f.boundary.afterDurableAck(f.facts), undefined);
    assert.equal(f.time(), 20);
    assert.equal(f.receipts.length, 1);
    assert.equal(Object.isFrozen(f.receipts[0]), true);
    assert.equal(f.receipts[0].revision, 4);
    assert.equal(f.receipts[0].boundary, 'durable-store-before-host-ack');
    assert.deepEqual(f.boundary.inspect(), { state: 'released', daemonQualified: false });
    assert.throws(() => f.boundary.arm(base), safe);
  }
});

test('unknown, stale, future and mismatched observations cannot publish a held boundary', () => {
  for (const patch of [
    { generation: 2 },
    { callOrdinal: 2 },
    { callOrdinal: 1025 },
    { activeCount: 1 },
    { status: 'pending' },
    { operation: 'other' },
    { transition: 'sending' },
    { rootId: 'hbs_' + 'b'.repeat(32) },
    { expiresAt: base.expiresAt + 1 },
    { expectedRevision: 2 },
    { unknown: true },
  ]) {
    const f = fixture();
    Object.assign(f.observed, patch);
    f.boundary.arm(base);
    assert.throws(() => f.boundary.afterDurableAck(f.facts), safe);
    assert.equal(f.receipts.length, 0);
    assert.equal(f.boundary.inspect().state, 'failed');
  }
  for (const revision of [0, 3, 5, Number.MAX_SAFE_INTEGER]) {
    const f = fixture();
    f.boundary.arm(base);
    assert.throws(() => f.boundary.afterDurableAck({ ...f.facts, revision }), safe);
    assert.equal(f.receipts.length, 0);
  }
});

test('the fixed five-second bound includes publication and polling; stalled or reversed clocks fail closed', () => {
  for (const config of [
    { released: () => false, sleep: () => {} },
    {
      now: (() => {
        let time = 1;
        return () => time--;
      })(),
    },
    { now: () => Infinity },
    {
      sleep: () => {},
      now: (() => {
        let time = 0;
        return () => (time += 1000);
      })(),
      released: () => false,
    },
    { publish: () => false },
    { released: () => 'true' },
    { sleep: () => null, released: () => false },
    {
      released: () => {
        throw Error('PRIVATE');
      },
    },
    { inspect: () => Promise.reject(Error('PRIVATE')) },
  ]) {
    const f = fixture(config);
    f.boundary.arm(base);
    assert.throws(() => f.boundary.afterDurableAck(f.facts), safe);
    assert.equal(f.boundary.inspect().state, 'failed');
  }
});

test('closing during a trusted callback, duplicate entry and invalid baseline cannot release', () => {
  const f = fixture({
    publish: () => {
      f.boundary.close();
    },
  });
  f.boundary.arm(base);
  assert.throws(() => f.boundary.afterDurableAck(f.facts), safe);
  for (const patch of [
    null,
    {},
    { ...base, generation: 0 },
    { ...base, generation: 17 },
    { ...base, callOrdinal: 1024 },
    { ...base, expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...base, transition: 'unobserved' },
    { ...base, expiresAt: -1 },
  ]) {
    const g = fixture();
    assert.throws(() => g.boundary.arm(patch), safe);
  }
  const g = fixture();
  g.boundary.arm(base);
  assert.throws(() => g.boundary.arm(base), safe);
});

test('callback and data validation reject proxies and accessors without running them', () => {
  let touched = 0;
  const trap = () => {
    touched++;
    throw Error('PRIVATE');
  };
  const f = fixture();
  for (const callback of [
    null,
    async () => {},
    function* () {},
    new Proxy(() => {}, { get: trap }),
  ]) {
    assert.throws(() => createPublicationAckBoundary({ ...f.config, inspect: callback }), safe);
  }
  for (const input of [
    new Proxy({}, { ownKeys: trap }),
    Object.defineProperty({ ...base }, 'rootId', { get: trap }),
  ]) {
    const g = fixture();
    assert.throws(() => g.boundary.arm(input), safe);
  }
  const g = fixture({ released: () => Object.defineProperty({}, 'then', { get: trap }) });
  g.boundary.arm(base);
  assert.throws(() => g.boundary.afterDurableAck(g.facts), safe);
  assert.equal(touched, 0);
});

test('maximum exact counters remain accepted while malformed facts never inspect or publish', () => {
  const high = {
    ...base,
    generation: 16,
    callOrdinal: 1023,
    expectedRevision: Number.MAX_SAFE_INTEGER - 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const f = fixture();
  Object.assign(f.observed, high, { callOrdinal: 1024 });
  f.boundary.arm(high);
  f.boundary.afterDurableAck({
    rootId: high.rootId,
    expiresAt: high.expiresAt,
    revision: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(f.boundary.inspect().state, 'released');
  let touched = 0;
  for (const value of [
    null,
    {},
    { ...f.facts, extra: true },
    { ...f.facts, rootId: 'invalid' },
    { ...f.facts, expiresAt: base.expiresAt + 1 },
    { ...f.facts, revision: 5 },
    Object.defineProperty({}, 'rootId', {
      get() {
        touched++;
        throw Error('PRIVATE');
      },
    }),
  ]) {
    const g = fixture({
      inspect: () => {
        touched++;
      },
    });
    g.boundary.arm(base);
    assert.throws(() => g.boundary.afterDurableAck(value), safe);
  }
  assert.equal(touched, 0);
});

test('a release arriving after the fixed deadline cannot qualify, including time spent publishing', () => {
  let time = 0;
  const f = fixture({
    now: () => time,
    publish: () => {
      time = 5000;
    },
    released: () => true,
  });
  f.boundary.arm(base);
  assert.throws(() => f.boundary.afterDurableAck(f.facts), safe);
  assert.equal(f.boundary.inspect().state, 'failed');
  const g = fixture({
    now: () => time,
    released: () => {
      time += 5000;
      return true;
    },
  });
  g.boundary.arm(base);
  assert.throws(() => g.boundary.afterDurableAck(g.facts), safe);
});
