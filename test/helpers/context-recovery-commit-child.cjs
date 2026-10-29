'use strict';

// Owned offline fixture. Synthetic data/key arrive through IPC, never argv/logs.
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');
let database;
let store;
let armed = false;
let initialized = false;
function report(phase) {
  process.send({ phase });
}
process.on('message', (input) => {
  try {
    if (!initialized) {
      if (
        input?.operation !== 'initialize' ||
        typeof input.file !== 'string' ||
        !/^[A-Za-z0-9+/]{43}=$/.test(input.key) ||
        !/^[a-f0-9]{64}$/.test(input.scope)
      ) {
        throw new Error('invalid fixture');
      }
      initialized = true;
      database = new DatabaseSync(input.file, { allowExtension: false });
      const wrapped = {
        exec(sql) {
          if (armed && sql === 'COMMIT') report('commit-entering');
          return database.exec(sql);
        },
        prepare: (sql) => database.prepare(sql),
      };
      store = createRecoverySqliteStore({ database: wrapped, dataKey: input.key, now: () => 200 });
      const scope = input.scope;
      process.on('message', (command) => {
        if (command?.operation !== 'save' || armed) return;
        armed = true;
        try {
          const result = store.execute({
            operation: 'save',
            scope,
            expectedRevision: 1,
            expiresAt: 1000,
            state: { text: 'after🙂', checkpoint: 2 },
          });
          if (result.revision !== 2) throw new Error('invalid revision');
          report('acknowledged');
          store.close();
          database.close();
          process.disconnect();
        } catch {
          report('failed');
          process.exitCode = 39;
          process.disconnect();
        }
      });
      report('ready');
    }
  } catch {
    report('failed');
    process.exitCode = 39;
    process.disconnect();
  }
});
