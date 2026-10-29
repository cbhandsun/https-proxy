'use strict';

// Owned crash fixture. Synthetic key/state arrive on stdin; terminate exactly
// before the maintenance COMMIT, leaving a genuine SQLite rollback journal.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');
try {
  const input = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 65536) throw new Error('invalid');
  const fixture = JSON.parse(input);
  let armed = false;
  let time = 100;
  const database = new DatabaseSync(fixture.file, { allowExtension: false });
  const store = createRecoverySqliteStore({
    database: {
      prepare: (...args) => database.prepare(...args),
      exec(sql) {
        if (armed && sql === 'COMMIT') {
          process.stdout.write('maintenance-before-commit');
          process.exit(37);
        }
        return database.exec(sql);
      },
    },
    dataKey: fixture.key,
    now: () => time,
  });
  for (let n = 1; n <= 2; n++)
    store.execute({
      operation: 'save',
      scope: n.toString(16).padStart(64, '0'),
      expectedRevision: 0,
      expiresAt: n === 1 ? 200 : 1000,
      state: fixture.state,
    });
  // Preparation is complete at the original clock value. Only the parent's
  // fixed authorization starts the separately bounded destructive operation.
  process.once('message', (message) => {
    if (message !== 'sweep') process.exit(39);
    try {
      time = 200;
      armed = true;
      store.execute({ operation: 'sweep' });
    } catch {
      process.exit(39);
    }
    process.exit(39);
  });
  process.once('disconnect', () => process.exit(39));
  if (typeof process.send !== 'function') process.exit(39);
  process.send('ready');
} catch {
  process.exit(39);
}
