'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const { createStoragePaths } = require('./context-recovery-storage-paths');
const { createRecoverySqliteStore } = require('./context-recovery-storage-sqlite');
const { protectWithCurrentUser } = require('./context-recovery-key-dpapi');
const { keyRequest } = require('./context-recovery-key-contract');
const { storageFailure, storageRequest } = require('./context-recovery-storage-contract');
const { createStorageStartupProgress } = require('./context-recovery-storage-progress');

// Runs only in the dedicated storage worker. One OS-backed SQLite mutex remains
// held for this owner's entire lifetime, including native key protection calls.
function createStorageOwner({ directory, protectKey = protectWithCurrentUser, onStartup } = {}) {
  const progress = createStorageStartupProgress(onStartup);
  let paths,
    mutex,
    database,
    engine,
    locked = false,
    closed = false;
  function close() {
    closed = true;
    let failed = false;
    for (const action of [
      () => engine?.close(),
      () => database?.close(),
      () => {
        if (locked) mutex.exec('ROLLBACK');
      },
      () => mutex?.close(),
    ]) {
      try {
        action();
      } catch {
        failed = true;
      }
    }
    engine = database = mutex = undefined;
    locked = false;
    if (failed) throw storageFailure();
  }
  function verify() {
    try {
      if (closed) throw storageFailure();
      paths.verify();
    } catch {
      close();
      throw storageFailure();
    }
  }
  try {
    if (typeof protectKey !== 'function') throw storageFailure();
    progress.advance('paths_started');
    paths = createStoragePaths(directory);
    progress.advance('paths_ready');
    progress.advance('ownership_started');
    const lockFile = paths.prepare('.writer.sqlite');
    mutex = new DatabaseSync(lockFile, { allowExtension: false });
    mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    locked = true;
    progress.advance('ownership_acquired');
    verify();
    const dataExists = paths.exists('checkpoint.sqlite');
    let generated;
    if (!paths.exists('.data-key')) {
      // Never generate a replacement key for an existing database, including an
      // empty/partial one. Lost keys require explicit recovery, never new state.
      if (dataExists) throw storageFailure();
      const bytes = randomBytes(32);
      let key;
      try {
        key = bytes.toString('base64');
      } finally {
        bytes.fill(0);
      }
      progress.advance('key_protect_started');
      const wrapped = protectKey({ operation: 'protect', value: key });
      keyRequest({ operation: 'unprotect', value: wrapped });
      progress.advance('key_protect_finished');
      verify();
      progress.advance('key_write_started');
      const persisted = paths.writeKey(wrapped);
      if (persisted !== wrapped) throw storageFailure();
      progress.advance('key_write_finished');
      // The trusted protector verifies wrap -> unwrap equality in its single
      // native operation. Reuse the original only after the persisted wrapped
      // bytes are pinned and compared; reopening still requires OS unprotection.
      generated = { wrapped: persisted, dataKey: key };
    }
    const wrapped = generated ? generated.wrapped : paths.pinKey();
    keyRequest({ operation: 'unprotect', value: wrapped });
    let dataKey;
    if (generated) {
      if (wrapped !== generated.wrapped) throw storageFailure();
      dataKey = generated.dataKey;
    } else {
      progress.advance('key_unprotect_started');
      dataKey = protectKey({ operation: 'unprotect', value: wrapped });
      progress.advance('key_unprotect_finished');
    }
    keyRequest({ operation: 'protect', value: dataKey });
    verify();
    progress.advance('database_prepare_started');
    const file = paths.prepare('checkpoint.sqlite');
    progress.advance('database_prepared');
    database = new DatabaseSync(file, { allowExtension: false });
    progress.advance('database_opened');
    verify();
    engine = createRecoverySqliteStore({ database, dataKey });
    verify();
    progress.advance('engine_ready');
  } catch {
    close();
    throw storageFailure();
  }
  return {
    execute(input) {
      const request = storageRequest(input);
      verify();
      try {
        return engine.execute(request);
      } finally {
        verify();
      }
    },
    close,
  };
}

module.exports = { createStorageOwner };
