'use strict';

// Owned offline fixture: key and synthetic checkpoint arrive through stdin only.
// Exit deliberately with an open write transaction to exercise SQLite recovery.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');
try {
  const input = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 65536) throw new Error('invalid');
  const fixture = JSON.parse(input);
  const database = new DatabaseSync(fixture.file, { allowExtension: false });
  const engineDatabase = fixture.initializeBeforeCommit
    ? {
        exec(sql) {
          if (sql === 'COMMIT') {
            process.stdout.write('uncommitted-schema');
            process.exit(37);
          }
          return database.exec(sql);
        },
        prepare: (sql) => database.prepare(sql),
      }
    : database;
  const store = createRecoverySqliteStore({
    database: engineDatabase,
    dataKey: fixture.key,
    now: () => 100,
  });
  store.execute({
    operation: 'save',
    scope: fixture.scope,
    expectedRevision: 0,
    expiresAt: 1000,
    state: fixture.state,
  });
  database.exec('BEGIN IMMEDIATE');
  database
    .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
    .run(Buffer.alloc(30), fixture.scope);
  process.stdout.write('committed-then-uncommitted-write');
  process.exit(37);
} catch {
  process.exit(39);
}
