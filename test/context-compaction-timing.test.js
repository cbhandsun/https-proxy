'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createCompactionTiming,
  startCompactionTiming,
  measureCompactionTiming,
  snapshotCompactionTiming,
  sanitizeCompactionTiming,
  recordCompactionSummaryProgress,
} = require('../lib/proxy/context-compaction-timing');

test('summary progress is bounded, capability-owned and safe at the logging boundary', () => {
  const timing = createCompactionTiming();
  assert.equal(snapshotCompactionTiming(timing).summaryLastChunk, undefined);
  for (const stage of ['planning', 'request', 'validation', 'completed']) {
    recordCompactionSummaryProgress(timing, 16, stage, true);
    const value = snapshotCompactionTiming(timing);
    assert.equal(value.summaryLastChunk, 16);
    assert.equal(value.summaryLastStage, stage);
    assert.equal(value.summaryLastChunkReused, true);
    assert.deepEqual(sanitizeCompactionTiming(value), { ...value, commitDeferred: false });
  }
  for (const chunk of [0, -1, 17, Infinity, NaN, 'SECRET', null, {}])
    assert.throws(() => recordCompactionSummaryProgress(timing, chunk, 'request'), TypeError);
  assert.throws(() => recordCompactionSummaryProgress(timing, 1, 'SECRET'), TypeError);
  assert.throws(() => recordCompactionSummaryProgress(timing, 1, 'request', 'SECRET'), TypeError);
  assert.throws(() => recordCompactionSummaryProgress({}, 1, 'request'), TypeError);
  assert.doesNotThrow(() => recordCompactionSummaryProgress(undefined, 1, 'request'));
  let hooks = 0;
  const base = snapshotCompactionTiming(timing);
  const getter = Object.defineProperty({ ...base }, 'summaryLastStage', {
    get() {
      hooks++;
      return 'request';
    },
  });
  for (const value of [
    { ...base, summaryLastChunk: 0 },
    { ...base, summaryLastChunk: 17 },
    { ...base, summaryLastStage: 'SECRET' },
    { ...base, summaryLastChunkReused: 'SECRET' },
    getter,
  ]) {
    const safe = sanitizeCompactionTiming(value);
    assert.equal(safe.valid, false);
    assert.equal(safe.summaryLastChunk, undefined);
    assert.ok(!JSON.stringify(safe).includes('SECRET'));
  }
  const partial = { ...base };
  delete partial.summaryLastChunk;
  assert.equal(sanitizeCompactionTiming(partial).valid, false);
  assert.equal(hooks, 0);
});

test('timing records independent numeric stages, completed chunks and pending requests without task data', () => {
  let time = 0;
  const timing = createCompactionTiming(() => time);
  const finishPlanning = startCompactionTiming(timing, 'planning');
  time = 5;
  finishPlanning();
  finishPlanning();
  const finishRequest = startCompactionTiming(timing, 'summaryRequest');
  assert.equal(snapshotCompactionTiming(timing).summaryPendingRequests, 1);
  time = 25;
  finishRequest();
  time = 26;
  measureCompactionTiming(timing, 'validation', () => {
    time = 29;
  });
  const snapshot = snapshotCompactionTiming(timing);
  assert.deepEqual(snapshot, {
    valid: true,
    conversionMs: 0,
    planningMs: 5,
    summaryRequestMs: 20,
    validationMs: 3,
    coordinationMs: 0,
    commitMs: 0,
    summaryRequests: 1,
    summaryPendingRequests: 0,
    summaryChunkMs: [20],
  });
  snapshot.summaryChunkMs.push('SECRET');
  assert.deepEqual(snapshotCompactionTiming(timing).summaryChunkMs, [20]);
  const error = new Error('SECRET');
  assert.throws(
    () =>
      measureCompactionTiming(timing, 'commit', () => {
        time += 4;
        throw error;
      }),
    (value) => value === error
  );
  assert.equal(snapshotCompactionTiming(timing).commitMs, 4);
  assert.ok(!JSON.stringify(snapshotCompactionTiming(timing)).includes('SECRET'));
});

test('terminal timing sanitization accepts only bounded numeric data and never executes hooks', () => {
  const source = { ...snapshotCompactionTiming(createCompactionTiming()), commitDeferred: true };
  assert.deepEqual(sanitizeCompactionTiming(source), source);
  assert.equal(sanitizeCompactionTiming(null), undefined);
  assert.equal(sanitizeCompactionTiming([]), undefined);
  assert.equal(sanitizeCompactionTiming(new Date()), undefined);
  let calls = 0;
  const accessor = Object.defineProperty({}, 'valid', {
    get() {
      calls++;
      return true;
    },
  });
  assert.equal(sanitizeCompactionTiming(accessor), undefined);
  const chunks = [];
  Object.defineProperty(chunks, '0', {
    get() {
      calls++;
      return 1;
    },
  });
  const result = sanitizeCompactionTiming({
    ...source,
    summaryChunkMs: chunks,
    body: 'SECRET',
    authorization: 'SECRET',
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.summaryChunkMs, []);
  for (const value of [
    Infinity,
    NaN,
    -1,
    'SECRET',
    {
      valueOf() {
        calls++;
        return 1;
      },
    },
  ]) {
    const invalid = sanitizeCompactionTiming({
      ...source,
      planningMs: value,
      summaryRequests: value,
    });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.planningMs, 0);
  }
  const extreme = sanitizeCompactionTiming({
    ...source,
    planningMs: 3600001,
    summaryRequests: 100,
    summaryPendingRequests: 100,
    summaryChunkMs: [3600001],
  });
  assert.equal(extreme.planningMs, 3600000);
  assert.equal(extreme.summaryRequests, 16);
  assert.deepEqual(extreme.summaryChunkMs, [3600000]);
  const inconsistent = sanitizeCompactionTiming({
    ...source,
    summaryRequests: 1,
    summaryPendingRequests: 2,
  });
  assert.equal(inconsistent.valid, false);
  assert.equal(inconsistent.summaryPendingRequests, 1);
  for (const value of [undefined, new Array(17), [NaN]])
    assert.equal(sanitizeCompactionTiming({ ...source, summaryChunkMs: value }).valid, false);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('invalid clocks and extreme durations cannot leak nonfinite or unbounded metrics', () => {
  for (const pair of [
    [5, 4],
    [NaN, 5],
    [0, Infinity],
    [-1, 5],
  ]) {
    let index = 0;
    const timing = createCompactionTiming(() => pair[index++]);
    startCompactionTiming(timing, 'summaryRequest')();
    assert.equal(snapshotCompactionTiming(timing).valid, false);
    assert.equal(snapshotCompactionTiming(timing).summaryRequestMs, 0);
  }
  let time = 0;
  const timing = createCompactionTiming(() => time);
  for (let index = 0; index < 32; index++) {
    const finish = startCompactionTiming(timing, 'summaryRequest');
    time += 100000000;
    finish();
  }
  const result = snapshotCompactionTiming(timing);
  assert.equal(result.summaryRequestMs, 3600000);
  assert.equal(result.summaryChunkMs.length, 16);
  assert.equal(result.summaryRequests, 16);
  assert.throws(() => createCompactionTiming(1), TypeError);
  assert.throws(() => startCompactionTiming({}, 'planning'), TypeError);
  assert.throws(() => startCompactionTiming(timing, 'SECRET'), TypeError);
  assert.throws(() => snapshotCompactionTiming({ ...timing }), TypeError);
  assert.doesNotThrow(() => startCompactionTiming(undefined, 'planning')());
});
