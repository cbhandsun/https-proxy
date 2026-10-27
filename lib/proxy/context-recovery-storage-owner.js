'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const { createStoragePaths } = require('./context-recovery-storage-paths');
const { createRecoverySqliteStore } = require('./context-recovery-storage-sqlite');
const { protectWithCurrentUser } = require('./context-recovery-key-dpapi');
const { keyRequest } = require('./context-recovery-key-contract');
const { ownAnchorRecord } = require('./context-recovery-anchor-protocol');
const { storageFailure, storageRequest } = require('./context-recovery-storage-contract');
const { createStorageStartupProgress } = require('./context-recovery-storage-progress');
const {
  storageExecutionFailure,
  storageFailureDiagnostic,
} = require('./context-recovery-storage-failure');
const {
  createRecoveryAnchorRepository,
  createRecoveryAnchorSession,
} = require('./context-recovery-anchor');
const {
  createRecoveryAnchorAdmission,
  createRecoveryAsyncAnchorAdmission,
} = require('./context-recovery-anchor-admission');

// Runs only in the dedicated storage worker. One OS-backed SQLite mutex remains
// held for this owner's entire lifetime, including native key protection calls.
function createOwner(
  { directory, protectKey = protectWithCurrentUser, onStartup } = {},
  {
    createAnchorRepository = createRecoveryAnchorRepository,
    createAnchorSession = createRecoveryAnchorSession,
  } = {},
  asyncMode = false
) {
  const progress = createStorageStartupProgress(onStartup);
  let paths,
    mutex,
    database,
    engine,
    anchor,
    anchorSession,
    closing,
    busy = false,
    locked = false,
    closed = false;
  function close() {
    closed = true;
    let failed = false;
    for (const action of [
      () => engine?.close(),
      () => (anchor ? anchor.close() : anchorSession?.repository.close()),
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
    engine = database = mutex = anchor = anchorSession = undefined;
    locked = false;
    if (failed) throw storageFailure();
  }
  function verifyState() {
    if (closed) throw storageFailure();
    paths.verify();
  }
  function closeAsync() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      // Keep the OS SQLite writer lock until the owned native process really
      // closes. A failed cleanup must never grant a second writer authority.
      try {
        await anchor.closeAsync();
      } catch {
        throw storageExecutionFailure('owner-close');
      }
      try {
        close();
      } catch {
        throw storageExecutionFailure('owner-close');
      }
    })();
    return closing;
  }
  async function executeAsync(input) {
    const request = storageRequest(input);
    if (closed || busy) throw storageFailure();
    busy = true;
    try {
      try {
        verifyState();
      } catch {
        let cleanupFailed = false;
        try {
          await closeAsync();
        } catch {
          cleanupFailed = true;
        }
        throw storageExecutionFailure('owner-verify', cleanupFailed);
      }
      // Rejected SQL requests still roll back without destroying this owner.
      let result;
      try {
        result = engine.execute(request);
      } catch {
        throw storageExecutionFailure('engine-execute');
      }
      let phase = 'engine-snapshot';
      try {
        const snapshot = engine.snapshot();
        phase = 'anchor-persist';
        await anchor.persistAsync(snapshot);
        phase = 'owner-verify';
        verifyState();
        return result;
      } catch (error) {
        const diagnostic = phase === 'anchor-persist' ? storageFailureDiagnostic(error) : null;
        let cleanupFailed = diagnostic?.cleanupFailed === true;
        try {
          await closeAsync();
        } catch {
          cleanupFailed = true;
        }
        throw storageExecutionFailure(diagnostic?.phase ?? phase, cleanupFailed);
      }
    } finally {
      busy = false;
    }
  }
  async function finishAsyncStartup() {
    let phase = 'engine-snapshot';
    try {
      const snapshot = engine.snapshot();
      phase = 'anchor-persist';
      // The final durable startup ACK opens the same owned channel as requests.
      // Empty enrollment intent remains synchronous before the SQL COMMIT.
      await anchor.persistAsync(snapshot);
      progress.advance('anchor_persist_finished');
      phase = 'owner-verify';
      verifyState();
      progress.advance('engine_ready');
      return Object.freeze({ execute: executeAsync, close: closeAsync });
    } catch (error) {
      const diagnostic = phase === 'anchor-persist' ? storageFailureDiagnostic(error) : null;
      let cleanupFailed = diagnostic?.cleanupFailed === true;
      try {
        await closeAsync();
      } catch {
        cleanupFailed = true;
      }
      throw storageExecutionFailure(diagnostic?.phase ?? phase, cleanupFailed);
    }
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
    if (
      typeof protectKey !== 'function' ||
      typeof createAnchorRepository !== 'function' ||
      typeof createAnchorSession !== 'function'
    )
      throw storageFailure();
    progress.advance('paths_started');
    paths = createStoragePaths(directory, ({ phase }) => progress.advance(phase));
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
    progress.advance('anchor_open_started');
    if (asyncMode)
      anchorSession = ownAnchorRecord(createAnchorSession({ directory, dataKey }), [
        'repository',
        'commit',
        'close',
      ]);
    const admissionOptions = {
      repository: asyncMode
        ? anchorSession.repository
        : createAnchorRepository({ directory, dataKey }),
      // Only the engine's actual empty-schema branch can use this capability.
      // An existing schema with a missing anchor always fails closed.
      allowEnrollment: true,
      clockOnlyScans: true,
    };
    anchor = asyncMode
      ? createRecoveryAsyncAnchorAdmission(admissionOptions, anchorSession)
      : createRecoveryAnchorAdmission(admissionOptions);
    progress.advance('anchor_opened');
    verify();
    progress.advance('database_prepare_started');
    const file = paths.prepare('checkpoint.sqlite');
    progress.advance('database_prepared');
    database = new DatabaseSync(file, { allowExtension: false });
    progress.advance('database_opened');
    verify();
    progress.advance('engine_prepare_started');
    engine = createRecoverySqliteStore({
      database,
      dataKey,
      initialStoreId: anchor.initialStoreId,
      beforeStartup(...args) {
        progress.advance('engine_anchor_validate_started');
        const result = Reflect.apply(anchor.validateStartup, undefined, args);
        progress.advance('engine_anchor_validate_finished');
        return result;
      },
      anchoredStartup: true,
      anchorClockFloor: anchor.initialTime,
    });
    progress.advance('engine_prepared');
    progress.advance('anchor_persist_started');
    if (asyncMode) return finishAsyncStartup();
    anchor.persist(engine.snapshot());
    progress.advance('anchor_persist_finished');
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
      // The engine rolls back rejected requests (for example stale CAS) under
      // its own transaction boundary. Preserve its existing retryable owner
      // contract; only failure after a completed transaction closes this owner.
      const result = engine.execute(request);
      try {
        // Never send a worker receipt until the independent anchor has flushed
        // the same authenticated revision, denial state and time watermark.
        anchor.persist(engine.snapshot());
        verify();
        return result;
      } catch {
        close();
        throw storageFailure();
      }
    },
    close,
  };
}

function createStorageOwner(options, dependencies) {
  return createOwner(options, dependencies);
}
function createAsyncStorageOwner(options, dependencies) {
  return createOwner(options, dependencies, true);
}

module.exports = { createStorageOwner, createAsyncStorageOwner };
