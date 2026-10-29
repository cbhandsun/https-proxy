'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');

const scope = 'a'.repeat(64);
function fixture(t, beforeCommit = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-reader-contention-'));
  const file = path.join(directory, 'checkpoint.sqlite');
  const database = new DatabaseSync(file);
  const cleanup = [];
  let store = null;
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
    store?.close();
    database.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-reader-contention-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  store = createRecoverySqliteStore({
    database: {
      exec(sql) {
        if (sql === 'COMMIT') beforeCommit();
        return database.exec(sql);
      },
      prepare: (sql) => database.prepare(sql),
    },
    dataKey: randomBytes(32).toString('base64'),
    now: () => 1000,
  });
  const save = (expectedRevision, marker) =>
    store.execute({
      operation: 'save',
      scope,
      expectedRevision,
      expiresAt: 10000,
      state: { marker },
    });
  save(0, 'before');
  return { database, file, save, store, cleanup: (action) => cleanup.push(action) };
}

test('a transient readonly snapshot cannot revoke a completed write during COMMIT', async (t) => {
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const state = new Int32Array(shared);
  let armed = false;
  let commits = 0;
  const f = fixture(t, () => {
    if (!armed) return;
    commits++;
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  });
  const reader = new Worker(path.join(__dirname, 'helpers/context-recovery-sqlite-reader.cjs'), {
    workerData: { file: f.file, state: shared },
  });
  f.cleanup(() => reader.terminate());
  const exit = once(reader, 'exit');
  assert.deepEqual(await once(reader, 'message'), ['reader-held']);
  armed = true;
  assert.deepEqual(f.save(1, 'after'), { revision: 2 });
  armed = false;
  assert.equal(commits, 1, 'the transaction body and COMMIT are not replayed');
  assert.deepEqual(await exit, [0]);
  assert.equal(Atomics.load(state, 0), 2, 'the reader released its lock and closed');
  const loaded = f.store.execute({ operation: 'load', scope });
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.state.marker, 'after');
  assert.deepEqual(Object.keys(loaded.state), ['marker']);
});

test('a held readonly snapshot still fails safely and rolls back the entire write', (t) => {
  const f = fixture(t);
  const reader = new DatabaseSync(f.file, { readOnly: true, allowExtension: false });
  f.cleanup(() => reader.close());
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM recovery_state').get();
  assert.throws(
    () => f.save(1, 'never-published'),
    (error) => {
      assert.equal(error.code, 'context_recovery_storage_unavailable');
      assert.equal(error.message, error.code);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
  reader.exec('ROLLBACK');
  const loaded = f.store.execute({ operation: 'load', scope });
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.state.marker, 'before');
  assert.deepEqual(Object.keys(loaded.state), ['marker']);
  assert.deepEqual(f.save(1, 'after-release'), { revision: 2 });
  assert.throws(() => f.save(1, 'stale'), { code: 'context_recovery_storage_unavailable' });
});
