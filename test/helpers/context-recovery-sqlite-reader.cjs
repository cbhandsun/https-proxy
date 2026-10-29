'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const state = new Int32Array(workerData.state);
let database;
try {
  database = new DatabaseSync(workerData.file, { readOnly: true, allowExtension: false });
  database.exec('PRAGMA query_only=ON; BEGIN');
  database.prepare('SELECT count(*) FROM recovery_state').get();
  parentPort.postMessage('reader-held');
  if (Atomics.wait(state, 0, 0, 5000) === 'timed-out') throw new Error('reader_not_used');
  // The writer has reached COMMIT. Keep its competing read lock long enough
  // to exercise SQLite's bounded busy handler, then release without a retry.
  Atomics.wait(state, 1, 0, 100);
  database.exec('ROLLBACK');
  database.close();
  database = undefined;
  Atomics.store(state, 0, 2);
  parentPort.postMessage('reader-released');
} catch {
  parentPort.postMessage('reader-failed');
  process.exitCode = 1;
} finally {
  database?.close();
  parentPort.close();
}
