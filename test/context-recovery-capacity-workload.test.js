'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const {
  CAPACITY_EXECUTION_BUDGET_MS,
  CAPACITY_PERFORMANCE_TARGET_MS,
  createCapacityTiming,
} = require('../scripts/lib/context-recovery-capacity-timing');
const { validateRecoveryPublicationCounts } = require('../lib/proxy/context-recovery-capacity');
const {
  parseCapacityReports,
  readCapacityWorker,
  capacityWorkerSelections,
} = require('../scripts/lib/context-recovery-capacity-parallel');
const {
  CAPACITY_PROFILES,
  parseProfile,
  exerciseCapacityProfile,
} = require('../scripts/lib/context-recovery-capacity-workload');

const fixture = (extra = {}) => ({
  name: 'fixture',
  roots: 1,
  turns: 2,
  intervalMs: 1000,
  outputBytes: 512,
  reopenEvery: 1,
  recoveries: 2,
  ...extra,
});

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

test('capacity scheduling starts the largest workload promptly without adding workers or omitting profiles', () => {
  const selections = capacityWorkerSelections();
  assert.equal(selections.length, 2);
  assert.deepEqual(
    selections.flat().sort((a, b) => a - b),
    CAPACITY_PROFILES.map((_, i) => i)
  );
  const costs = CAPACITY_PROFILES.map(
    (profile) => profile.roots * profile.turns * (profile.outputBytes + 4096)
  );
  const largest = costs.indexOf(Math.max(...costs));
  assert.ok(selections.some((selection) => selection[0] === largest));
  const makespan = Math.max(
    ...selections.map((selection) => selection.reduce((cost, index) => cost + costs[index], 0))
  );
  assert.equal(makespan, costs[largest]);
  selections[0].push(999);
  assert.equal(capacityWorkerSelections().flat().includes(999), false);
});

test('publication capacity bounds new, legacy and mixed journals without executing unknown input', () => {
  for (const entries of [
    [],
    [{ version: 8, count: 0 }],
    [{ version: 9, count: 512 }],
    [{ version: 10, count: 512 }],
    Array(4).fill({ version: 8, count: 512 }),
    [
      { version: 1, count: 128 },
      { version: 7, count: 128 },
    ],
    [
      { version: 6, count: 256 },
      { version: 8, count: 512 },
    ],
  ])
    assert.doesNotThrow(() => validateRecoveryPublicationCounts(entries));
  let touched = 0;
  const getter = Object.defineProperty({}, 'version', {
    enumerable: true,
    get() {
      touched++;
      return 8;
    },
  });
  for (const entries of [
    null,
    {},
    [null],
    [[]],
    [{ version: 8 }],
    [{ version: 8, count: 1, extra: true }],
    [getter],
    Array(257).fill({ version: 8, count: 0 }),
    Array(5).fill({ version: 8, count: 512 }),
    [
      { version: 6, count: 256 },
      { version: 7, count: 1 },
    ],
    [{ version: 8, count: 513 }],
    [{ version: 1, count: 257 }],
    [{ version: 11, count: 1 }],
    ...[-1, 0.5, Infinity, NaN, '1', null].map((count) => [{ version: 8, count }]),
  ])
    assert.throws(() => validateRecoveryPublicationCounts(entries));
  assert.equal(touched, 0);
});

test('capacity worker replies validate profiles, counters, failures and unknown input without running hooks', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseCapacityReports([unfinished()], [0]))), [
    unfinished(),
  ]);
  for (const field of ['firstFailure', 'firstReadFailure', 'firstCoverageGap']) {
    const value = unfinished();
    value[field] =
      field === 'firstCoverageGap'
        ? { round: 1, root: 0, expectedSources: 1, availableSources: 0 }
        : {
            round: 1,
            root: 0,
            phase: field === 'firstFailure' ? 'begin' : 'read',
            code: 'context_evidence_unavailable',
          };
    assert.equal(parseCapacityReports([value], [0])[0].qualified, false);
  }
  let accessed = false;
  const hostile = unfinished();
  Object.defineProperty(hostile, 'profile', {
    enumerable: true,
    get() {
      accessed = true;
      throw Error('private');
    },
  });
  for (const [input, indexes] of [
    [null, [0]],
    [[], [0]],
    [[unfinished()], []],
    [[unfinished()], [0, 0]],
    [[unfinished()], [5]],
    [[hostile], [0]],
    [[{ ...unfinished(), completedTurns: -1 }], [0]],
    [[{ ...unfinished(), qualified: true }], [0]],
    [[{ ...unfinished(), profile: { ...CAPACITY_PROFILES[1] } }], [0]],
    [
      [
        {
          ...unfinished(),
          firstFailure: { phase: 'begin', round: 1, root: 0, code: 'private\nvalue' },
        },
      ],
      [0],
    ],
    [
      [
        {
          ...unfinished(),
          firstCoverageGap: { round: 1, root: 0, expectedSources: 1, availableSources: 2 },
        },
      ],
      [0],
    ],
  ])
    assert.throws(() => parseCapacityReports(input, indexes), {
      message: 'context_recovery_capacity_qualification_failed',
    });
  assert.equal(accessed, false);
});

test('capacity worker collection requires one validated reply followed by clean exit', async () => {
  const worker = new EventEmitter();
  let settled = false;
  const pending = readCapacityWorker(worker, [0]).then((value) => {
    settled = true;
    return value;
  });
  worker.emit('message', [unfinished()]);
  await Promise.resolve();
  assert.equal(settled, false);
  worker.emit('exit', 0);
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [unfinished()]);
  for (const mode of ['empty', 'error', 'exit', 'duplicate', 'malformed']) {
    const failed = new EventEmitter();
    const rejection = assert.rejects(readCapacityWorker(failed, [0]), {
      message: 'context_recovery_capacity_qualification_failed',
    });
    if (mode !== 'empty') failed.emit('message', mode === 'malformed' ? [] : [unfinished()]);
    if (mode === 'duplicate') failed.emit('message', [unfinished()]);
    if (mode === 'error') failed.emit('error', new Error('synthetic-private-value'));
    failed.emit('exit', mode === 'exit' ? 1 : 0);
    await rejection;
  }
});

test('capacity workload validates bounded data without invoking input hooks', () => {
  let accessed = false;
  const hostile = fixture();
  Object.defineProperty(hostile, 'roots', {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error('private-input');
    },
  });
  for (const input of [
    null,
    undefined,
    [],
    {},
    hostile,
    fixture({ name: 'private\ncontent' }),
    fixture({ roots: '1' }),
    fixture({ roots: 5 }),
    fixture({ roots: 0 }),
    fixture({ outputBytes: Infinity }),
    fixture({ outputBytes: -1 }),
    fixture({ outputBytes: 2097153 }),
    fixture({ turns: 481 }),
    fixture({ turns: 480, intervalMs: 300000 }),
    fixture({ recoveries: 3 }),
    fixture({ recoveries: 0.5 }),
    fixture({ reopenEvery: -1 }),
    fixture({ extra: true }),
  ])
    assert.throws(() => parseProfile(input), { message: 'invalid_capacity_profile' });
  assert.equal(accessed, false);
  assert.equal(parseProfile(fixture({ outputBytes: 0 })).outputBytes, 0);
  assert.equal(CAPACITY_PROFILES.length, 5);
  assert.ok(Object.isFrozen(CAPACITY_PROFILES));
  assert.ok(CAPACITY_PROFILES.every(Object.isFrozen));
});

test('successful workload drains last result and verifies full multi-page originals after reopen', () => {
  const report = exerciseCapacityProfile(fixture({ outputBytes: 32768, roots: 2 }));
  assert.equal(report.qualified, true);
  assert.equal(report.completedTurns, 4);
  assert.equal(report.verifiedRecoveries, 4);
  assert.equal(report.reopenCount, 2);
  assert.equal(report.finalResultsObserved, true);
});

test('empty source and no-read fixture still require final observation', () => {
  const report = exerciseCapacityProfile(
    fixture({ turns: 1, outputBytes: 0, reopenEvery: 0, recoveries: 0 })
  );
  assert.equal(report.qualified, true);
  assert.equal(report.finalResultsObserved, true);
  assert.equal(report.verifiedRecoveries, 0);
});

test('capacity shortfall is explicit and cannot qualify by completing calls alone', () => {
  const report = exerciseCapacityProfile(
    fixture({ turns: 129, outputBytes: 131072, recoveries: 0, reopenEvery: 24 })
  );
  assert.equal(report.qualified, false);
  assert.equal(report.finalResultsObserved, false);
  assert.equal(report.firstFailure, null);
  assert.deepEqual(report.firstCoverageGap, {
    round: 130,
    root: 0,
    expectedSources: 129,
    availableSources: 128,
  });
  assert.equal(report.completedTurns, 129);
});

test('independent recovery rounds no longer exhaust the legacy lifetime allowance', () => {
  const report = exerciseCapacityProfile(fixture({ turns: 34, recoveries: 34 }));
  assert.equal(report.qualified, true);
  assert.equal(report.verifiedRecoveries, 34);
  assert.equal(report.firstReadFailure, null);
});

test('qualification command distinguishes capacity refusal from execution error', (t) => {
  const script = path.resolve(__dirname, '../scripts/qualify-context-recovery-capacity.js');
  const started = performance.now();
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: CAPACITY_EXECUTION_BUDGET_MS,
  });
  const commandTiming = createCapacityTiming(performance.now() - started, 'capacity-command');
  t.diagnostic(JSON.stringify(commandTiming));
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, report.qualified ? 0 : 1);
  assert.equal(report.profiles.length, 5);
  for (const profile of report.profiles)
    assert.equal(profile.qualified, true, profile.profile.name);
  assert.equal(report.qualified, true);
  assert.equal(
    report.qualified,
    report.profiles.every((profile) => profile.qualified)
  );
  assert.equal(report.transportQualified, false);
  assert.equal(report.durableStorageQualified, false);
  assert.equal(report.realModelRequests, 0);
  assert.equal(commandTiming.executionBudgetMet, true);
  assert.equal(report.timing.scope, 'capacity-workers');
  assert.equal(report.timing.executionBudgetMs, CAPACITY_EXECUTION_BUDGET_MS);
  assert.equal(report.timing.executionBudgetMet, true);
  assert.equal(report.timing.performanceTargetMs, CAPACITY_PERFORMANCE_TARGET_MS);
  assert.equal(typeof report.timing.elapsedMs, 'number');
  assert.ok(Number.isFinite(report.timing.elapsedMs) && report.timing.elapsedMs >= 0);
  assert.equal(
    report.timing.performanceTargetMet,
    report.timing.elapsedMs <= CAPACITY_PERFORMANCE_TARGET_MS
  );
  assert.equal(result.stderr, '');
  const invalid = spawnSync(process.execPath, [script, 'private-input'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr.trim(), 'context_recovery_capacity_qualification_failed');
});
