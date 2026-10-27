'use strict';

const { openContextRecoveryStorage, validateStorageResult } = require('./context-recovery-storage');
const { storageDirectory } = require('./context-recovery-storage-paths');
const {
  storageRequest,
  storageFailure,
  declareRecoveryScan,
  supportsRecoveryScan,
  declareRecoverySourcePages,
  supportsRecoverySourcePages,
  declareRecoveryReaderSettlement,
  supportsRecoveryReaderSettlement,
  declareRecoveryReferenceWrites,
  supportsRecoveryReferenceWrites,
  declareRecoveryReferenceStates,
  supportsRecoveryReferenceStates,
  declareRecoveryReferenceAdmission,
  supportsRecoveryReferenceAdmission,
  storageScanPage,
  storageReferenceScanPage,
  declareRecoveryReferenceScan,
  supportsRecoveryReferenceScan,
  declareRecoveryReadSettlement,
  supportsRecoveryReadSettlement,
} = require('./context-recovery-storage-contract');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { aliasRecoveryStorageInventory } = require('./context-recovery-storage-inventory');

// A synchronous storage capability with asynchronous opening. Passing this to
// session initialization installs its existing startup barrier before any await.
// It neither restores authority nor changes the worker's native deadlines.
function createContextRecoveryStorageOpening(options = {}) {
  let directory, openStorage, onStartup;
  try {
    if (
      !options ||
      Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      throw storageFailure();
    for (const key of Reflect.ownKeys(options)) {
      const slot = Object.getOwnPropertyDescriptor(options, key);
      if (
        !['directory', 'openStorage', 'onStartup'].includes(key) ||
        !slot?.enumerable ||
        !Object.hasOwn(slot, 'value')
      )
        throw storageFailure();
    }
    directory = storageDirectory(options.directory);
    openStorage =
      options.openStorage === undefined ? openContextRecoveryStorage : options.openStorage;
    onStartup = options.onStartup;
    if (
      typeof openStorage !== 'function' ||
      (onStartup !== undefined && typeof onStartup !== 'function')
    )
      throw storageFailure();
  } catch {
    throw storageFailure();
  }
  let execute,
    inventorySource,
    closeStorage,
    closing = false,
    closed = false,
    failed = false,
    opened = false;
  let bytes = 0,
    closePromise,
    resourceClose;
  const pending = new Set();
  function closeOnce() {
    if (resourceClose) return resourceClose;
    resourceClose = (async () => {
      try {
        if (closeStorage) {
          const reply = closeStorage();
          const result = nativeReaderPromise(reply) ? await reply : reply;
          if (result !== undefined) throw storageFailure();
        }
      } catch {
        failed = true;
        throw storageFailure();
      }
    })();
    return resourceClose;
  }
  const ready = (async () => {
    try {
      const candidate = openStorage({ directory, ...(onStartup ? { onStartup } : {}) });
      const storage = nativeReaderPromise(candidate) ? await candidate : candidate;
      if (!storage || ![Object.prototype, null].includes(Object.getPrototypeOf(storage)))
        throw storageFailure();
      const close = Object.getOwnPropertyDescriptor(storage, 'close');
      if (typeof close?.value === 'function') closeStorage = close.value.bind(storage);
      if (Reflect.ownKeys(storage).sort().join(',') !== 'close,execute') throw storageFailure();
      const operation = Object.getOwnPropertyDescriptor(storage, 'execute');
      if (
        !close?.enumerable ||
        !operation?.enumerable ||
        !closeStorage ||
        typeof operation.value !== 'function'
      )
        throw storageFailure();
      execute = operation.value.bind(storage);
      inventorySource = storage;
      if (supportsRecoveryScan(operation.value)) declareRecoveryScan(execute);
      if (supportsRecoverySourcePages(operation.value)) declareRecoverySourcePages(execute);
      if (supportsRecoveryReaderSettlement(operation.value))
        declareRecoveryReaderSettlement(execute);
      if (supportsRecoveryReferenceWrites(operation.value)) declareRecoveryReferenceWrites(execute);
      if (supportsRecoveryReferenceStates(operation.value)) declareRecoveryReferenceStates(execute);
      if (supportsRecoveryReferenceAdmission(operation.value))
        declareRecoveryReferenceAdmission(execute);
      if (supportsRecoveryReferenceScan(operation.value)) declareRecoveryReferenceScan(execute);
      if (supportsRecoveryReadSettlement(operation.value)) declareRecoveryReadSettlement(execute);
      opened = true;
    } catch {
      failed = true;
      try {
        await closeOnce();
      } catch {
        /* The failed opening remains terminal. */
      }
      throw storageFailure();
    }
  })();
  // An unused capability must not produce an unhandled opening rejection.
  void ready.catch(() => {});
  const service = {
    execute(input) {
      let request, size;
      try {
        if (failed || closing || closed) throw storageFailure();
        request = storageRequest(input);
        size = Buffer.byteLength(JSON.stringify(request));
        if (pending.size >= 8 || bytes + size > 16 * 1024 * 1024) throw storageFailure();
      } catch {
        return Promise.reject(storageFailure());
      }
      bytes += size;
      const task = (async () => {
        try {
          await ready;
          if (failed || closed) throw storageFailure();
          const reply = execute(request);
          let asynchronous;
          try {
            asynchronous = nativeReaderPromise(reply);
          } catch {
            failed = true;
            throw storageFailure();
          }
          const input = asynchronous ? await reply : reply;
          try {
            const result = validateStorageResult(request.operation, input);
            if (request.operation === 'scan') storageScanPage(result, request.after);
            if (request.operation === 'scan-reference')
              storageReferenceScanPage(result, request.after);
            if (
              ([
                'save',
                'save-reference',
                'save-reference-state',
                'revoke',
                'settle-reader',
                'read-source-and-settle',
              ].includes(request.operation) &&
                result.revision !== request.expectedRevision + 1) ||
              (request.operation === 'revoke-scopes' && result.revoked !== request.entries.length)
            )
              throw storageFailure();
            return result;
          } catch {
            failed = true;
            throw storageFailure();
          }
        } catch {
          throw storageFailure();
        } finally {
          bytes -= size;
        }
      })();
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task)
      );
      return task;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        try {
          await ready;
        } catch {
          failed = true;
        }
        await Promise.allSettled([...pending]);
        try {
          await closeOnce();
        } catch {
          failed = true;
        }
        closed = true;
        if (failed) throw storageFailure();
      })();
      return closePromise;
    },
    inspect() {
      return {
        state: failed
          ? 'failed'
          : closed
            ? 'closed'
            : closing
              ? 'closing'
              : opened
                ? 'ready'
                : 'opening',
        pending: pending.size,
        pendingBytes: bytes,
      };
    },
  };
  if (openStorage === openContextRecoveryStorage) declareRecoveryScan(service.execute);
  if (openStorage === openContextRecoveryStorage) declareRecoverySourcePages(service.execute);
  if (openStorage === openContextRecoveryStorage) declareRecoveryReaderSettlement(service.execute);
  if (openStorage === openContextRecoveryStorage) declareRecoveryReferenceWrites(service.execute);
  if (openStorage === openContextRecoveryStorage) declareRecoveryReferenceStates(service.execute);
  if (openStorage === openContextRecoveryStorage)
    declareRecoveryReferenceAdmission(service.execute);
  if (openStorage === openContextRecoveryStorage) declareRecoveryReferenceScan(service.execute);
  if (openStorage === openContextRecoveryStorage) declareRecoveryReadSettlement(service.execute);
  void ready.then(
    () => {
      aliasRecoveryStorageInventory(service, inventorySource);
      // Injectable adapters may opt in only after their actual capability opens.
      // The default worker protocol is known before startup discovery begins.
      if (openStorage !== openContextRecoveryStorage && supportsRecoveryScan(execute))
        declareRecoveryScan(service.execute);
      if (openStorage !== openContextRecoveryStorage && supportsRecoverySourcePages(execute))
        declareRecoverySourcePages(service.execute);
      if (openStorage !== openContextRecoveryStorage && supportsRecoveryReaderSettlement(execute))
        declareRecoveryReaderSettlement(service.execute);
      if (openStorage !== openContextRecoveryStorage && supportsRecoveryReferenceWrites(execute))
        declareRecoveryReferenceWrites(service.execute);
      if (openStorage !== openContextRecoveryStorage && supportsRecoveryReferenceStates(execute))
        declareRecoveryReferenceStates(service.execute);
      if (openStorage !== openContextRecoveryStorage && supportsRecoveryReferenceAdmission(execute))
        declareRecoveryReferenceAdmission(service.execute);
      if (openStorage !== openContextRecoveryStorage && supportsRecoveryReferenceScan(execute))
        declareRecoveryReferenceScan(service.execute);
      if (openStorage !== openContextRecoveryStorage && supportsRecoveryReadSettlement(execute))
        declareRecoveryReadSettlement(service.execute);
    },
    () => {}
  );
  return service;
}

module.exports = { createContextRecoveryStorageOpening };
