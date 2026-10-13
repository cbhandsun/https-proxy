'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextCompactionSchedule } = require('../lib/proxy/context-compaction-schedule');

const budget = (extra = {}) => ({
  key: 'private-route',
  bodyBytes: 700,
  inputTokens: 350,
  hardBodyBytes: 1000,
  inputTokenLimit: 500,
  growthReserveBytes: 100,
  preflightBodyBytes: 1000,
  ...extra,
});

test('schedule admits exact hard limits but requires cleanup for byte or token overflow', () => {
  const schedule = createContextCompactionSchedule();
  assert.equal(schedule.decide(budget()).mode, 'none');
  assert.equal(schedule.decide(budget({ bodyBytes: 901 })).mode, 'background');
  assert.equal(schedule.decide(budget({ inputTokens: 451 })).mode, 'background');
  assert.equal(schedule.decide(budget({ bodyBytes: 1000, inputTokens: 500 })).mode, 'background');
  for (const extra of [{ bodyBytes: 1001 }, { inputTokens: 501 }])
    assert.equal(schedule.decide(budget(extra)).mode, 'required');
  assert.equal(schedule.decide(budget({ bodyBytes: 0, inputTokens: 0 })).mode, 'none');
  assert.equal(schedule.decide(budget({ preflightBodyBytes: 699 })).mode, 'background');
});

test('measured summary peak and main median reserve early but never exceed a quarter of limits', () => {
  const schedule = createContextCompactionSchedule();
  for (const durationMs of [100, 200, 300])
    schedule.observe({ key: 'private-route', kind: 'main', durationMs });
  schedule.observe({ key: 'private-route', kind: 'summary', durationMs: 1000 });
  const decision = schedule.decide(budget({ bodyBytes: 800 }));
  assert.equal(decision.mode, 'background');
  assert.equal(decision.forecastTurns, 4);
  assert.equal(decision.observedMainMs, 200);
  assert.equal(decision.reserveBytes, 250);
  assert.equal(decision.reserveTokens, 125);
  assert.equal(schedule.decide(budget({ key: 'another-route', bodyBytes: 800 })).mode, 'none');
  assert.ok(!JSON.stringify(decision).includes('private-route'));
  assert.deepEqual(schedule.stats(), { routes: 1 });
  const extreme = schedule.decide(budget({ growthReserveBytes: Number.MAX_SAFE_INTEGER }));
  assert.equal(extreme.reserveBytes, 250);
});

test('sample, route, TTL and backwards-clock bounds release numeric observations', () => {
  let now = 100;
  const schedule = createContextCompactionSchedule({ now: () => now });
  schedule.observe({ key: 'private-route', kind: 'summary', durationMs: 10000 });
  for (let i = 0; i < 9; i++) {
    schedule.observe({ key: 'private-route', kind: 'summary', durationMs: 10 });
    schedule.observe({ key: 'private-route', kind: 'main', durationMs: i });
  }
  assert.equal(schedule.decide(budget()).observedSummaryMs, 10);
  assert.equal(schedule.decide(budget()).summarySamples, 8);
  assert.equal(schedule.decide(budget()).mainSamples, 8);
  for (let i = 0; i < 64; i++) schedule.observe({ key: 'route-' + i, kind: 'main', durationMs: 5 });
  assert.equal(schedule.stats().routes, 64);
  assert.equal(schedule.decide(budget()).mainSamples, 0);
  now += 1800000;
  assert.equal(schedule.stats().routes, 0);
  schedule.observe({ key: 'private-route', kind: 'summary', durationMs: 20 });
  now -= 1;
  assert.equal(schedule.observe({ key: 'private-route', kind: 'main', durationMs: 10 }), false);
  assert.equal(schedule.stats().routes, 0);
  now += 1;
  assert.equal(schedule.observe({ key: 'private-route', kind: 'main', durationMs: 10 }), true);
  now = NaN;
  assert.equal(schedule.stats().routes, 0);
  now = Number.MAX_SAFE_INTEGER;
  assert.equal(schedule.observe({ key: 'private-route', kind: 'main', durationMs: 0 }), false);
});

test('invalid budgets, measurements and hostile constructor records never run accessors', () => {
  let accessed = 0;
  const hostile = Object.defineProperty({}, 'now', {
    get() {
      accessed++;
      return Date.now;
    },
  });
  for (const input of [
    null,
    [],
    1,
    { unknown: true },
    { now: 5 },
    Object.create({ now: Date.now }),
    hostile,
  ])
    assert.throws(() => createContextCompactionSchedule(input), TypeError);
  assert.equal(accessed, 0);
  const schedule = createContextCompactionSchedule(Object.create(null));
  for (const extra of [
    { hardBodyBytes: 0 },
    { inputTokenLimit: 0 },
    { bodyBytes: -1 },
    { inputTokens: Infinity },
    { growthReserveBytes: 1.5 },
    { key: '' },
    { key: 'x\n' },
    { key: 'x'.repeat(1025) },
    { extra: true },
  ])
    assert.throws(() => schedule.decide(budget(extra)), TypeError);
  const getterBudget = budget();
  Object.defineProperty(getterBudget, 'bodyBytes', {
    get() {
      accessed++;
      return 0;
    },
  });
  assert.throws(() => schedule.decide(getterBudget), TypeError);
  for (const value of [
    null,
    {},
    { key: 'route', kind: 'other', durationMs: 1 },
    { key: 'route', kind: 'main', durationMs: -1 },
    { key: 'route', kind: 'main', durationMs: 3600001 },
    { key: 'route', kind: 'main', durationMs: '1' },
  ])
    assert.throws(() => schedule.observe(value), TypeError);
  assert.equal(accessed, 0);
});
