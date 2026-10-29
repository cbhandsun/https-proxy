'use strict';

const { DatabaseSync } = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { exact } = require('../shared/boundary');
const { createReadonlyFiles } = require('../n09-snapshot/readonly-files');
const {
  recoveryStorageSchemaState,
} = require('../../../lib/proxy/context-recovery-storage-schema');
const fail = () => new Error('n09_publication_commit_witness_failed');

// Acceptance-only. Keep one existing read transaction, then prove another
// read connection is refused while that DELETE-journal read lock is held.
// BUSY alone cannot distinguish COMMIT from another exclusive writer request;
// the caller must independently bind the intended daemon transition.
// No key, plaintext, writer, retry, daemon command or publication ACK is owned.
function createPublicationCommitWitness(input) {
  let files, reader, probe, scope, expectedRevision;
  let begun = false,
    closed = false,
    closeFailed = false,
    waiting = false,
    observed = false;
  function close() {
    if (closed) {
      if (closeFailed) throw fail();
      return;
    }
    closed = true;
    for (const action of [
      () => {
        if (begun) reader.exec('ROLLBACK');
      },
      () => reader?.close(),
      () => probe?.close(),
    ]) {
      try {
        action();
      } catch {
        closeFailed = true;
      }
    }
    reader = probe = undefined;
    begun = false;
    if (closeFailed) throw fail();
  }
  function rejected() {
    try {
      close();
    } catch {
      /* A failed close cannot grant a witness. */
    }
    return fail();
  }
  const row = (database) =>
    database.prepare('SELECT scope,revision FROM recovery_state ORDER BY scope LIMIT 2').all();
  try {
    const config = exact(input, ['ownedRoot', 'runtimeDir', 'expectedRevision']);
    expectedRevision = config.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw fail();
    files = createReadonlyFiles({ ownedRoot: config.ownedRoot, runtimeDir: config.runtimeDir });
    files.verify();
    reader = new DatabaseSync(files.databaseFile, { readOnly: true, allowExtension: false });
    reader.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN');
    begun = true;
    if (
      reader.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete' ||
      recoveryStorageSchemaState(reader) !== 'ready'
    )
      throw fail();
    const rows = row(reader);
    if (
      rows.length !== 1 ||
      typeof rows[0].scope !== 'string' ||
      !/^[a-f0-9]{64}$/.test(rows[0].scope) ||
      rows[0].revision !== expectedRevision
    )
      throw fail();
    scope = rows[0].scope;
    probe = new DatabaseSync(files.databaseFile, { readOnly: true, allowExtension: false });
    probe.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
    const initial = row(probe);
    if (
      initial.length !== 1 ||
      initial[0].scope !== scope ||
      initial[0].revision !== expectedRevision
    )
      throw fail();
    files.verify();
  } catch {
    throw rejected();
  }
  return Object.freeze({
    async waitPending() {
      try {
        if (closed || waiting || observed) throw fail();
        waiting = true;
        const deadline = performance.now() + 750;
        for (;;) {
          if (closed || performance.now() >= deadline) throw fail();
          let blocked = false;
          try {
            const current = row(probe);
            if (
              current.length !== 1 ||
              current[0].scope !== scope ||
              current[0].revision !== expectedRevision
            )
              throw fail();
          } catch (error) {
            if (error?.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 5) throw fail();
            blocked = true;
          }
          if (blocked) {
            files.verify();
            if (performance.now() >= deadline) throw fail();
            observed = true;
            return Object.freeze({
              readAdmissionBlocked: true,
              evidenceLevel: 'sqlite-read-admission-only',
              publicationQualified: false,
            });
          }
          if (performance.now() >= deadline) throw fail();
          // Poll read admission only; never execute or replay the writer.
          await nextTurn();
        }
      } catch {
        throw rejected();
      } finally {
        waiting = false;
      }
    },
    release() {
      try {
        if (closed || waiting || !observed) throw fail();
        close();
        files.verify();
        return Object.freeze({ released: true });
      } catch {
        throw rejected();
      }
    },
    close,
  });
}

module.exports = { createPublicationCommitWitness };
