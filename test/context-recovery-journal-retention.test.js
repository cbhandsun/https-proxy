'use strict';

// Direct SQLite engine and disposable files only. No storage worker, OS key
// protection, anchor repository, registry, network or real user state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');

function fixture(t, candidate = false) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-journal-retention-'));
  const file = path.join(root, 'checkpoint.sqlite');
  const database = new DatabaseSync(file, { allowExtension: false });
  let time = 100;
  const owned = { store: undefined };
  t.after(() => {
    owned.store?.close();
    database.close();
    const resolved = fs.realpathSync.native(root);
    assert.equal(resolved, root);
    assert.equal(path.dirname(resolved), temporary);
    assert.match(path.basename(resolved), /^hpm-journal-retention-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  // Negative control only: prove that this check detects ciphertext retained
  // by an otherwise FULL-synchronous PERSIST journal. Product mode is untouched.
  const adapter = candidate
    ? {
        exec(sql) {
          return database.exec(
            sql === 'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON'
              ? 'PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON'
              : sql
          );
        },
        prepare: (sql) => database.prepare(sql),
      }
    : database;
  const store = createRecoverySqliteStore({
    database: adapter,
    dataKey: randomBytes(32).toString('base64'),
    now: () => time,
  });
  owned.store = store;
  const scope = 'a'.repeat(64);
  store.execute({
    operation: 'save',
    scope,
    expectedRevision: 0,
    expiresAt: 1000,
    state: { synthetic: 'SYNTHETIC_JOURNAL_CONTENT '.repeat(512) },
  });
  const prior = Buffer.from(
    database.prepare('SELECT envelope FROM recovery_state WHERE scope=?').get(scope).envelope
  );
  return {
    remove(operation) {
      time = operation === 'expiry' ? 1000 : 200;
      store.execute(
        operation === 'expiry'
          ? { operation: 'sweep' }
          : { operation: 'revoke', scope, expectedRevision: 1 }
      );
      assert.equal(store.execute({ operation: 'load', scope }), null);
      assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 2);
      assert.equal(database.prepare('PRAGMA secure_delete').get().secure_delete, 1);
    },
    retainedCiphertext() {
      const journal = fs.existsSync(file + '-journal')
        ? fs.readFileSync(file + '-journal')
        : Buffer.alloc(0);
      // A SQLite page boundary interrupts the serialized envelope, so checking
      // for the entire blob would miss retained page fragments.
      for (let offset = 0; offset + 64 <= prior.length; offset += 64)
        if (journal.includes(prior.subarray(offset, offset + 64))) return true;
      return false;
    },
  };
}

for (const operation of ['revoke', 'expiry']) {
  test(`committed ${operation} leaves no discarded ciphertext in the current journal`, (t) => {
    const f = fixture(t);
    f.remove(operation);
    assert.equal(f.retainedCiphertext(), false);
  });
}

test('journal retention control detects PERSIST fragments despite successful logical denial', (t) => {
  for (const operation of ['revoke', 'expiry']) {
    const f = fixture(t, true);
    f.remove(operation);
    assert.equal(f.retainedCiphertext(), true);
  }
});
