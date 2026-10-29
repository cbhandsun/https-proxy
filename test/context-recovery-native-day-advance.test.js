'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createNativeDayAdvance } = require('../scripts/lib/context-recovery-native-day-advance');
const { createCapacityRealtimeClock } = require('../scripts/lib/context-recovery-capacity-clock');
const safe = { message: 'native_day_advance_failed' };
function fixture(overrides = {}) {
  const progress = [],
    failures = [],
    calls = [];
  let offset = 0;
  const config = {
    clock: {
      async advance(value) {
        calls.push('wait');
        offset = value;
      },
      now() {
        calls.push('now');
        return 1000 + offset;
      },
      inspect() {
        calls.push('inspect');
        return { started: true, scheduledMs: offset, elapsedMs: offset, maximumLatenessMs: 0 };
      },
    },
    verifyIdentity() {
      calls.push('identity');
    },
    emit(value) {
      calls.push('emit');
      progress.push(value);
    },
    onFailure(value) {
      failures.push(value);
    },
    ...overrides,
  };
  return { config, progress, failures, calls, run: () => createNativeDayAdvance(config) };
}
test('day advance retains exact ordering, actual offset and fixed progress fields', async () => {
  const f = fixture(),
    advance = f.run();
  await advance(0);
  await advance(300000);
  assert.deepEqual(f.calls, [
    'identity',
    'wait',
    'identity',
    'now',
    'inspect',
    'emit',
    'identity',
    'wait',
    'identity',
    'now',
    'inspect',
    'emit',
  ]);
  assert.deepEqual(
    f.progress.map((v) => [v.event, v.scheduledMs]),
    [
      ['native_day_started', 0],
      ['capacity_tick', 300000],
    ]
  );
  assert.deepEqual(Object.keys(f.progress[1]).sort(), [
    'atUtc',
    'elapsedMs',
    'event',
    'maximumLatenessMs',
    'realtime24hStarted',
    'scheduledMs',
    'started',
  ]);
  assert.equal(f.failures.length, 0);
});
for (const phase of [
  'identity-before-wait',
  'wait',
  'identity-after-wait',
  'progress-now',
  'progress-inspect',
  'progress-emit',
])
  test('day advance reports its first failed phase and cannot retry: ' + phase, async () => {
    const f = fixture();
    let identities = 0;
    const boom = () => {
      throw Error('PRIVATE_PHASE_SENTINEL');
    };
    if (phase.startsWith('identity'))
      f.config.verifyIdentity = () => {
        if (++identities === (phase === 'identity-before-wait' ? 1 : 2)) boom();
      };
    if (phase === 'wait') f.config.clock.advance = async () => boom();
    if (phase === 'progress-now') f.config.clock.now = boom;
    if (phase === 'progress-inspect') f.config.clock.inspect = boom;
    if (phase === 'progress-emit') f.config.emit = boom;
    const advance = f.run();
    await assert.rejects(advance(5400000), safe);
    assert.deepEqual(f.failures, [{ phase, scheduledMs: 5400000 }]);
    assert.equal(Object.isFrozen(f.failures[0]), true);
    await assert.rejects(advance(5400000), safe);
    assert.equal(f.failures.length, 1);
    assert.equal(f.progress.length, 0);
    assert.equal(JSON.stringify(f.failures).includes('PRIVATE'), false);
  });
test('day advance refuses malformed callbacks and executable descriptors without evaluation', () => {
  let traps = 0;
  for (const input of [
    null,
    {},
    [],
    new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          return [];
        },
      }
    ),
    Object.defineProperty({}, 'clock', {
      enumerable: true,
      get() {
        traps++;
        return {};
      },
    }),
  ])
    assert.throws(() => createNativeDayAdvance(input), safe);
  for (const key of ['verifyIdentity', 'emit', 'onFailure']) {
    for (const value of [null, {}, async () => {}, new Proxy(() => {}, {})]) {
      const f = fixture();
      f.config[key] = value;
      assert.throws(f.run, safe);
    }
  }
  const f = fixture();
  Object.defineProperty(f.config.clock, 'inspect', {
    enumerable: true,
    get() {
      traps++;
      return () => {};
    },
  });
  assert.throws(f.run, safe);
  assert.equal(traps, 0);
});
test('illegal offsets latch failure before waiting or exposing input values', async () => {
  for (const offset of [
    -1,
    86400001,
    Number.MAX_SAFE_INTEGER,
    Infinity,
    NaN,
    {},
    'PRIVATE',
    null,
  ]) {
    const f = fixture(),
      advance = f.run();
    await assert.rejects(advance(offset), safe);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.failures, [{ phase: 'offset-admission', scheduledMs: null }]);
    await assert.rejects(advance(0), safe);
  }
});
test('false progress, asynchronous observations and failed diagnostic output cannot grant a tick', async () => {
  for (const value of [
    null,
    {},
    { started: true, scheduledMs: 0, elapsedMs: -1, maximumLatenessMs: 0 },
    { started: true, scheduledMs: 1, elapsedMs: 1, maximumLatenessMs: 0 },
    { started: true, scheduledMs: 0, elapsedMs: 0, maximumLatenessMs: Infinity },
  ]) {
    const f = fixture();
    f.config.clock.inspect = () => value;
    await assert.rejects(f.run()(0), safe);
    assert.equal(f.failures[0].phase, 'progress-inspect');
    assert.equal(f.progress.length, 0);
  }
  for (const key of ['verifyIdentity', 'emit']) {
    const f = fixture();
    f.config[key] = () => Promise.reject(Error('PRIVATE_ASYNC'));
    await assert.rejects(f.run()(0), safe);
    assert.equal(f.progress.length, 0);
  }
  const f = fixture();
  f.config.clock.advance = async () => {
    throw Error('PRIVATE_WAIT');
  };
  f.config.onFailure = () => {
    throw Error('PRIVATE_OBSERVER');
  };
  await assert.rejects(f.run()(0), safe);
});
test('concurrent advance poisons the pending wait and yields no successful tick', async () => {
  let done;
  const f = fixture();
  f.config.clock.advance = () =>
    new Promise((resolve) => {
      done = resolve;
    });
  const advance = f.run(),
    pending = advance(0);
  await assert.rejects(advance(1), safe);
  done();
  await assert.rejects(pending, safe);
  assert.equal(f.progress.length, 0);
  assert.deepEqual(f.failures, [{ phase: 'wait', scheduledMs: 0 }]);
});
test('real clock elapsed time is retained and a backward wall clock still fails', async () => {
  const f = fixture({ clock: createCapacityRealtimeClock() });
  const advance = f.run(),
    start = performance.now();
  await advance(0);
  await advance(10);
  assert.ok(performance.now() - start >= 10);
  assert.ok(f.progress[1].elapsedMs >= 10);
  let wall = 100,
    mono = 0;
  const bad = fixture({
    clock: createCapacityRealtimeClock({
      wall: () => wall,
      monotonic: () => mono,
      sleep: async (ms) => {
        mono += ms;
        wall--;
      },
    }),
  });
  const step = bad.run();
  await step(0);
  await assert.rejects(step(10), safe);
  assert.deepEqual(bad.failures, [{ phase: 'wait', scheduledMs: 10 }]);
  assert.equal(bad.progress.length, 1);
});
