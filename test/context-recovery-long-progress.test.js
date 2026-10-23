'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLongRecoveryProgress,
  parseLongRecoveryProgress,
} = require('./helpers/recovery-long-progress.cjs');

test('long recovery progress emits only fixed stages and nonnegative integer durations', () => {
  let time = 10;
  const lines = [];
  const report = createLongRecoveryProgress(
    (line) => lines.push(line),
    () => time
  );
  report('module_load_started');
  time = 12.4;
  report('store_open_finished');
  time = 30;
  report('store_close_finished');
  assert.deepEqual(parseLongRecoveryProgress(lines.join('')), [
    { stage: 'module_load_started', elapsedMs: 0 },
    { stage: 'store_open_finished', elapsedMs: 2 },
    { stage: 'store_close_finished', elapsedMs: 20 },
  ]);
  assert.throws(() => report('private-value'), /invalid_long_recovery_progress/);
  assert.equal(lines.length, 3);
});

test('long recovery stderr parsing discards unknown, oversized and hostile content', () => {
  let touched = 0;
  const hook = () => {
    touched++;
    throw new Error('private-value');
  };
  for (const input of [
    undefined,
    null,
    {},
    { toString: hook },
    new Proxy({}, { get: hook }),
    '',
    'x'.repeat(8193),
    'HPM_LONG_STAGE private_value 1',
    'HPM_LONG_STAGE store_open_started -1',
    'HPM_LONG_STAGE store_open_started Infinity',
    'HPM_LONG_STAGE store_open_started 1.5',
    'HPM_LONG_STAGE store_open_started 9007199254740992',
    'HPM_LONG_STAGE store_open_started 1 private-value',
  ])
    assert.deepEqual(parseLongRecoveryProgress(input), []);
  assert.equal(touched, 0);
  assert.deepEqual(
    parseLongRecoveryProgress('private-value\r\nHPM_LONG_STAGE read_finished 42\r\n'),
    [{ stage: 'read_finished', elapsedMs: 42 }]
  );
  assert.deepEqual(parseLongRecoveryProgress('HPM_LONG_STAGE read_finished 9007199254740991'), [
    { stage: 'read_finished', elapsedMs: Number.MAX_SAFE_INTEGER },
  ]);
});

test('long recovery observation rejects invalid clocks and preserves writer failure', () => {
  for (const invalid of [null, undefined, 1, {}])
    assert.throws(() => createLongRecoveryProgress(invalid), /invalid_long_recovery_progress/);
  for (const value of [NaN, Infinity, -Infinity])
    assert.throws(
      () =>
        createLongRecoveryProgress(
          () => {},
          () => value
        ),
      /invalid_long_recovery_progress/
    );
  let time = 10;
  const observe = createLongRecoveryProgress(
    () => {},
    () => time
  );
  for (const value of [0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 100]) {
    time = value;
    assert.throws(() => observe('read_started'), /invalid_long_recovery_progress/);
  }
  const error = new Error('writer_failed');
  const report = createLongRecoveryProgress(
    () => {
      throw error;
    },
    () => 0
  );
  assert.throws(
    () => report('read_started'),
    (cause) => cause === error
  );
});
