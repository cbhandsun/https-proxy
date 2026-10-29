'use strict';
// Owned synthetic SQLite fixture only. No product configuration or key is read.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { observePublicationSql } = require('./publication-sql-progress.cjs');
process.once('message', (input) => {
  let database,
    committed = false,
    busy = false;
  try {
    if (
      !input ||
      Object.keys(input).join(',') !== 'file' ||
      typeof input.file !== 'string' ||
      input.file.length > 4096 ||
      !path.isAbsolute(input.file) ||
      /[\0\r\n]/.test(input.file) ||
      /^[\\/]{2}/.test(input.file) ||
      path.basename(input.file) !== 'checkpoint.sqlite' ||
      !path.basename(path.dirname(input.file)).startsWith('hpm-sql-progress-block-')
    )
      throw Error('invalid');
    const identity = fs.lstatSync(input.file);
    if (
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      identity.nlink !== 1 ||
      fs.realpathSync.native(input.file).toLowerCase() !== path.resolve(input.file).toLowerCase()
    )
      throw Error('invalid');
    database = new DatabaseSync(input.file);
    database.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000');
    const observed = observePublicationSql(
      { exec: (sql) => database.exec(sql), prepare: (sql) => database.prepare(sql) },
      (progress) => process.send({ kind: 'progress', progress })
    );
    observed.exec('BEGIN IMMEDIATE');
    observed
      .prepare('UPDATE recovery_header SET envelope=? WHERE singleton=1')
      .run(Buffer.from('synthetic'));
    observed.exec('COMMIT');
    committed = true;
  } catch (error) {
    busy = error?.code === 'ERR_SQLITE_ERROR' && error.errcode === 5;
  } finally {
    try {
      database?.close();
    } catch {
      committed = false;
    }
  }
  process.send({ kind: 'done', committed, busy });
  process.exitCode = committed ? 0 : 1;
  process.disconnect();
});
