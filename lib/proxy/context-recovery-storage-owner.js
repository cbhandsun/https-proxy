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
const { createStorageExecutionProgress } = require('./context-recovery-execution-progress');
const { createRecoveryStartupSqlProgress } = require('./context-recovery-startup-sql-progress');
const {
  storageExecutionFailure,
  storageFailureDiagnostic,
} = require('./context-recovery-storage-failure');
const {
  createRecoveryAnchorRepository,
  createRecoveryAnchorSession,
  primeRecoveryAnchorSession,
  prestartRecoveryAnchorSession,
  waitForRecoveryAnchorStartupSession,
  readRecoveryAnchorStartupSession,
  closeRecoveryAnchorStartupSession,
} = require('./context-recovery-anchor');
const {
  createRecoveryAnchorAdmission,
  createRecoveryAsyncAnchorAdmission,
} = require('./context-recovery-anchor-admission');

// Runs only in the dedicated storage worker. One OS-backed SQLite mutex remains
// held for this owner's entire lifetime, including native key protection calls.
function createOwner(
  { directory, protectKey = protectWithCurrentUser, onStartup, onExecutionProgress } = {},
  {
    createAnchorRepository = createRecoveryAnchorRepository,
    createAnchorSession = createRecoveryAnchorSession,
  } = {},
  asyncMode = false
) {
  const progress = createStorageStartupProgress(onStartup);
  const executionProgress = createStorageExecutionProgress(onExecutionProgress);
  let paths,
    mutex,
    database,
    engine,
    anchor,
    anchorSession,
    startupSession,
    closing,
    busy = false,
    locked = false,
    closed = false;
  function primeStartupSession(dataKey, prestart = false) {
    if (!asyncMode) return;
    if (!startupSession) {
      const created = createAnchorSession({ directory, dataKey });
      startupSession = created;
      anchorSession = ownAnchorRecord(created, ['repository', 'commit', 'close']);
    }
    // No frame or readiness authority precedes persisted-key verification.
    // Only idle process launch overlaps DPAPI and key persistence; the original
    // readiness deadline is armed later at the unchanged key barrier.
    if (prestart) prestartRecoveryAnchorSession(startupSession);
    else primeRecoveryAnchorSession(startupSession);
  }
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
    const execution = executionProgress.begin();
    let completed = false;
    try {
      try {
        execution.advance('verify_before_started');
        verifyState();
        execution.advance('verify_before_finished');
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
        execution.advance('engine_execute_started');
        result = engine.execute(request);
        execution.advance('engine_execute_finished');
      } catch {
        throw storageExecutionFailure('engine-execute');
      }
      let phase = 'engine-snapshot';
      try {
        execution.advance('engine_snapshot_started');
        const snapshot = engine.snapshot();
        execution.advance('engine_snapshot_finished');
        phase = 'anchor-persist';
        execution.advance('anchor_persist_started');
        await anchor.persistAsync(snapshot);
        execution.advance('anchor_persist_finished');
        phase = 'owner-verify';
        execution.advance('verify_after_started');
        verifyState();
        execution.advance('verify_after_finished');
        completed = true;
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
      execution.finish(completed);
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

  function failStartup() {
    const cleanup = asyncMode ? closeRecoveryAnchorStartupSession(startupSession) : null;
    if (cleanup) {
      // Only the module-created session can own the primed startup child.
      // Retain the writer lock until that exact child has actually closed.
      return cleanup.then(
        () => {
          close();
          throw storageFailure();
        },
        () => {
          throw storageExecutionFailure('owner-close', true);
        }
      );
    }
    close();
    throw storageFailure();
  }
  function prepareEngine(keyMaterial) {
    try {
      progress.advance('anchor_opened');
      verify();
      progress.advance('database_prepare_started');
      const file = paths.prepare('checkpoint.sqlite');
      progress.advance('database_prepared');
      database = new DatabaseSync(file, { allowExtension: false });
      progress.advance('database_opened');
      verify();
      progress.advance('engine_prepare_started');
      const startupSql = createRecoveryStartupSqlProgress(database, (phase) =>
        progress.advance(phase)
      );
      try {
        engine = createRecoverySqliteStore({
          database: startupSql.database,
          dataKey: keyMaterial.value,
          initialStoreId: anchor.initialStoreId,
          beforeStartup(...args) {
            progress.advance('engine_anchor_validate_started');
            const result = Reflect.apply(anchor.validateStartup, undefined, args);
            progress.advance('engine_anchor_validate_finished');
            startupSql.start();
            return result;
          },
          anchoredStartup: true,
          anchorClockFloor: anchor.initialTime,
        });
      } finally {
        startupSql.finish();
      }
      progress.advance('engine_prepared');
      progress.advance('anchor_persist_started');
      if (asyncMode) return finishAsyncStartup();
      anchor.persist(engine.snapshot());
      progress.advance('anchor_persist_finished');
      verify();
      progress.advance('engine_ready');
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
    } finally {
      keyMaterial.value = undefined;
    }
  }
  async function prepareAsyncAdmission(readiness, keyMaterial, admissionOptions) {
    try {
      // Start the original read deadline at the key barrier, concurrently with
      // native readiness. The channel sends its frame only after exact readiness;
      // waiting first would incorrectly give startup a second readiness window.
      verifyState();
      await readRecoveryAnchorStartupSession(startupSession);
      await readiness;
      // Recheck physical identity after yielding while retaining the writer.
      verifyState();
      anchor = createRecoveryAsyncAnchorAdmission(admissionOptions, anchorSession);
      return prepareEngine(keyMaterial);
    } catch {
      return failStartup();
    } finally {
      keyMaterial.value = undefined;
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
      primeStartupSession(key, true);
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
    primeStartupSession(dataKey);
    const admissionOptions = {
      repository: asyncMode
        ? anchorSession.repository
        : createAnchorRepository({ directory, dataKey }),
      // Only the engine's actual empty-schema branch can use this capability.
      // An existing schema with a missing anchor always fails closed.
      allowEnrollment: true,
      clockOnlyScans: true,
    };
    const readiness = asyncMode ? waitForRecoveryAnchorStartupSession(startupSession) : null;
    if (!readiness)
      anchor = asyncMode
        ? createRecoveryAsyncAnchorAdmission(admissionOptions, anchorSession)
        : createRecoveryAnchorAdmission(admissionOptions);
    // Consume readiness before synchronous SQL or manifest work can starve IPC.
    // This yields no request authority and retains the original native deadline.
    const keyMaterial = { value: dataKey };
    return readiness
      ? prepareAsyncAdmission(readiness, keyMaterial, admissionOptions)
      : prepareEngine(keyMaterial);
  } catch {
    return failStartup();
  }
}

function createStorageOwner(options, dependencies) {
  return createOwner(options, dependencies);
}
function createAsyncStorageOwner(options, dependencies) {
  return createOwner(options, dependencies, true);
}

module.exports = { createStorageOwner, createAsyncStorageOwner };
