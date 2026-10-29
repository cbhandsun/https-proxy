'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runRecoverySweepCrash } = require('./helpers/context-recovery-sweep-process.cjs');
const { Worker } = require('node:worker_threads');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { storageRequest } = require('../lib/proxy/context-recovery-storage-contract');
const { validateStorageResult } = require('../lib/proxy/context-recovery-storage');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const { RECOVERY_DIRECTORY_BYTES } = require('../lib/proxy/context-recovery-storage-quota');
const { recoverySqliteFaults } = require('./helpers/recovery-sqlite-fault.cjs');

const scope = (n) => n.toString(16).padStart(64, '0');
const request = (n, expiresAt = 1000) => ({
  operation: 'save',
  scope: scope(n),
  expectedRevision: 0,
  expiresAt,
  state: { synthetic: 'exact\r\nUnicode🙂', budget: { calls: 7 } },
});
const safe = (error) => {
  assert.equal(error.code, 'context_recovery_storage_unavailable');
  assert.equal(error.message, error.code);
  assert.equal(error.cause, undefined);
  return true;
};
function memory(afterWrite = () => {}) {
  const database = new DatabaseSync(':memory:');
  const dataKey = randomBytes(32).toString('base64');
  let time = 100;
  const engineDatabase = recoverySqliteFaults(database, afterWrite);
  let store = createRecoverySqliteStore({ database: engineDatabase, dataKey, now: () => time });
  return {
    database,
    dataKey,
    get store() {
      return store;
    },
    time(value) {
      time = value;
    },
    reopen() {
      store.close();
      store = createRecoverySqliteStore({ database: engineDatabase, dataKey, now: () => time });
    },
    close() {
      store.close();
      database.close();
    },
  };
}

test('maintenance authenticates and reclaims only absolutely expired payloads and markers', () => {
  const f = memory();
  try {
    assert.deepEqual(f.store.execute({ operation: 'sweep' }), {
      removedRecords: 0,
      removedBytes: 0,
    });
    for (let n = 1; n <= 4; n++) f.store.execute(request(n, n <= 2 ? 200 : 1000));
    for (const n of [2, 4])
      f.store.execute({ operation: 'revoke', scope: scope(n), expectedRevision: 1 });
    const live = f.store.execute({ operation: 'load', scope: scope(3) });
    const rows = f.database.prepare('SELECT * FROM recovery_state ORDER BY scope').all();
    f.time(200);
    const removed = f.store.execute({ operation: 'sweep' });
    assert.deepEqual(removed, {
      removedRecords: 2,
      removedBytes: rows.slice(0, 2).reduce((sum, row) => sum + row.envelope.length, 0),
    });
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 2);
    assert.deepEqual(f.store.execute({ operation: 'load', scope: scope(3) }), live);
    assert.equal(f.store.execute({ operation: 'load', scope: scope(4) }), null);
    assert.throws(() => f.store.execute({ ...request(4), expectedRevision: 2 }), safe);
    assert.throws(() => f.store.execute(request(1, 200)), safe);
    assert.throws(() => f.store.execute({ ...request(1, 200), expectedRevision: 1 }), safe);
    assert.deepEqual(f.store.execute({ operation: 'sweep' }), {
      removedRecords: 0,
      removedBytes: 0,
    });
    f.reopen();
    assert.equal(f.store.execute({ operation: 'load', scope: scope(1) }), null);
    assert.deepEqual(f.store.execute({ operation: 'load', scope: scope(3) }), live);
    assert.throws(() => f.store.execute(request(2, 200)), safe);
    f.time(199);
    assert.throws(() => f.store.execute({ operation: 'sweep' }), safe);
  } finally {
    f.close();
  }
});

test('catalog, writes and fresh engine opening reclaim expired records without evicting live state', () => {
  for (const mode of ['catalog', 'save', 'reopen']) {
    const f = memory();
    try {
      f.store.execute(request(1, 200));
      f.store.execute(request(2));
      const live = f.store.execute({ operation: 'load', scope: scope(2) });
      f.time(200);
      if (mode === 'reopen') f.reopen();
      else f.store.execute(mode === 'catalog' ? { operation: 'catalog' } : request(3));
      assert.equal(
        f.database.prepare('SELECT count(*) AS n FROM recovery_state WHERE scope=?').get(scope(1))
          .n,
        0
      );
      assert.deepEqual(f.store.execute({ operation: 'load', scope: scope(2) }), live);
    } finally {
      f.close();
    }
  }
});

test('opening an over-quota database fails before maintenance deletes any record', () => {
  const f = memory();
  try {
    f.store.execute(request(1, 200));
    f.store.close();
    assert.throws(
      () =>
        createRecoverySqliteStore({
          database: {
            exec: (sql) => f.database.exec(sql),
            prepare(sql) {
              if (sql === 'PRAGMA page_count')
                return { get: () => ({ page_count: 64 * 1024 * 1024 }) };
              return f.database.prepare(sql);
            },
          },
          dataKey: f.dataKey,
          now: () => 200,
        }),
      safe
    );
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 1);
  } finally {
    f.close();
  }
});

test('expired tombstone collection releases the unchanged 256-record cap and keeps all live revocations', () => {
  const f = memory();
  try {
    for (let n = 1; n <= 256; n += 4)
      f.store.execute({
        operation: 'revoke-scopes',
        entries: Array.from({ length: 4 }, (_, i) => ({
          scope: scope(n + i),
          createdAt: 100,
          expiresAt: 200,
        })),
      });
    assert.throws(() => f.store.execute(request(257)), safe);
    f.time(200);
    assert.equal(f.store.execute({ operation: 'sweep' }).removedRecords, 256);
    assert.deepEqual(f.store.execute(request(257)), { revision: 1 });
    assert.equal(f.store.execute({ operation: 'load', scope: scope(257) }).state.budget.calls, 7);
    assert.throws(() => f.store.execute(request(1, 200)), safe);
  } finally {
    f.close();
  }
});

test('corruption and partial delete failures roll back all collection and retain safe errors', () => {
  for (const mode of ['corrupt', 'delete']) {
    let armed = false;
    let deleted = 0;
    const f = memory((sql, args, result) => {
      if (!armed || !sql.startsWith('DELETE FROM recovery_state')) return;
      assert.deepEqual(args, [200]);
      deleted += result.changes;
      throw new Error('synthetic-secret-delete-failure');
    });
    try {
      f.store.execute(request(1, 200));
      f.store.execute(request(2, 200));
      const original = f.database
        .prepare('SELECT envelope FROM recovery_state WHERE scope=?')
        .get(scope(2)).envelope;
      if (mode === 'corrupt')
        f.database
          .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
          .run(Buffer.from('invalid-secret'), scope(2));
      const header = f.database.prepare('SELECT * FROM recovery_header').all();
      const rows = f.database.prepare('SELECT * FROM recovery_state ORDER BY scope').all();
      armed = mode === 'delete';
      f.time(200);
      assert.throws(() => f.store.execute({ operation: 'sweep' }), safe);
      armed = false;
      assert.equal(deleted, mode === 'delete' ? 2 : 0);
      assert.deepEqual(f.database.prepare('SELECT * FROM recovery_header').all(), header);
      assert.deepEqual(
        f.database.prepare('SELECT * FROM recovery_state ORDER BY scope').all(),
        rows
      );
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 2);
      if (mode === 'corrupt')
        f.database
          .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
          .run(original, scope(2));
      assert.equal(f.store.execute({ operation: 'sweep' }).removedRecords, 2);
    } finally {
      f.close();
    }
  }
});

test('maintenance request and ACK boundaries reject malformed, unbounded and executable data', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(storageRequest({ operation: 'sweep' }))), {
    operation: 'sweep',
  });
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(validateStorageResult('sweep', { removedRecords: 0, removedBytes: 0 }))
    ),
    { removedRecords: 0, removedBytes: 0 }
  );
  let ran = 0;
  for (const bytes of [64 * 1024 * 1024 + 1, RECOVERY_DIRECTORY_BYTES])
    assert.equal(
      validateStorageResult('sweep', { removedRecords: 1, removedBytes: bytes }).removedBytes,
      bytes
    );
  for (const value of [
    null,
    [],
    {},
    { operation: 'sweep', scope: scope(1) },
    { operation: 'sweep', force: true },
    {
      get operation() {
        ran++;
        return 'sweep';
      },
    },
  ])
    assert.throws(() => storageRequest(value), safe);
  for (const value of [
    null,
    {},
    [],
    { removedRecords: -1, removedBytes: 0 },
    { removedRecords: 257, removedBytes: 0 },
    { removedRecords: 0, removedBytes: -1 },
    { removedRecords: 1, removedBytes: RECOVERY_DIRECTORY_BYTES + 1 },
    { removedRecords: 0, removedBytes: 3 },
    { removedRecords: 1, removedBytes: 0 },
    { removedRecords: 1.5, removedBytes: 30 },
    { removedRecords: 0, removedBytes: 0, extra: true },
    {
      get removedRecords() {
        ran++;
        return 0;
      },
      removedBytes: 0,
    },
  ])
    assert.throws(() => validateStorageResult('sweep', value), safe);
  assert.equal(ran, 0);
});

test(
  'actual encrypted worker reopens mixed 30 minute and 24 hour records without deadline renewal',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const started = Date.now();
    const clock = new BigInt64Array(new SharedArrayBuffer(8));
    Atomics.store(clock, 0, BigInt(started));
    class RetentionWorker extends Worker {
      constructor(file, options) {
        super(file, {
          ...options,
          workerData: { ...options.workerData, maintenanceClock: clock.buffer },
          execArgv: [
            '--require',
            path.join(__dirname, 'helpers/context-recovery-maintenance-clock.cjs'),
          ],
        });
      }
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-maintenance-retention-'));
    const open = () =>
      openContextRecoveryStorage({
        directory: path.join(directory, 'store'),
        WorkerType: RetentionWorker,
      });
    let worker, database;
    try {
      worker = await open();
      const legacy = request(1, started + 1800000);
      const current = request(2, started + 86400000);
      await worker.execute(legacy);
      await worker.execute(current);
      const oldRead = await worker.execute({ operation: 'load', scope: scope(1) });
      const newRead = await worker.execute({ operation: 'load', scope: scope(2) });
      assert.equal(oldRead.createdAt, started);
      assert.equal(oldRead.expiresAt, legacy.expiresAt);
      assert.equal(newRead.expiresAt, current.expiresAt);
      await assert.rejects(
        worker.execute({ ...legacy, expectedRevision: 1, expiresAt: current.expiresAt }),
        safe
      );
      await worker.close();
      worker = undefined;
      Atomics.store(clock, 0, BigInt(started + 1800000));
      worker = await open();
      assert.equal(await worker.execute({ operation: 'load', scope: scope(1) }), null);
      assert.deepEqual(await worker.execute({ operation: 'load', scope: scope(2) }), newRead);
      Atomics.store(clock, 0, BigInt(current.expiresAt - 1));
      assert.deepEqual(await worker.execute({ operation: 'load', scope: scope(2) }), newRead);
      Atomics.store(clock, 0, BigInt(current.expiresAt));
      await worker.execute({ operation: 'sweep' });
      assert.equal(await worker.execute({ operation: 'load', scope: scope(2) }), null);
      assert.deepEqual(JSON.parse(JSON.stringify(await worker.execute({ operation: 'inspect' }))), {
        records: 0,
        bytes: 0,
      });
      await assert.rejects(
        worker.execute({
          ...current,
          expectedRevision: 1,
          expiresAt: current.expiresAt + 86400000,
        }),
        safe
      );
      await worker.close();
      worker = undefined;
      database = new DatabaseSync(path.join(directory, 'store/checkpoint.sqlite'), {
        readOnly: true,
      });
      assert.equal(database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 0);
    } finally {
      await worker?.close();
      database?.close();
      clean(directory);
    }
  }
);

function clean(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('hpm-maintenance-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('physical process exit before collection commit preserves old rows and the clock; reopen safely collects them', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-maintenance-crash-'));
  const file = path.join(directory, 'state.sqlite');
  const dataKey = randomBytes(32).toString('base64');
  let database, store;
  try {
    const result = await runRecoverySweepCrash({ file, key: dataKey, state: request(1).state });
    assert.equal(result.status, 37);
    assert.equal(result.stdout, 'maintenance-before-commit');
    database = new DatabaseSync(file);
    assert.equal(database.prepare('SELECT count(*) AS n FROM recovery_state').get().n, 2);
    let time = 100;
    store = createRecoverySqliteStore({ database, dataKey, now: () => time });
    assert.equal(store.execute({ operation: 'load', scope: scope(1) }).revision, 1);
    const live = store.execute({ operation: 'load', scope: scope(2) });
    time = 200;
    assert.equal(store.execute({ operation: 'sweep' }).removedRecords, 1);
    assert.equal(store.execute({ operation: 'load', scope: scope(1) }), null);
    assert.deepEqual(store.execute({ operation: 'load', scope: scope(2) }), live);
    store.close();
    store = undefined;
    database.close();
    database = new DatabaseSync(file);
    store = createRecoverySqliteStore({ database, dataKey, now: () => 200 });
    assert.throws(() => store.execute(request(1, 200)), safe);
    assert.deepEqual(store.execute({ operation: 'load', scope: scope(2) }), live);
    assert.equal(fs.readFileSync(file).includes(Buffer.from(request(1).state.synthetic)), false);
    assert.equal(fs.existsSync(file + '-journal'), false);
  } finally {
    store?.close();
    database?.close();
    clean(directory);
  }
});

test(
  'actual encrypted worker maintenance survives reopen without reviving stale saves or changing live budgets',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const clock = new BigInt64Array(new SharedArrayBuffer(8));
    const started = Date.now();
    Atomics.store(clock, 0, BigInt(started));
    class MaintenanceWorker extends Worker {
      constructor(file, options) {
        super(file, {
          ...options,
          workerData: { ...options.workerData, maintenanceClock: clock.buffer },
          execArgv: [
            '--require',
            path.join(__dirname, 'helpers/context-recovery-maintenance-clock.cjs'),
          ],
        });
      }
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-maintenance-worker-'));
    let worker;
    const open = () =>
      openContextRecoveryStorage({
        directory: path.join(directory, 'store'),
        WorkerType: MaintenanceWorker,
      });
    try {
      worker = await open();
      const expiresAt = started + 1000;
      const stale = request(1, expiresAt);
      await worker.execute(stale);
      await worker.execute(request(2, started + 60000));
      const live = await worker.execute({ operation: 'load', scope: scope(2) });
      assert.equal(live.createdAt, started);
      assert.equal(live.expiresAt, started + 60000);
      // Ordinary saves also collect expired rows. Keep time fixed until both
      // writes finish, so the explicit sweep must perform this exact removal.
      Atomics.store(clock, 0, BigInt(expiresAt + 10));
      const result = await worker.execute({ operation: 'sweep' });
      assert.equal(result.removedRecords, 1);
      assert.ok(result.removedBytes >= 30);
      await worker.close();
      worker = undefined;
      worker = await open();
      assert.equal(await worker.execute({ operation: 'load', scope: scope(1) }), null);
      assert.deepEqual(await worker.execute({ operation: 'load', scope: scope(2) }), live);
      await assert.rejects(worker.execute(stale), safe);
      assert.deepEqual(JSON.parse(JSON.stringify(await worker.execute({ operation: 'sweep' }))), {
        removedRecords: 0,
        removedBytes: 0,
      });
    } finally {
      await worker?.close();
      clean(directory);
    }
  }
);
