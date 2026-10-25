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
  const file = path.resolve(__dirname, '../scripts/lib/context-recovery-native-prefix.js');
  const original = createRequire(file);
  const calls = [],
    events = [];
  let opened = 0,
    closed = 0,
    identities = 0,
    observes = 0,
    offset = 0;
  const privateFailure = () => {
    throw Error('PRIVATE_PREFIX_EXCEPTION');
  };
  const clock = {
    now: () => 1000 + offset,
    async advance(ms) {
      calls.push(['advance', ms]);
      offset = ms;
      if (mode === 'broken-clock') privateFailure();
    },
    inspect: () => {
      if (mode === 'broken-clock') privateFailure();
      return {
        started: true,
        scheduledMs: offset,
        elapsedMs: mode === 'short-time' ? offset - 1 : mode === 'bad-time' ? NaN : offset,
        maximumLatenessMs: 0,
      };
    },
  };
  const mocks = {
    './context-recovery-diagnostic-identity': {
      diagnosticIdentity() {
        identities++;
        return {
          head: mode === 'identity' && identities >= 3 ? 'changed' : 'source',
          sourceSha256: 'source-hash',
          nodeSha256: 'node-hash',
          nativeSha256: mode === 'missing-native' ? null : 'native-hash',
          storageResolvedToCheckout: mode !== 'wrong-loader',
          storageExports: ['openContextRecoveryStorage', 'validateStorageResult'],
        };
      },
    },
    './context-recovery-capacity-clock': { createCapacityRealtimeClock: () => clock },
    './context-recovery-capacity-retention': {
      createCapacityRetentionWitness: () => ({
        now: clock.now,
        observeCatalog() {
          observes++;
          calls.push('catalog');
          if (mode === 'catalog' || (mode === 'reopen-catalog' && observes === 2)) privateFailure();
        },
        inspect: () => ({
          rootsObserved: 1,
          minRootExpiresAt: 86401000,
          maxRootExpiresAt: 86401000,
          expiryWaitCompleted: false,
        }),
      }),
    },
    '../../lib/proxy/context-recovery-storage': {
      async openContextRecoveryStorage(options) {
        opened++;
        calls.push('open');
        if (mode === 'open') privateFailure();
        assert.deepEqual(Object.keys(options), ['directory', 'onStartup']);
        options.onStartup({ phase: 'worker_started', elapsedMs: 0 });
        return {
          execute: async (request) => {
            assert.equal(request.operation, 'catalog');
            return [
              {
                scope: 'a'.repeat(64),
                revision: mode === 'reopen-revision' && opened === 2 ? 2 : 1,
                createdAt: 1000,
                expiresAt: mode === 'reopen-expiry' && opened === 2 ? 86400999 : 86401000,
              },
            ];
          },
          async close() {
            closed++;
            calls.push('close');
            if (mode === 'close' || (mode === 'reopen-close' && closed === 2)) privateFailure();
          },
        };
      },
    },
    './context-recovery-capacity-persistent': {
      async exercisePersistentCapacityProfile(profile, options) {
        assert.equal(profile, CAPACITY_PROFILES[0]);
        assert.deepEqual(Object.keys(options).sort(), ['advance', 'now', 'openStorage']);
        if (mode === 'driver') privateFailure();
        if (mode === 'early-return') return { qualified: true };
        const storage = await options.openStorage();
        let rejected;
        try {
          if (mode === 'wrong-offset') await options.advance(300000);
          for (let index = 0; index < 7; index++) await options.advance(index * 300000);
          await options.advance(2100000);
        } catch (error) {
          rejected = error;
        }
        let cleanup;
        try {
          await storage.close();
        } catch {
          cleanup = {
            operation: 'close',
            stage: 'storage-close',
            commandIndex: 24,
            scheduledMs: 2100000,
          };
        }
        if (mode === 'unbranded') throw rejected;
        const primary = {
          operation: mode === 'wrong-stage' ? 'begin' : 'advance',
          stage: mode === 'wrong-stage' ? 'begin' : 'advance',
          commandIndex: mode === 'wrong-index' ? 22 : 23,
          scheduledMs: 2100000,
        };
        throw declareCapacityFailure(Error('PRIVATE_DRIVER_ERROR'), primary, cleanup);
      },
    },
  };
  const loaded = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(file, 'utf8'),
    {
      module: loaded,
      process: { platform: 'win32' },
      require: (name) => mocks[name] || original(name),
    },
    { filename: file }
  );
  return {
    calls,
    events,
    opened: () => opened,
    closed: () => closed,
    run: (
      emit = (value) => {
        events.push(value);
      }
    ) => loaded.exports.runNativeCapacityPrefix('/unused-native-prefix', emit),
  };
}

test('prefix keeps the frozen profile, seven real-clock advances and exact deliberate boundary, then reopens once', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.prefixCompleted, true);
  assert.equal(result.fullCapacityQualified, false);
  assert.equal(result.realtime24hStarted, false);
  assert.equal(result.realtime24hPassed, false);
  assert.equal(result.storeOpens, 2);
  assert.equal(result.storeCloses, 2);
  assert.equal(result.realModelRequests, 0);
  assert.equal(result.clock.elapsedMs, 1800000);
  assert.deepEqual(
    f.calls.filter(Array.isArray),
    Array.from({ length: 7 }, (_, i) => ['advance', i * 300000])
  );
  assert.deepEqual(
    f.calls.filter((v) => !Array.isArray(v)),
    ['open', 'catalog', 'close', 'open', 'catalog', 'close']
  );
  assert.equal(f.events.at(-1).event, 'native_prefix_completed');
  assert.equal(JSON.stringify(f.events).includes('PRIVATE'), false);
});

test('early, unbranded, incorrect or failed cleanup boundaries never qualify a prefix or retry', async () => {
  for (const mode of [
    'open',
    'driver',
    'early-return',
    'unbranded',
    'wrong-stage',
    'wrong-index',
    'wrong-offset',
    'catalog',
    'close',
    'identity',
    'short-time',
    'bad-time',
    'broken-clock',
    'reopen-catalog',
    'reopen-close',
    'reopen-revision',
    'reopen-expiry',
  ]) {
    const f = fixture(mode);
    await assert.rejects(f.run(), { message: 'native_capacity_prefix_failed' }, mode);
    assert.equal(
      f.events.some((e) => e.event === 'native_prefix_completed'),
      false,
      mode
    );
    assert.equal(f.events.at(-1).event, 'native_prefix_failed', mode);
    assert.equal(JSON.stringify(f.events).includes('PRIVATE'), false, mode);
    assert.ok(f.opened() <= 2, mode);
    assert.ok(f.closed() <= 2, mode);
    if (mode === 'broken-clock')
      assert.equal(f.events.at(-1).driverFailure.primary.operation, 'advance');
  }
});

test('missing native identity and executable observers fail before opening storage without disclosure', async () => {
  for (const mode of ['missing-native', 'wrong-loader']) {
    const missing = fixture(mode);
    await assert.rejects(missing.run(), { message: 'native_capacity_prefix_failed' });
    assert.equal(missing.opened(), 0);
  }
  for (const emit of [
    null,
    async () => {},
    function* () {},
    new Proxy(() => {}, {
      apply() {
        throw Error('PRIVATE');
      },
    }),
  ]) {
    const f = fixture();
    await assert.rejects(f.run(emit), { message: 'native_capacity_prefix_failed' });
    assert.equal(f.opened(), 0);
  }
  for (const emit of [
    () => {
      throw Error('PRIVATE');
    },
    () => Promise.reject(Error('PRIVATE')),
  ]) {
    const f = fixture();
    await assert.rejects(f.run(emit), { message: 'native_capacity_prefix_failed' });
    assert.equal(f.opened(), 0);
  }
});

test('prefix workflow has a single disposable fixed run and cannot upload private artifacts or restart the day', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/windows-native-prefix-diagnostic.yml'),
    'utf8'
  );
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /node-version: 22/);
  assert.equal(
    workflow.match(/node scripts\/diagnose-context-recovery-native-prefix\.js/g).length,
    1
  );
  assert.doesNotMatch(
    workflow,
    /upload-artifact|secrets\.|qualify-context-recovery-native-day|frozen-20261024|continue-on-error|retry/i
  );
});

test('actual shared executor and file SQLite accept only the intended prefix boundary and reopen at original expiry', async (t) => {
  const os = require('node:os');
  const { randomBytes } = require('node:crypto');
  const { DatabaseSync } = require('node:sqlite');
  const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
  const { createCapacityRealtimeClock } = require('../scripts/lib/context-recovery-capacity-clock');
  const file = path.resolve(__dirname, '../scripts/lib/context-recovery-native-prefix.js');
  const original = createRequire(file);
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'hpm-prefix-executor-'));
  const key = randomBytes(32).toString('base64');
  const active = new Set();
  t.after(() => {
    for (const close of active) close();
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true });
  });
  let wall = 1000,
    monotonic = 0,
    opens = 0,
    closes = 0;
  const clock = createCapacityRealtimeClock({
    wall: () => wall,
    monotonic: () => monotonic,
    sleep: async (duration) => {
      wall += duration;
      monotonic += duration;
    },
  });
  const overrides = {
    './context-recovery-capacity-clock': { createCapacityRealtimeClock: () => clock },
    './context-recovery-diagnostic-identity': {
      diagnosticIdentity: () => ({
        head: 'synthetic',
        sourceSha256: 'source',
        nativeSha256: 'synthetic-not-native',
        storageResolvedToCheckout: true,
        storageExports: ['openContextRecoveryStorage', 'validateStorageResult'],
        nodeSha256: 'node',
      }),
    },
    '../../lib/proxy/context-recovery-storage': {
      async openContextRecoveryStorage() {
        opens++;
        const database = new DatabaseSync(path.join(root, 'checkpoint.sqlite'));
        const store = createRecoverySqliteStore({ database, dataKey: key, now: clock.now });
        store.prepareAnchoredFormat();
        const close = () => {
          if (!active.delete(close)) return;
          try {
            store.close();
          } finally {
            database.close();
            closes++;
          }
        };
        active.add(close);
        return { execute: store.execute, close };
      },
    },
  };
  const loaded = { exports: {} };
  const load = vm.runInThisContext(
    '(function(require,module,exports,process){' + fs.readFileSync(file, 'utf8') + '\n})',
    { filename: file }
  );
  load((name) => overrides[name] || original(name), loaded, loaded.exports, { platform: 'win32' });
  const events = [];
  const result = await loaded.exports.runNativeCapacityPrefix(
    path.join(root, 'unused-context'),
    (value) => {
      events.push(value);
    }
  );
  assert.equal(result.prefixCompleted, true);
  assert.equal(result.realtime24hPassed, false);
  assert.equal(result.fullCapacityQualified, false);
  assert.equal(result.storeOpens, 2);
  assert.equal(result.storeCloses, 2);
  assert.equal(opens, 2);
  assert.equal(closes, 2);
  assert.equal(result.retention.minRootExpiresAt, 86401000);
  assert.equal(result.retention.maxRootExpiresAt, 86401000);
  assert.equal(events.filter((value) => value.event === 'native_prefix_tick').length, 6);
  assert.equal(events.at(-1).event, 'native_prefix_completed');
});
