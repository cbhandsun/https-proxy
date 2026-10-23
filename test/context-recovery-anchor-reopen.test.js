'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { createRecoveryAnchorAdmission } = require('../lib/proxy/context-recovery-anchor-admission');

const scope = 'a'.repeat(64);
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' && error.message === error.code;

// Synthetic retained backend, outside the SQLite backup. This exercises actual
// encrypted rows and startup ordering; it does not claim native registry proof.
function fixture(t) {
  const database = new DatabaseSync(':memory:');
  const dataKey = randomBytes(32).toString('base64');
  let retained = null;
  let anchorRevision = 0;
  let owner;
  let time = 100;
  let clockCalls = 0;
  let failCommit = false;
  const repository = () => ({
    identity: { keyIdentity: 'b'.repeat(64), locationHash: 'c'.repeat(64) },
    read: () => retained,
    commit(value) {
      if (failCommit) throw new Error('synthetic-native-flush-failure');
      retained = value;
      return { revision: ++anchorRevision };
    },
    close() {},
  });
  function open(allowEnrollment = false, afterValidation = () => {}) {
    const admission = createRecoveryAnchorAdmission({ repository: repository(), allowEnrollment });
    let engine;
    try {
      engine = createRecoverySqliteStore({
        database,
        dataKey,
        initialStoreId: admission.initialStoreId,
        now() {
          clockCalls++;
          return time;
        },
        beforeStartup(value, initializing) {
          admission.validateStartup(value, initializing);
          afterValidation();
        },
      });
      admission.persist(engine.snapshot());
    } catch (error) {
      engine?.close();
      admission.close();
      throw error;
    }
    owner = {
      execute(request) {
        try {
          const result = engine.execute(request);
          admission.persist(engine.snapshot());
          return result;
        } catch (error) {
          this.close();
          throw error;
        }
      },
      close() {
        engine.close();
        admission.close();
      },
    };
    return owner;
  }
  t.after(() => {
    owner?.close();
    database.close();
  });
  return {
    database,
    retained: () => retained,
    open,
    calls: () => clockCalls,
    setTime(value) {
      time = value;
    },
    failCommit() {
      failCommit = true;
    },
    restoreBackend() {
      failCommit = false;
    },
  };
}

function save(owner, expectedRevision = 0) {
  return owner.execute({
    operation: 'save',
    scope,
    expectedRevision,
    expiresAt: 1000,
    state: { privateText: 'synthetic original', remainingBudget: 4 - expectedRevision },
  });
}

function backup(database) {
  const header = database.prepare('SELECT * FROM recovery_header').get();
  const rows = database.prepare('SELECT * FROM recovery_state').all();
  return () => {
    database.exec('BEGIN EXCLUSIVE');
    database
      .prepare('UPDATE recovery_header SET store_id=?,envelope=? WHERE singleton=1')
      .run(header.store_id, header.envelope);
    database.exec('DELETE FROM recovery_state');
    for (const row of rows)
      database
        .prepare('INSERT INTO recovery_state VALUES(?,?,?,?,?,?)')
        .run(row.scope, row.revision, row.created_at, row.expires_at, row.kind, row.envelope);
    database.exec('COMMIT');
  };
}

test('actual SQLite startup rejects restored pre-revocation authenticated rows before clock or cleanup', (t) => {
  const f = fixture(t),
    first = f.open(true);
  save(first);
  const restore = backup(f.database);
  first.execute({ operation: 'revoke', scope, expectedRevision: 1 });
  first.close();
  const normal = f.open();
  normal.close();
  restore();
  const calls = f.calls();
  f.setTime(2000);
  assert.throws(() => f.open(), safe);
  assert.equal(f.calls(), calls);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM recovery_state').get().count, 1);
});

test('failure after empty intent flush but before SQLite initial commit retries the same store identity', (t) => {
  const f = fixture(t);
  let injected = 0;
  assert.throws(
    () =>
      f.open(true, () => {
        injected++;
        throw new Error('injected-before-initial-commit');
      }),
    safe
  );
  assert.equal(injected, 1);
  const intent = f.retained();
  assert.equal(intent.maxTime, 0);
  assert.deepEqual(intent.scopes, []);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM sqlite_schema').get().count, 0);
  const reopened = f.open();
  assert.equal(f.retained().storeId, intent.storeId);
  assert.deepEqual(save(reopened), { revision: 1 });
});

test('actual SQLite startup cannot restore a prior acknowledged state revision or reader budget', (t) => {
  const f = fixture(t),
    first = f.open(true);
  save(first);
  const restore = backup(f.database);
  save(first, 1);
  first.close();
  restore();
  const calls = f.calls();
  assert.throws(() => f.open(), safe);
  assert.equal(f.calls(), calls);
});

test('SQLite may be ahead after an unacknowledged anchor failure and reconcile without lowering retained floors', (t) => {
  const f = fixture(t),
    owner = f.open(true);
  save(owner);
  f.failCommit();
  assert.throws(() => save(owner, 1), safe);
  assert.equal(f.database.prepare('SELECT revision FROM recovery_state').get().revision, 2);
  // The failed result was never returned. Admission will still authenticate this
  // revision against the older anchor on restart; a native failure must deny ACK.
  assert.throws(() => f.open(), safe);
  f.restoreBackend();
  const reopened = f.open();
  assert.deepEqual(save(reopened, 2), { revision: 3 });
});
