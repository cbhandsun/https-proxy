'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { types } = require('node:util');
const {
  createStorageFailureReporter,
  parseStorageFailureDiagnostic,
  storageExecutionFailure,
} = require('./context-recovery-storage-failure');
const { storageDirectory } = require('./context-recovery-storage-paths');
const { createStorageStartupProgress } = require('./context-recovery-storage-progress');
const { parseStoredEvidencePage } = require('./context-evidence-stored-page');
const {
  STORAGE_TTL_MS,
  storageEnvelopeData,
  storageReplyData,
  storageState,
  storageRequest,
  storageCatalog,
  storageFailure,
  storageScanPage,
  storageReferenceScanPage,
  declareRecoveryScan,
  declareRecoverySourcePages,
  declareRecoveryReaderSettlement,
  declareRecoveryReferenceWrites,
  declareRecoveryReferenceStates,
  declareRecoveryReferenceAdmission,
  declareRecoveryReferenceScan,
  declareRecoveryReadSettlement,
} = require('./context-recovery-storage-contract');
const { parseReferenceState } = require('./context-recovery-reference-state');
const { version9StorageEnvelope } = require('./context-recovery-storage-data');
const {
  RECOVERY_STORAGE_BYTES,
  RECOVERY_DIRECTORY_BYTES,
  RECOVERY_PENDING_BYTES,
} = require('./context-recovery-storage-quota');

function validateResult(operation, input, after) {
  // These parsers already clone and validate the complete page. Bind the
  // original request cursor here instead of parsing the same reply again.
  if (operation === 'scan') return storageScanPage(input, after);
  if (operation === 'scan-reference') return storageReferenceScanPage(input, after);
  const result = storageReplyData(input, operation);
  if (operation === 'read-source-and-settle') return result;
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const keys = (value) => value && !Array.isArray(value) && Object.keys(value).sort().join(',');
  if (operation === 'close' && result === null) return result;
  if (operation === 'catalog') return storageCatalog(result);
  if (operation === 'read-source') {
    try {
      return parseStoredEvidencePage(result);
    } catch {
      throw storageFailure();
    }
  }
  if (operation === 'sweep') {
    if (
      keys(result) === 'removedBytes,removedRecords' &&
      Number.isSafeInteger(result.removedRecords) &&
      result.removedRecords >= 0 &&
      result.removedRecords <= 256 &&
      Number.isSafeInteger(result.removedBytes) &&
      result.removedBytes >= 0 &&
      result.removedBytes <= RECOVERY_DIRECTORY_BYTES &&
      (result.removedRecords === 0
        ? result.removedBytes === 0
        : result.removedBytes >= result.removedRecords * 30)
    )
      return result;
    throw storageFailure();
  }
  if (['revoke-all', 'revoke-scopes'].includes(operation)) {
    if (
      keys(result) === 'revoked' &&
      Number.isSafeInteger(result.revoked) &&
      result.revoked >= 0 &&
      result.revoked <= (operation === 'revoke-all' ? 256 : 4)
    )
      return result;
    throw storageFailure();
  }
  if (operation === 'load-reference') {
    if (result === null) return result;
    if (
      keys(result) !== 'createdAt,expiresAt,reference,revision' ||
      !positive(result.revision) ||
      !Number.isSafeInteger(result.createdAt) ||
      result.createdAt < 0 ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= result.createdAt ||
      result.expiresAt - result.createdAt > STORAGE_TTL_MS
    )
      throw storageFailure();
    try {
      result.reference = parseReferenceState(result.reference);
      if (result.reference.metadata.expiresAt !== result.expiresAt) throw storageFailure();
      return result;
    } catch {
      throw storageFailure();
    }
  }
  if (operation === 'load') {
    if (result === null) return result;
    if (
      keys(result) === 'createdAt,expiresAt,revision,state' &&
      positive(result.revision) &&
      Number.isSafeInteger(result.createdAt) &&
      result.createdAt >= 0 &&
      Number.isSafeInteger(result.expiresAt) &&
      result.expiresAt > result.createdAt &&
      result.expiresAt - result.createdAt <= STORAGE_TTL_MS &&
      result.state &&
      typeof result.state === 'object' &&
      !Array.isArray(result.state)
    ) {
      result.state = storageState(result.state);
      return result;
    }
  } else if (operation === 'inspect') {
    if (
      keys(result) === 'bytes,records' &&
      Number.isSafeInteger(result.records) &&
      result.records >= 0 &&
      result.records <= 4 &&
      Number.isSafeInteger(result.bytes) &&
      result.bytes >= 0 &&
      result.bytes <= RECOVERY_STORAGE_BYTES
    )
      return result;
  } else if (
    ['save', 'save-reference', 'save-reference-state', 'revoke', 'settle-reader'].includes(
      operation
    ) &&
    keys(result) === 'revision' &&
    positive(result.revision)
  )
    return result;
  throw storageFailure();
}

function openContextRecoveryStorage(options = {}) {
  let root, WorkerType, timeoutMs, onStartup, onFailure;
  try {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      types.isProxy(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      throw storageFailure();
    const safe = {};
    for (const name of Reflect.ownKeys(options)) {
      const descriptor = Object.getOwnPropertyDescriptor(options, name);
      if (
        !['directory', 'WorkerType', 'timeoutMs', 'onStartup', 'onFailure'].includes(name) ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      )
        throw storageFailure();
      safe[name] = descriptor.value;
    }
    root = storageDirectory(safe.directory);
    WorkerType = safe.WorkerType === undefined ? Worker : safe.WorkerType;
    timeoutMs = safe.timeoutMs === undefined ? 30000 : safe.timeoutMs;
    onStartup = safe.onStartup;
    onFailure = safe.onFailure;
    if (
      typeof WorkerType !== 'function' ||
      (onStartup !== undefined && typeof onStartup !== 'function') ||
      (onFailure !== undefined && (typeof onFailure !== 'function' || types.isProxy(onFailure))) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 60000
    )
      throw storageFailure();
  } catch {
    return Promise.reject(storageFailure());
  }
  return new Promise((resolveOpen, rejectOpen) => {
    const startupProgress = createStorageStartupProgress(onStartup);
    let worker,
      openTimer,
      closeTimer,
      ready = false,
      failed = false,
      closing = false,
      closed = false,
      closeAcknowledged = false,
      sequence = 1,
      pendingBytes = 0,
      closePromise,
      resolveClose,
      rejectClose;
    const pending = new Map();
    const reportFailure = createStorageFailureReporter(onFailure);
    function fail() {
      if (failed || closed) return;
      failed = true;
      if (!ready) startupProgress.finish(false);
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
      rejectOpen(storageFailure());
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        const diagnostic = { phase: 'worker-unavailable', cleanupFailed: false };
        reportFailure(item.operation, diagnostic);
        item.reject(storageExecutionFailure(diagnostic.phase));
      }
      pending.clear();
      pendingBytes = 0;
      rejectClose?.(storageFailure());
      // Cleanup failure cannot reopen this service or make close() successful.
      // Every public operation remains failed even if termination itself rejects.
      try {
        Promise.resolve(worker?.terminate()).then(
          () => {},
          () => {}
        );
      } catch {
        /* This service is already terminally failed. */
      }
    }
    function send(request, closingRequest = false) {
      return new Promise((resolve, reject) => {
        let bytes;
        try {
          if (
            !ready ||
            failed ||
            closed ||
            (closing && !closingRequest) ||
            sequence >= Number.MAX_SAFE_INTEGER
          )
            throw storageFailure();
          bytes = Buffer.byteLength(JSON.stringify(request));
          const large = version9StorageEnvelope(request, 'request');
          const legacyBytes = [...pending.values()].reduce(
            (sum, item) => sum + (item.large ? 0 : item.bytes),
            0
          );
          if (
            !closingRequest &&
            (pending.size >= 8 ||
              pendingBytes + bytes > RECOVERY_PENDING_BYTES ||
              (!large && legacyBytes + bytes > 16 * 1024 * 1024))
          )
            throw storageFailure();
        } catch {
          reject(storageFailure());
          return;
        }
        const id = sequence++;
        const item = {
          resolve,
          reject,
          bytes,
          large: version9StorageEnvelope(request, 'request'),
          operation: request.operation,
          expectedRevision: request.expectedRevision,
          after: request.after,
          expectedRevoked:
            request.operation === 'revoke-scopes' ? request.entries.length : undefined,
          timer: setTimeout(fail, timeoutMs),
        };
        pending.set(id, item);
        pendingBytes += bytes;
        try {
          worker.postMessage({ id, request });
        } catch {
          fail();
        }
      });
    }
    const service = {
      execute: declareRecoverySourcePages(
        declareRecoveryScan(function (input) {
          try {
            return send(storageRequest(input));
          } catch {
            return Promise.reject(storageFailure());
          }
        })
      ),
      close() {
        if (closePromise) return closePromise;
        if (failed) return Promise.reject(storageFailure());
        if (closed) return Promise.resolve();
        closing = true;
        closePromise = new Promise((resolve, reject) => {
          resolveClose = resolve;
          rejectClose = reject;
        });
        closeTimer = setTimeout(fail, timeoutMs);
        send({ operation: 'close' }, true).then(() => {}, fail);
        return closePromise;
      },
    };
    declareRecoveryReaderSettlement(service.execute);
    declareRecoveryReadSettlement(service.execute);
    declareRecoveryReferenceWrites(service.execute);
    declareRecoveryReferenceStates(service.execute);
    declareRecoveryReferenceAdmission(service.execute);
    declareRecoveryReferenceScan(service.execute);
    try {
      worker = new WorkerType(path.join(__dirname, 'context-recovery-storage-worker.js'), {
        // Process-only preloads must not replay the daemon's one-time start gate.
        execArgv: [],
        workerData: { directory: root },
        stdout: true,
        stderr: true,
      });
      worker.stdout?.resume();
      worker.stderr?.resume();
      openTimer = setTimeout(fail, timeoutMs);
      worker.on('error', fail);
      worker.on('exit', (code) => {
        // A valid shutdown response must arrive before a successful exit.
        if (!failed && closing && code === 0 && closeAcknowledged && pending.size === 0) {
          closed = true;
          clearTimeout(closeTimer);
          resolveClose();
        } else fail();
      });
      worker.on('message', (input) => {
        if (failed || closed) return;
        try {
          const message = storageEnvelopeData(input, 'worker-result');
          if (
            !message ||
            Array.isArray(message) ||
            !Number.isSafeInteger(message.id) ||
            typeof message.ok !== 'boolean'
          )
            throw storageFailure();
          const keys = Object.keys(message).sort().join(',');
          if (!ready) {
            if (keys === 'id,ok,phase' && message.id === 0 && message.ok) {
              startupProgress.advance(message.phase);
              return;
            }
            if (keys !== 'id,ok' || message.id !== 0 || !message.ok) throw storageFailure();
            ready = true;
            clearTimeout(openTimer);
            startupProgress.finish(true);
            resolveOpen(service);
            return;
          }
          if (message.id === 0 && message.ok === false && keys === 'diagnostic,id,ok') {
            const diagnostic = parseStorageFailureDiagnostic(message.diagnostic);
            reportFailure('sweep', diagnostic);
            fail();
            return;
          }
          const item = pending.get(message.id);
          if (
            !item ||
            (message.ok ? keys !== 'id,ok,result' : !['id,ok', 'diagnostic,id,ok'].includes(keys))
          )
            throw storageFailure();
          const diagnostic = message.ok
            ? null
            : message.diagnostic === undefined
              ? { phase: 'worker-rejected', cleanupFailed: false }
              : parseStorageFailureDiagnostic(message.diagnostic);
          const result = message.ok
            ? validateResult(item.operation, message.result, item.after)
            : undefined;
          if (
            message.ok &&
            item.operation === 'revoke-scopes' &&
            result.revoked !== item.expectedRevoked
          )
            throw storageFailure();
          if (
            message.ok &&
            ['save', 'revoke', 'read-source-and-settle'].includes(item.operation) &&
            result.revision !== item.expectedRevision + 1
          )
            throw storageFailure();
          if (message.ok && item.operation === 'close') closeAcknowledged = true;
          pending.delete(message.id);
          pendingBytes -= item.bytes;
          clearTimeout(item.timer);
          if (message.ok) item.resolve(result);
          else {
            reportFailure(item.operation, diagnostic);
            item.reject(storageExecutionFailure(diagnostic.phase, diagnostic.cleanupFailed));
          }
        } catch {
          fail();
        }
      });
    } catch {
      fail();
    }
  });
}

module.exports = { openContextRecoveryStorage, validateStorageResult: validateResult };
