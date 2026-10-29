'use strict';

// Separate-process SHARED lock; no key or checkpoint contents are requested.
const { DatabaseSync } = require('node:sqlite');
let database;
process.on('message', (input) => {
  try {
    if (!database && typeof input?.file === 'string') {
      database = new DatabaseSync(input.file, { allowExtension: false });
      database.exec('BEGIN');
      database.prepare('SELECT revision FROM recovery_state').all();
      process.send({ phase: 'reader-held' });
    } else if (database && input?.operation === 'release') {
      database.exec('ROLLBACK');
      database.close();
      process.disconnect();
    } else {
      throw new Error('invalid fixture');
    }
  } catch {
    process.send({ phase: 'reader-failed' });
    process.exitCode = 39;
    process.disconnect();
  }
});
