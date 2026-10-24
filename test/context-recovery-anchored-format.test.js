'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { recoveryStorageSchemaState } = require('../lib/proxy/context-recovery-storage-schema');
const scope = 'a'.repeat(64);
const safe = (error) => error.code === 'context_recovery_storage_unavailable';

function fixture(t, clock = () => 100) {
  const database = new DatabaseSync(':memory:');
  const dataKey = randomBytes(32).toString('base64');
  let clockCalls = 0;
  const options = {
    database,
    dataKey,
    now() {
      clockCalls++;
      return clock();
    },
  };
  let store = createRecoverySqliteStore(options);
  t.after(() => {
    store.close();
    database.close();
  });
  return {
    database,
    store,
    clockCalls: () => clockCalls,
    reopen() {
      store.close();
      store = createRecoverySqliteStore(options);
      return store;
    },
    version: () => database.prepare('PRAGMA user_version').get().user_version,
    rows: () => database.prepare('SELECT * FROM recovery_state ORDER BY scope').all(),
    header: () => database.prepare('SELECT * FROM recovery_header').get(),
  };
}

test('anchored format transition authenticates schema three while preserving rows, revocations and the clock', (t) => {
  const f = fixture(t);
  f.store.execute({
    operation: 'save',
    scope,
    expectedRevision: 0,
    expiresAt: 1000,
    state: { original: 'PRIVATE synthetic original', remainingBudget: 4 },
  });
  const revoked = 'b'.repeat(64);
  f.store.execute({
    operation: 'save',
    scope: revoked,
    expectedRevision: 0,
    expiresAt: 1000,
    state: { original: 'PRIVATE revoked original' },
  });
  f.store.execute({ operation: 'revoke', scope: revoked, expectedRevision: 1 });
  const before = f.store.snapshot(),
    rows = f.rows(),
    clockCalls = f.clockCalls();
  assert.equal(f.version(), 1);
  assert.equal(f.store.prepareAnchoredFormat(), undefined);
  assert.equal(f.version(), 3);
  assert.throws(() => f.store.execute({ operation: 'prepare-anchored-format' }), safe);
  assert.equal(recoveryStorageSchemaState(f.database), 'ready');
  assert.equal(f.clockCalls(), clockCalls);
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(f.rows(), rows);
  const header = f.header();
  f.store.prepareAnchoredFormat();
  assert.deepEqual(f.header(), header);
  const reopened = f.reopen();
  assert.equal(reopened.execute({ operation: 'load', scope }).expiresAt, 1000);
  assert.equal(reopened.execute({ operation: 'load', scope }).state.remainingBudget, 4);
  assert.equal(reopened.execute({ operation: 'load', scope: revoked }), null);
  assert.equal(f.version(), 3);
});

test('schema-three authenticated header refuses a downgraded pragma and unknown future versions', (t) => {
  const f = fixture(t);
  f.store.prepareAnchoredFormat();
  const header = f.header();
  for (const version of [1, 2, 4, 0]) {
    f.database.exec('PRAGMA user_version=' + version);
    assert.throws(() => f.store.snapshot(), safe);
    assert.deepEqual(f.header(), header);
  }
  f.database.exec('PRAGMA user_version=3');
  assert.deepEqual(f.store.snapshot().scopes, []);
});

test('actual SQLite full admission preserves the legacy layout and header instead of returning a sealed owner', (t) => {
  const f = fixture(t);
  const header = f.header(),
    snapshot = f.store.snapshot();
  const pages = f.database.prepare('PRAGMA page_count').get().page_count;
  f.database.exec('PRAGMA max_page_count=' + pages);
  assert.throws(() => f.store.prepareAnchoredFormat(), safe);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.header(), header);
  assert.deepEqual(f.store.snapshot(), snapshot);
});

test('closed storage cannot seal a format or mutate its authenticated header', (t) => {
  const f = fixture(t);
  const header = f.header();
  f.store.close();
  assert.throws(() => f.store.prepareAnchoredFormat(), safe);
  assert.deepEqual(f.header(), header);
  assert.equal(f.version(), 1);
});

test('format transition rolls back the complete layout and ciphertext after DDL, pragma, header or commit failure', (t) => {
  for (const phase of ['blob', 'version', 'header', 'commit']) {
    const f = fixture(t);
    const header = f.header(),
      before = f.store.snapshot();
    const exec = f.database.exec.bind(f.database);
    const prepare = f.database.prepare.bind(f.database);
    f.database.exec = (sql) => {
      if (
        (phase === 'blob' && sql.startsWith('CREATE TABLE recovery_blob')) ||
        (phase === 'version' && sql === 'PRAGMA user_version=3') ||
        (phase === 'commit' && sql === 'COMMIT')
      )
        throw Error('PRIVATE failure');
      return exec(sql);
    };
    f.database.prepare = (sql) => {
      if (phase === 'header' && sql === 'UPDATE recovery_header SET envelope=? WHERE singleton=1')
        throw Error('PRIVATE failure');
      return prepare(sql);
    };
    assert.throws(() => f.store.prepareAnchoredFormat(), safe);
    f.database.exec = exec;
    f.database.prepare = prepare;
    assert.equal(f.version(), 1);
    assert.deepEqual(f.header(), header);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(
      f.database
        .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='recovery_blob'")
        .get().count,
      0
    );
    f.store.prepareAnchoredFormat();
    assert.equal(f.version(), 3);
  }
});

test('existing referenced checkpoint blobs remain readable across the authenticated epoch transition', (t) => {
  const f = fixture(t, () => Date.now());
  const { exerciseRecovery } = require('../scripts/lib/nsis-recovery-fixture-state');
  const sessions = require('../lib/proxy/context-recovery-sessions');
  const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
  const { parseRecoveryStorageRecord } = require('../lib/proxy/context-recovery-storage-record');
  const {
    LIST_EVIDENCE_TOOL: LIST,
    READ_EVIDENCE_TOOL: READ,
  } = require('../lib/proxy/context-evidence-tools');
  const api = { sessions, createRootCheckpoint, parseRecoveryStorageRecord, LIST, READ };
  const original = exerciseRecovery(api, f.store, 'seed');
  assert.equal(f.version(), 2);
  const rows = f.rows();
  const blobs = f.database.prepare('SELECT * FROM recovery_blob ORDER BY scope,blob_id').all();
  assert.ok(blobs.length > 0);
  f.store.prepareAnchoredFormat();
  assert.equal(f.version(), 3);
  assert.deepEqual(f.rows(), rows);
  assert.deepEqual(
    f.database.prepare('SELECT * FROM recovery_blob ORDER BY scope,blob_id').all(),
    blobs
  );
  assert.deepEqual(exerciseRecovery(api, f.reopen(), 'read'), original);
});
