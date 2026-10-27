'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecoveryFixtureTiming } = require('./helpers/recovery-fixture-timing.cjs');

test('fixture timing retains directory ACL markers and refuses arbitrary phase text', () => {
  let time = 0;
  const trace = createRecoveryFixtureTiming(
    () => time,
    () => null
  );
  trace.mark('worker_started');
  time = 100;
  trace.mark('directory_acl_started');
  time = 5000;
  trace.mark('directory_acl_finished');
  trace.mark('directory_acl_finished/PRIVATE_PATH_SENTINEL');
  assert.deepEqual(trace.snapshot(), [
    { phase: 'worker_started', elapsedMs: 0 },
    { phase: 'directory_acl_started', elapsedMs: 100 },
    { phase: 'directory_acl_finished', elapsedMs: 5000 },
  ]);
});

test('fixture timing distinguishes wall duration from process CPU without exposing data', () => {
  let time = 100,
    usage = { user: 10000, system: 2000 };
  const trace = createRecoveryFixtureTiming(
    () => time,
    () => usage
  );
  trace.mark('opened');
  time += 5000;
  usage = { user: 22000, system: 5000 };
  trace.mark('first_start');
  assert.deepEqual(trace.snapshot(), [
    { phase: 'opened', elapsedMs: 0, cpuUserMs: 0, cpuSystemMs: 0 },
    { phase: 'first_start', elapsedMs: 5000, cpuUserMs: 12, cpuSystemMs: 3 },
  ]);
  usage = { user: 0, system: 0 };
  trace.mark('first_headers');
  assert.deepEqual(trace.snapshot()[2], { phase: 'first_headers', elapsedMs: 5000 });
});

test('invalid CPU observations never execute data accessors or alter fixture operations', () => {
  let touched = 0;
  const accessor = Object.defineProperty({ system: 0 }, 'user', {
    enumerable: true,
    get() {
      touched++;
      return 0;
    },
  });
  for (const sample of [
    null,
    [],
    'PRIVATE_CONTENT',
    {},
    accessor,
    { user: 0, system: -1 },
    { user: 0.5, system: 0 },
    { user: Infinity, system: 0 },
    { user: Number.MAX_SAFE_INTEGER + 1, system: 0 },
    { user: 0, system: 0, extra: 'PRIVATE_CONTENT' },
    Object.create({ user: 0, system: 0 }),
  ]) {
    const trace = createRecoveryFixtureTiming(
      () => 0,
      () => sample
    );
    assert.equal(
      trace.run('load', () => 7),
      7
    );
    assert.deepEqual(trace.snapshot(), [
      { phase: 'storage_load_start', elapsedMs: 0 },
      { phase: 'storage_load_end', elapsedMs: 0 },
    ]);
  }
  const trace = createRecoveryFixtureTiming(
    () => 0,
    () => {
      throw Error('PRIVATE_CONTENT');
    }
  );
  trace.mark('opened');
  assert.deepEqual(trace.snapshot(), [{ phase: 'opened', elapsedMs: 0 }]);
  assert.equal(touched, 0);
});

test('fixture timing preserves sync/async values and exact failures', async () => {
  let time = 0;
  const trace = createRecoveryFixtureTiming(() => time++);
  const value = {};
  const error = Error('PRIVATE_CONTENT');
  assert.equal(
    trace.run('load', () => value),
    value
  );
  assert.equal(await trace.run('save', () => Promise.resolve(value)), value);
  assert.equal(await trace.run('scan', () => Promise.resolve(value)), value);
  assert.throws(
    () =>
      trace.run('catalog', () => {
        throw error;
      }),
    (failure) => failure === error
  );
  await assert.rejects(
    trace.run('revoke', () => Promise.reject(error)),
    (failure) => failure === error
  );
  assert.deepEqual(
    trace.snapshot().map((row) => row.phase),
    [
      'storage_load_start',
      'storage_load_end',
      'storage_save_start',
      'storage_save_end',
      'storage_scan_start',
      'storage_scan_end',
      'storage_catalog_start',
      'storage_catalog_failed',
      'storage_revoke_start',
      'storage_revoke_failed',
    ]
  );
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /PRIVATE_CONTENT/);
});

test('fixture timing rejects unknown phase content, bounds output and detaches snapshots', () => {
  let time = 0;
  const trace = createRecoveryFixtureTiming(() => time++);
  let coerced = 0;
  const hostile = {
    toString() {
      coerced++;
      throw Error('PRIVATE_CONTENT');
    },
  };
  for (const phase of [null, undefined, {}, hostile, 'PRIVATE_CONTENT', '']) trace.mark(phase);
  assert.deepEqual(trace.snapshot(), []);
  trace.mark('opened');
  trace.snapshot()[0].phase = 'PRIVATE_CONTENT';
  assert.equal(trace.snapshot()[0].phase, 'opened');
  trace.run(hostile, () => 1);
  for (let index = 0; index < 300; index++) trace.mark('ready');
  assert.equal(trace.snapshot().length, 256);
  assert.equal(coerced, 0);
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /PRIVATE_CONTENT/);
  assert.ok(
    trace.snapshot().every((row) => Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0)
  );
});

test('invalid or failed observation clocks cannot change operation values or failures', () => {
  for (const now of [
    () => NaN,
    () => Infinity,
    () => Number.MAX_VALUE,
    () => {
      throw Error('PRIVATE_CONTENT');
    },
  ]) {
    const trace = createRecoveryFixtureTiming(now);
    const error = Error('operation failed');
    assert.equal(
      trace.run('inspect', () => 3),
      3
    );
    assert.throws(
      () =>
        trace.run('inspect', () => {
          throw error;
        }),
      (failure) => failure === error
    );
    assert.doesNotMatch(JSON.stringify(trace.snapshot()), /PRIVATE_CONTENT/);
  }
});
