'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const {
  exerciseRecovery,
  exerciseRecoveryAsync,
} = require('../scripts/lib/nsis-recovery-fixture-state');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { createWorkerStartupEvidence } = require('../scripts/lib/nsis-worker-startup-evidence');
const api = {
  sessions: require('../lib/proxy/context-recovery-sessions'),
  ...require('../lib/proxy/context-recovery-root-checkpoint'),
  ...require('../lib/proxy/context-recovery-storage-record'),
  LIST: require('../lib/proxy/context-evidence-tools').LIST_EVIDENCE_TOOL,
  READ: require('../lib/proxy/context-evidence-tools').READ_EVIDENCE_TOOL,
};

test('async fixture uses the same real encrypted state, operations, budget and original expiry', async () => {
  const database = new DatabaseSync(':memory:');
  const store = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
  });
  const operations = [];
  const storage = {
    async execute(request) {
      operations.push(request.operation);
      return store.execute(request);
    },
  };
  try {
    const seed = await exerciseRecoveryAsync(api, storage, 'seed');
    assert.deepEqual(await exerciseRecoveryAsync(api, storage, 'resave'), seed);
    assert.deepEqual(await exerciseRecoveryAsync(api, storage, 'read'), seed);
    assert.deepEqual(exerciseRecovery(api, store, 'read'), seed);
    assert.deepEqual(operations, [
      'save',
      'catalog',
      'load',
      'catalog',
      'load',
      'save',
      'catalog',
      'load',
    ]);
  } finally {
    store.close();
    database.close();
  }
});

test('async fixture refuses non-promises and hostile thenables without hooks or additional operations', async () => {
  let hooks = 0;
  const thenable = {
    get then() {
      hooks++;
      return () => {};
    },
  };
  const accessor = Promise.resolve([]);
  Object.defineProperty(accessor, 'constructor', {
    get() {
      hooks++;
      return Promise;
    },
  });
  for (const value of [
    null,
    [],
    {},
    thenable,
    accessor,
    new Proxy(
      {},
      {
        get() {
          hooks++;
          return null;
        },
      }
    ),
  ]) {
    let calls = 0;
    await assert.rejects(
      exerciseRecoveryAsync(
        api,
        {
          execute() {
            calls++;
            return value;
          },
        },
        'read'
      )
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(exerciseRecoveryAsync(api, { execute: async () => [] }, 'read'));
  await assert.rejects(
    exerciseRecoveryAsync(api, { execute: () => assert.fail('unexpected query') }, 'unknown')
  );
  assert.equal(hooks, 0);
});

test('async save rejection propagates and closes the actual memory session without retries', async () => {
  let closed = 0,
    calls = 0;
  const cause = new Error('synthetic_write_failure');
  const wrapped = {
    ...api,
    sessions: {
      ...api.sessions,
      createContextRecoverySessions() {
        const runtime = api.sessions.createContextRecoverySessions();
        const close = runtime.close;
        runtime.close = () => {
          closed++;
          return close();
        };
        return runtime;
      },
    },
  };
  await assert.rejects(
    exerciseRecoveryAsync(
      wrapped,
      {
        async execute() {
          calls++;
          throw cause;
        },
      },
      'seed'
    ),
    (error) => error === cause
  );
  assert.equal(calls, 1);
  assert.equal(closed, 1);
});

test('worker evidence distinguishes actual ready and schema refusal from native startup failures', () => {
  for (const refused of [false, true]) {
    const evidence = createWorkerStartupEvidence();
    for (const phase of [
      'worker_started',
      'key_unprotect_finished',
      'database_opened',
      'engine_anchor_validate_started',
      ...(refused ? ['failed'] : ['engine_anchor_validate_finished', 'engine_ready', 'ready']),
    ])
      evidence.observe({ phase });
    assert.equal(evidence.receipt(refused).refused, refused);
    assert.equal(evidence.receipt(refused).nativeKeyCompleted, true);
  }
  for (const phases of [
    [],
    ['worker_started', 'failed'],
    ['worker_started', 'database_opened', 'failed'],
    ['worker_started', 'key_unprotect_finished', 'database_opened', 'engine_ready', 'failed'],
    [
      'worker_started',
      'key_unprotect_finished',
      'database_opened',
      'anchor_persist_started',
      'failed',
    ],
    ['worker_started', 'worker_started', 'key_unprotect_finished', 'database_opened', 'failed'],
  ]) {
    const evidence = createWorkerStartupEvidence();
    for (const phase of phases) evidence.observe({ phase });
    assert.throws(() => evidence.receipt(true));
  }
  let hooks = 0;
  const evidence = createWorkerStartupEvidence();
  evidence.observe({
    get phase() {
      hooks++;
      return 'ready';
    },
  });
  evidence.observe(
    new Proxy(
      {},
      {
        get() {
          hooks++;
          return 'ready';
        },
      }
    )
  );
  assert.throws(() => evidence.receipt(false));
  assert.equal(hooks, 0);
});

test('worker refusal verifies the exact old/new format before opening and releases physical SQLite locks', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const { DatabaseSync } = require('node:sqlite');
  const {
    assertRefusalLayout,
    verifyReleasedLocks,
  } = require('../scripts/lib/nsis-worker-recovery-driver');
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'worker-refusal-')
  );
  const file = path.join(directory, 'checkpoint.sqlite');
  const database = new DatabaseSync(file);
  const writer = new DatabaseSync(path.join(directory, '.writer.sqlite'));
  t.after(() => {
    database.close();
    writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const version of [0, 1, 2, 3, 4, 2147483647]) {
    database.exec(`PRAGMA user_version=${version}`);
    const before = hash();
    for (const operation of ['refuse-legacy', 'refuse-new-format']) {
      const check = () => assertRefusalLayout(directory, operation);
      if (operation === 'refuse-legacy' ? [1, 2].includes(version) : version === 3) check();
      else assert.throws(check);
    }
    assert.equal(hash(), before);
  }
  verifyReleasedLocks(directory);
  writer.exec('BEGIN EXCLUSIVE');
  assert.throws(() => verifyReleasedLocks(directory));
  writer.exec('ROLLBACK');
  database.exec('BEGIN EXCLUSIVE');
  assert.throws(() => verifyReleasedLocks(directory));
  database.exec('ROLLBACK');
  verifyReleasedLocks(directory);
  const missing = path.join(directory, 'missing');
  fs.mkdirSync(missing);
  assert.throws(() => assertRefusalLayout(missing, 'refuse-new-format'));
  assert.equal(fs.existsSync(path.join(missing, 'checkpoint.sqlite')), false);
});
