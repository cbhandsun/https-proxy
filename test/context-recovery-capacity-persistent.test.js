'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const {
  exerciseCapacityProfile,
  createCapacityWorkload,
} = require('../scripts/lib/context-recovery-capacity-workload');
const {
  exercisePersistentCapacityProfile,
} = require('../scripts/lib/context-recovery-capacity-persistent');

const safe = { message: 'persistent_capacity_execution_failed' };
const profile = (patch = {}) => ({
  name: 'persistent-fixture',
  roots: 1,
  turns: 2,
  intervalMs: 1000,
  outputBytes: 512,
  reopenEvery: 1,
  recoveries: 2,
  ...patch,
});

function fixture(t, { forgetOnReopen = false, failClose = false } = {}) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'hpm-capacity-driver-test-'));
  const dataKey = randomBytes(32).toString('base64');
  let time = 1000;
  const active = new Set();
  const observed = { opens: 0, closes: 0, offsets: [] };
  t.after(() => {
    for (const close of active) close();
    assert.equal(fs.realpathSync.native(directory), directory);
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('hpm-capacity-driver-test-'));
    fs.rmSync(directory, { recursive: true });
  });
  const options = {
    now: () => time,
    async advance(offsetMs) {
      await new Promise((resolve) => setImmediate(resolve));
      observed.offsets.push(offsetMs);
      time = 1000 + offsetMs;
    },
    async openStorage() {
      observed.opens++;
      const name = forgetOnReopen ? observed.opens + '.sqlite' : 'checkpoint.sqlite';
      const database = new DatabaseSync(path.join(directory, name));
      const owned = { store: undefined };
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        active.delete(close);
        observed.closes++;
        try {
          owned.store?.close();
        } finally {
          database.close();
        }
      };
      active.add(close);
      owned.store = createRecoverySqliteStore({ database, dataKey, now: options.now });
      owned.store.prepareAnchoredFormat();
      return {
        execute: owned.store.execute,
        close() {
          close();
          if (failClose) throw Error('PRIVATE_CLOSE_SENTINEL');
        },
      };
    },
  };
  return { options, observed };
}

test('durable driver runs the same multi-root multipage workload through actual file reopen', async (t) => {
  const f = fixture(t);
  const input = profile({ roots: 2, outputBytes: 32768 });
  const report = await exercisePersistentCapacityProfile(input, f.options);
  assert.deepEqual(report, exerciseCapacityProfile(input));
  assert.equal(report.qualified, true);
  assert.equal(report.completedTurns, 4);
  assert.equal(report.verifiedRecoveries, 4);
  assert.equal(report.reopenCount, 2);
  assert.deepEqual(f.observed, { opens: 3, closes: 3, offsets: [0, 1000] });
});

test('empty/no-read workload keeps final observation and closes the actual store', async (t) => {
  const f = fixture(t);
  const input = profile({ roots: 4, turns: 1, recoveries: 0, outputBytes: 0, reopenEvery: 0 });
  const report = await exercisePersistentCapacityProfile(input, f.options);
  assert.deepEqual(report, exerciseCapacityProfile(input));
  assert.equal(report.finalResultsObserved, true);
  assert.equal(f.observed.opens, 1);
  assert.equal(f.observed.closes, 1);
});

test('losing stored state on reopen cannot qualify by reconstructing an in-memory checkpoint', async (t) => {
  const f = fixture(t, { forgetOnReopen: true });
  const report = await exercisePersistentCapacityProfile(profile(), f.options);
  assert.equal(report.qualified, false);
  assert.equal(report.finalResultsObserved, false);
  assert.ok(report.firstCoverageGap || report.firstFailure);
  assert.equal(f.observed.opens, 2);
  assert.equal(f.observed.closes, 2);
});

test('clock scheduling and final close failures reject with sanitized errors and no retry', async (t) => {
  const f = fixture(t);
  f.options.advance = () => {
    throw Error('PRIVATE_CLOCK_SENTINEL');
  };
  await assert.rejects(exercisePersistentCapacityProfile(profile(), f.options), safe);
  assert.equal(f.observed.opens, 1);
  assert.equal(f.observed.closes, 1);
  const closing = fixture(t, { failClose: true });
  await assert.rejects(
    exercisePersistentCapacityProfile(
      profile({ turns: 1, recoveries: 0, reopenEvery: 0 }),
      closing.options
    ),
    safe
  );
  assert.equal(closing.observed.opens, 1);
  assert.equal(closing.observed.closes, 1);
});

test('invalid profiles and executable option objects reject before acquiring storage', async () => {
  let opened = 0;
  let touched = 0;
  const valid = {
    openStorage: () => {
      opened++;
    },
    now: () => 1000,
    advance: () => {},
  };
  for (const input of [
    null,
    {},
    profile({ roots: 5 }),
    profile({ turns: 481 }),
    profile({ outputBytes: -1 }),
  ])
    await assert.rejects(exercisePersistentCapacityProfile(input, valid), {
      message: 'invalid_capacity_profile',
    });
  const getter = Object.defineProperty({ now: valid.now, advance: valid.advance }, 'openStorage', {
    enumerable: true,
    get() {
      touched++;
      return valid.openStorage;
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        return [];
      },
    }
  );
  for (const options of [
    null,
    {},
    getter,
    proxy,
    { ...valid, extra: true },
    { ...valid, now: async () => 1000 },
    { ...valid, advance: new Proxy(() => {}, {}) },
  ])
    await assert.rejects(exercisePersistentCapacityProfile(profile(), options), safe);
  assert.equal(opened, 0);
  assert.equal(touched, 0);
});

test('failed storage admission closes its plain owned capability without evaluating getters', async () => {
  let closes = 0;
  let touched = 0;
  for (const opened of [
    {
      execute: 0,
      close() {
        closes++;
      },
    },
    Object.defineProperty(
      {
        close() {
          closes++;
        },
      },
      'execute',
      {
        enumerable: true,
        get() {
          touched++;
          return () => {};
        },
      }
    ),
  ]) {
    await assert.rejects(
      exercisePersistentCapacityProfile(profile(), {
        now: () => 1000,
        advance: () => {},
        openStorage: () => opened,
      }),
      safe
    );
  }
  assert.equal(closes, 2);
  assert.equal(touched, 0);
});

test('the shared workload always yields its close boundary when an executor throws', () => {
  const work = createCapacityWorkload(profile());
  assert.equal(work.next().value.operation, 'open');
  const failure = Error('synthetic executor failure');
  assert.equal(work.throw(failure).value.operation, 'close');
  assert.throws(
    () => work.next(),
    (error) => error === failure
  );
});

test('abort-refusal cannot become successful final observation when shutdown still succeeds', async () => {
  const file = path.resolve(__dirname, '../scripts/lib/context-recovery-capacity-persistent.js');
  const originalRequire = createRequire(file);
  const observed = { completed: 0, aborted: 0, closed: 0 };
  const runtime = {
    configureAsync: async () => ({ ok: true }),
    shutdownAsync: async () => ({ ok: true }),
    async beginAsync() {
      return {
        ok: true,
        snapshotId: 'synthetic-root',
        inspect: () => ({ visibleSources: observed.completed }),
        completeObservedAsync: async () => {
          observed.completed++;
          return { ok: true };
        },
        abortAsync: async () => {
          observed.aborted++;
          return { ok: false, code: 'context_recovery_storage_unavailable' };
        },
      };
    },
  };
  const module = { exports: {} };
  const load = vm.runInThisContext(
    '(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})',
    { filename: file }
  );
  load(
    (name) =>
      name === '../../lib/proxy/context-recovery-sessions'
        ? {
            createContextRecoverySessions: () => runtime,
            initializeContextRecoveryStorage: async () => ({ ok: true }),
          }
        : originalRequire(name),
    module,
    module.exports
  );
  await assert.rejects(
    module.exports.exercisePersistentCapacityProfile(
      profile({ turns: 1, recoveries: 0, reopenEvery: 0 }),
      {
        now: () => 1000,
        advance: () => {},
        openStorage: () => ({
          execute() {},
          close() {
            observed.closed++;
          },
        }),
      }
    ),
    safe
  );
  assert.deepEqual(observed, { completed: 1, aborted: 1, closed: 1 });
});
