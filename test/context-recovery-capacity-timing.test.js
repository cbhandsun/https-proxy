'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CAPACITY_PROFILES } = require('../scripts/lib/context-recovery-capacity-workload');
const {
  CAPACITY_EXECUTION_BUDGET_MS,
  CAPACITY_PERFORMANCE_TARGET_MS,
  createCapacityTiming,
  createCapacityQualificationReport,
} = require('../scripts/lib/context-recovery-capacity-timing');

const unfinished = () => ({
  profile: { ...CAPACITY_PROFILES[0] },
  completedTurns: 0,
  verifiedRecoveries: 0,
  reopenCount: 0,
  finalResultsObserved: false,
  firstCoverageGap: null,
  firstFailure: null,
  firstReadFailure: null,
  qualified: false,
});

test('capacity qualification keeps execution resources and performance independent from functional capacity', () => {
  const profiles = CAPACITY_PROFILES.map((profile) => ({
    ...unfinished(),
    profile: { ...profile },
    completedTurns: profile.turns * profile.roots,
    verifiedRecoveries: profile.recoveries * profile.roots,
    reopenCount: Math.floor(profile.turns / profile.reopenEvery),
    finalResultsObserved: true,
    qualified: true,
  }));
  assert.equal(CAPACITY_EXECUTION_BUDGET_MS, 180000);
  assert.equal(CAPACITY_PERFORMANCE_TARGET_MS, 60000);
  for (const [elapsedMs, executionBudgetMet, performanceTargetMet] of [
    [0, true, true],
    [60000, true, true],
    [60000.01, true, false],
    [71500, true, false],
    [180000, true, false],
    [180000.01, false, false],
    [Number.MAX_SAFE_INTEGER, false, false],
  ]) {
    // These are synthetic timing inputs, not measured workload evidence.
    const report = createCapacityQualificationReport(profiles, elapsedMs);
    assert.equal(report.qualified, true);
    assert.deepEqual(report.timing, {
      scope: 'capacity-workers',
      elapsedMs,
      executionBudgetMs: 180000,
      executionBudgetMet,
      performanceTargetMs: 60000,
      performanceTargetMet,
    });
    assert.deepEqual(createCapacityTiming(elapsedMs, 'capacity-command'), {
      ...report.timing,
      scope: 'capacity-command',
    });
    assert.equal(report.transportQualified, false);
    assert.equal(report.durableStorageQualified, false);
    assert.equal(report.realModelRequests, 0);
    const refused = profiles.map((profile, index) => (index ? profile : unfinished()));
    assert.equal(createCapacityQualificationReport(refused, elapsedMs).qualified, false);
  }
  let hooks = 0;
  const hostile = {
    valueOf() {
      hooks++;
      return 1;
    },
  };
  for (const elapsedMs of [
    undefined,
    null,
    '',
    '1',
    false,
    hostile,
    NaN,
    Infinity,
    -Infinity,
    -1,
    Number.MAX_VALUE,
  ])
    assert.throws(() => createCapacityQualificationReport(profiles, elapsedMs), {
      message: 'context_recovery_capacity_qualification_failed',
    });
  assert.equal(hooks, 0);
  const hostileProfile = Object.defineProperty({}, 'profile', {
    enumerable: true,
    get() {
      hooks++;
      throw new Error('private-input');
    },
  });
  for (const scope of [undefined, null, '', 'private-content', hostile])
    assert.throws(() => createCapacityTiming(0, scope), {
      message: 'context_recovery_capacity_qualification_failed',
    });
  assert.equal(hooks, 0);
  for (const input of [
    null,
    [],
    [hostileProfile, ...profiles.slice(1)],
    [...profiles, profiles[0]],
    [{ ...profiles[0], qualified: false }, ...profiles.slice(1)],
  ])
    assert.throws(() => createCapacityQualificationReport(input, 0), {
      message: 'context_recovery_capacity_qualification_failed',
    });
  assert.equal(hooks, 0);
});

test('qualification command still rejects invalid arguments as execution errors without leaking input', () => {
  const script = path.resolve(__dirname, '../scripts/qualify-context-recovery-capacity.js');
  const invalid = spawnSync(process.execPath, [script, 'synthetic-private-input'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(invalid.error, undefined);
  assert.equal(invalid.signal, null);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'context_recovery_capacity_qualification_failed\n');
});
