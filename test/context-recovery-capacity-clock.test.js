'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCapacityRealtimeClock } = require('../scripts/lib/context-recovery-capacity-clock');
const safe = { message: 'capacity_realtime_clock_failed' };

function fixture(overrides = {}) {
  const state = { wall: 1000, monotonic: 100, waits: [] };
  const clock = createCapacityRealtimeClock({
    wall: () => state.wall,
    monotonic: () => state.monotonic,
    sleep: async (milliseconds) => {
      state.waits.push(milliseconds);
      state.monotonic += milliseconds;
      state.wall += milliseconds;
    },
    ...overrides,
  });
  return { state, clock };
}

test('real-time clock paces the complete 24-hour offset in bounded waits', async () => {
  const { state, clock } = fixture();
  assert.deepEqual(clock.inspect(), {
    started: false,
    scheduledMs: 0,
    elapsedMs: 0,
    maximumLatenessMs: 0,
  });
  await clock.advance(0);
  await clock.advance(86400000);
  assert.equal(state.waits.length, 1440);
  assert.ok(state.waits.every((duration) => duration === 60000));
  assert.deepEqual(clock.inspect(), {
    started: true,
    scheduledMs: 86400000,
    elapsedMs: 86400000,
    maximumLatenessMs: 0,
  });
});

test('wall-clock forward jumps cannot bypass monotonic waiting and late work stays visible', async () => {
  const { state, clock } = fixture();
  await clock.advance(0);
  state.wall += 86400000;
  await clock.advance(300000);
  assert.deepEqual(state.waits, [60000, 60000, 60000, 60000, 60000]);
  state.monotonic += 2000;
  state.wall += 2000;
  await clock.advance(301000);
  assert.equal(clock.inspect().maximumLatenessMs, 1000);
  assert.equal(clock.inspect().elapsedMs, 302000);
});

test('real default timer waits before returning the next scheduled turn', async () => {
  const clock = createCapacityRealtimeClock();
  const before = clock.now();
  await clock.advance(0);
  await clock.advance(20);
  assert.ok(clock.now() >= before);
  assert.ok(clock.inspect().elapsedMs >= 20);
});

test('backward or malformed wall/monotonic values fail permanently', async () => {
  for (const [field, value] of [
    ['wall', 999],
    ['wall', NaN],
    ['wall', Infinity],
    ['wall', '1000'],
    ['wall', 0.5],
    ['monotonic', 99],
    ['monotonic', NaN],
    ['monotonic', Infinity],
    ['monotonic', -1],
  ]) {
    const { state, clock } = fixture();
    await clock.advance(0);
    state[field] = value;
    assert.throws(() => clock.now(), safe);
    state.wall = 1000;
    state.monotonic = 100;
    await assert.rejects(clock.advance(1), safe);
  }
});

test('empty, repeated, backward and oversized offsets reject without scheduling', async () => {
  for (const offset of [undefined, null, {}, NaN, Infinity, -1, 0.5, 86400001, '0', 1]) {
    const { state, clock } = fixture();
    await assert.rejects(clock.advance(offset), safe);
    assert.deepEqual(state.waits, []);
  }
  const { clock } = fixture();
  await clock.advance(0);
  await assert.rejects(clock.advance(0), safe);
});

test('failed, malformed and non-progressing sleepers cannot report an elapsed interval', async () => {
  let touched = 0;
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      touched++;
      return undefined;
    },
  });
  for (const sleep of [
    () => undefined,
    () => thenable,
    async () => true,
    async () => {},
    async () => {
      throw Error('PRIVATE_CLOCK_SENTINEL');
    },
  ]) {
    const { clock } = fixture({ sleep });
    await clock.advance(0);
    await assert.rejects(clock.advance(1), safe);
  }
  assert.equal(touched, 0);
});

test('overlapping advancement rejects both callers rather than advancing twice', async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const { state, clock } = fixture({ sleep: () => waiting });
  await clock.advance(0);
  const first = clock.advance(1);
  const rejected = assert.rejects(first, safe);
  await assert.rejects(clock.advance(2), safe);
  state.monotonic++;
  state.wall++;
  release();
  await rejected;
});

test('clock options reject accessors, proxies and unknown capabilities without execution', () => {
  let touched = 0;
  const getter = Object.defineProperty({}, 'wall', {
    enumerable: true,
    get() {
      touched++;
      return undefined;
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        return [];
      },
    }
  );
  for (const options of [
    null,
    [],
    getter,
    proxy,
    { extra: () => 0 },
    { wall: 0 },
    { monotonic: async () => 0 },
    { sleep: new Proxy(() => {}, {}) },
  ])
    assert.throws(() => createCapacityRealtimeClock(options), safe);
  assert.equal(touched, 0);
});
