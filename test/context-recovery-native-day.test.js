'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { CAPACITY_PROFILES } = require('../scripts/lib/context-recovery-capacity-workload');
const { declareCapacityFailure } = require('../scripts/lib/context-recovery-capacity-failure');

function fixture(mode) {
  const filename = path.resolve(__dirname, '../scripts/lib/context-recovery-native-day.js');
  const original = createRequire(filename);
  const calls = [];
  const receipts = [];
  let opened = 0;
  let identities = 0;
  let scheduledMs = 0;
  const fail = () => {
    throw Error('PRIVATE_DAY_SENTINEL');
  };
  const clock = {
    now: () => 1000 + scheduledMs,
    async advance(offset) {
      scheduledMs = offset;
      calls.push(['advance', offset]);
      if (mode === 'clock-advance-failure') fail();
    },
    inspect: () => ({ started: true, elapsedMs: scheduledMs, scheduledMs, maximumLatenessMs: 0 }),
  };
  const witness = {
    now: clock.now,
    observeCatalog() {
      calls.push('observe');
      if (mode === 'catalog') fail();
    },
    inspect: () => ({ rootsObserved: 1 }),
    async waitForExpiry() {
      calls.push('wait');
      if (mode === 'wait') fail();
    },
    async assertExpired() {
      calls.push('expired');
      if (mode === 'expired') fail();
    },
  };
  const expected = {
    profile: CAPACITY_PROFILES[0],
    completedTurns: 288,
    verifiedRecoveries: 24,
    reopenCount: 12,
    finalResultsObserved: true,
    firstCoverageGap: null,
    firstReadFailure: null,
    firstFailure: null,
    qualified: true,
  };
  const mocks = {
    // VM arrays have a different prototype. Bridge only this test realm before
    // invoking the actual strict report parser; production stays in one realm.
    './context-recovery-capacity-parallel': {
      parseCapacityReports: (reports, indexes) =>
        original('./context-recovery-capacity-parallel').parseCapacityReports(
          JSON.parse(JSON.stringify(reports)),
          Array.from(indexes)
        ),
    },
    './context-recovery-diagnostic-identity': {
      diagnosticIdentity() {
        identities++;
        return {
          head: mode === 'identity' && identities >= 4 ? 'changed' : 'original',
          sourceSha256: 'source',
          nativeSha256: mode === 'missing' ? null : 'native',
          nodeSha256: 'node',
        };
      },
    },
    './context-recovery-capacity-clock': { createCapacityRealtimeClock: () => clock },
    './context-recovery-capacity-retention': { createCapacityRetentionWitness: () => witness },
    '../../lib/proxy/context-recovery-storage': {
      async openContextRecoveryStorage(options) {
        calls.push('open');
        opened++;
        if (mode === 'open') fail();
        assert.deepEqual(Object.keys(options), ['directory', 'onFailure', 'onStartup']);
        options.onStartup({ phase: 'worker_started', elapsedMs: 0 });
        if (mode === 'failure-observer')
          options.onFailure({
            operation: 'read-source-and-settle',
            phase: 'anchor-persist',
            cleanupFailed: true,
          });
        return {
          execute: async (request) => {
            assert.equal(request.operation, 'catalog');
            return [];
          },
          async close() {
            calls.push('close');
            if (mode === 'close') fail();
          },
        };
      },
    },
    './context-recovery-capacity-persistent': {
      async exercisePersistentCapacityProfile(profile, options, onFirstFailure) {
        assert.equal(profile, CAPACITY_PROFILES[0]);
        assert.deepEqual(Object.keys(options).sort(), ['advance', 'now', 'openStorage']);
        if (mode === 'driver') fail();
        if (mode === 'driver-diagnostic')
          throw declareCapacityFailure(
            Error('PRIVATE_DRIVER_EXCEPTION'),
            { operation: 'begin', stage: 'begin', commandIndex: 23, scheduledMs: 1800000 },
            { operation: 'close', stage: 'storage-close', commandIndex: 24, scheduledMs: 1800000 }
          );
        for (let index = 0; index < (mode === 'count' ? 12 : 13); index++) {
          const storage = await options.openStorage();
          try {
            if (index === 0) await options.advance(0);
            if (mode === 'live-driver-diagnostic') {
              await options.advance(1800000);
              onFirstFailure?.(
                declareCapacityFailure(
                  {},
                  {
                    operation: 'reply',
                    stage: 'reply',
                    commandIndex: 23,
                    scheduledMs: 1800000,
                  }
                )
              );
              await options.advance(2100000);
              return { ...expected, qualified: false };
            }
            if (index === 12) await options.advance(86100000);
          } finally {
            await storage.close();
          }
        }
        if (mode === 'report-diagnostic')
          return declareCapacityFailure(
            { ...expected, qualified: false },
            { operation: 'complete', stage: 'complete', commandIndex: 18, scheduledMs: 1800000 }
          );
        return mode === 'report' ? { ...expected, completedTurns: 287 } : expected;
      },
    },
  };
  const target = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      module: target,
      process: { platform: 'win32' },
      require: (name) => mocks[name] || original(name),
    },
    { filename }
  );
  return {
    calls,
    receipts,
    opened: () => opened,
    run: () =>
      target.exports.runNativeCapacityDay('/unused-native-day', (event) => {
        receipts.push(event);
      }),
  };
}

test('day orchestration preserves frozen profile, finishes the actual day and expiry witness before two reopen checks', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.realtime24hPassed, true);
  assert.equal(result.storeOpens, 15);
  assert.equal(result.storeCloses, 15);
  assert.equal(result.realModelRequests, 0);
  assert.deepEqual(f.calls.filter(Array.isArray), [
    ['advance', 0],
    ['advance', 86100000],
    ['advance', 86400000],
  ]);
  const wait = f.calls.indexOf('wait');
  assert.equal(f.calls.slice(0, wait).filter((v) => v === 'close').length, 13);
  assert.deepEqual(f.calls.slice(wait), [
    'wait',
    'open',
    'expired',
    'close',
    'open',
    'expired',
    'close',
  ]);
  assert.equal(f.receipts.filter((r) => r.event === 'native_day_started').length, 1);
  assert.equal(f.receipts.at(-1).event, 'native_day_completed');
});

test('native, catalog, deadline-wait, close and identity failures cannot qualify or retry', async () => {
  for (const mode of [
    'open',
    'catalog',
    'close',
    'identity',
    'driver',
    'report',
    'count',
    'wait',
    'expired',
  ]) {
    const f = fixture(mode);
    await assert.rejects(f.run(), { message: 'native_capacity_day_failed' }, mode);
    assert.equal(
      f.receipts.some((r) => r.event === 'native_day_completed'),
      false,
      mode
    );
    assert.equal(f.receipts.at(-1).event, 'native_day_failed', mode);
    assert.equal(JSON.stringify(f.receipts).includes('PRIVATE_DAY_SENTINEL'), false);
    if (['open', 'catalog', 'close'].includes(mode)) assert.equal(f.opened(), 1);
    if (['report', 'count'].includes(mode)) assert.equal(f.calls.includes('wait'), false);
    if (mode === 'wait') assert.equal(f.opened(), 13);
    if (mode === 'expired') assert.equal(f.opened(), 14);
    if (mode === 'catalog') assert.equal(f.calls.filter((v) => v === 'close').length, 1);
  }
});

test('missing native helper refuses before starting the workload', async () => {
  const f = fixture('missing');
  await assert.rejects(f.run(), { message: 'native_capacity_day_failed' });
  assert.equal(f.opened(), 0);
  assert.equal(
    f.receipts.some((r) => r.event === 'native_day_started'),
    false
  );
});

test('day failure emits only branded fixed driver stages and never the original exception', async () => {
  const f = fixture('driver-diagnostic');
  await assert.rejects(f.run(), { message: 'native_capacity_day_failed' });
  const event = f.receipts.at(-1);
  assert.equal(event.event, 'native_day_failed');
  assert.equal(event.stage, 'capacity');
  assert.deepEqual(
    { ...event.driverFailure.primary },
    { operation: 'begin', stage: 'begin', commandIndex: 23, scheduledMs: 1800000 }
  );
  assert.deepEqual(
    { ...event.driverFailure.cleanup },
    { operation: 'close', stage: 'storage-close', commandIndex: 24, scheduledMs: 1800000 }
  );
  assert.equal(JSON.stringify(f.receipts).includes('PRIVATE'), false);
  assert.equal(f.opened(), 0);
});

test('day preserves branded driver failure metadata even when report validation rejects', async () => {
  const f = fixture('report-diagnostic');
  await assert.rejects(f.run(), { message: 'native_capacity_day_failed' });
  const event = f.receipts.at(-1);
  assert.equal(event.driverFailure.primary.stage, 'complete');
  assert.equal(event.driverFailure.primary.commandIndex, 18);
  assert.equal(f.calls.includes('wait'), false);
  assert.equal(
    f.receipts.some((item) => item.event === 'native_day_completed'),
    false
  );
});

test('day forwards bounded storage failure phases without inspecting the original exception', async () => {
  const f = fixture('failure-observer');
  await assert.rejects(f.run(), { message: 'native_capacity_day_failed' });
  assert.equal(f.calls.filter((v) => v === 'close').length, 1);
  assert.equal(f.calls.some(Array.isArray), false);
  assert.equal(
    f.receipts.some((v) => v.event === 'native_day_completed'),
    false
  );
  const failures = f.receipts.filter((value) => value.event === 'storage_operation_failed');
  assert.equal(failures.length, 1);
  assert.deepEqual(Object.keys(failures[0]), [
    'event',
    'stage',
    'attempt',
    'operation',
    'phase',
    'cleanupFailed',
  ]);
  assert.equal(failures[0].operation, 'read-source-and-settle');
  assert.equal(failures[0].phase, 'anchor-persist');
  assert.equal(failures[0].cleanupFailed, true);
  assert.equal(JSON.stringify(failures).includes('PRIVATE'), false);
});

test('first live driver failure is visible before another scheduled wait and still closes storage', async () => {
  const f = fixture('live-driver-diagnostic');
  await assert.rejects(f.run(), { message: 'native_capacity_day_failed' });
  assert.deepEqual(f.calls.filter(Array.isArray), [
    ['advance', 0],
    ['advance', 1800000],
  ]);
  assert.equal(f.calls.filter((v) => v === 'close').length, 1);
  assert.equal(f.calls.includes('wait'), false);
  const first = f.receipts.find((v) => v.event === 'native_day_failed');
  assert.equal(first.driverFailure.primary.scheduledMs, 1800000);
  assert.equal(first.storeCloses, 0);
  assert.equal(f.receipts.at(-1).storeCloses, 1);
  assert.equal(
    f.receipts.some((v) => v.event === 'native_day_completed'),
    false
  );
});

test('day reports a bounded advance phase before cleanup and never waits again', async () => {
  const f = fixture('clock-advance-failure');
  await assert.rejects(f.run(), { message: 'native_capacity_day_failed' });
  const first = f.receipts.find((event) => event.event === 'native_day_failed');
  assert.deepEqual({ ...first.advanceFailure }, { phase: 'wait', scheduledMs: 0 });
  assert.equal(first.storeOpens, 1);
  assert.equal(first.storeCloses, 0);
  assert.equal(f.receipts.at(-1).storeCloses, 1);
  assert.deepEqual(f.calls.filter(Array.isArray), [['advance', 0]]);
  assert.equal(
    f.receipts.some((event) => event.event === 'native_day_completed'),
    false
  );
  assert.equal(JSON.stringify(f.receipts).includes('PRIVATE'), false);
});
