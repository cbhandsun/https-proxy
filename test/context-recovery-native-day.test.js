'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { CAPACITY_PROFILES } = require('../scripts/lib/context-recovery-capacity-workload');

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
    },
    inspect: () => ({ elapsedMs: scheduledMs, scheduledMs }),
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
        assert.deepEqual(Object.keys(options), ['directory', 'onStartup']);
        options.onStartup({ phase: 'worker_started', elapsedMs: 0 });
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
      async exercisePersistentCapacityProfile(profile, options) {
        assert.equal(profile, CAPACITY_PROFILES[0]);
        assert.deepEqual(Object.keys(options).sort(), ['advance', 'now', 'openStorage']);
        if (mode === 'driver') fail();
        for (let index = 0; index < (mode === 'count' ? 12 : 13); index++) {
          const storage = await options.openStorage();
          if (index === 0) await options.advance(0);
          if (index === 12) await options.advance(86100000);
          await storage.close();
        }
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
      target.exports.runNativeCapacityDay('/unused-native-day', (event) => receipts.push(event)),
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
