'use strict';

const { storageReplyData, storageFailure } = require('./context-recovery-storage-contract');
const {
  supportsRecoveryScan,
  supportsRecoveryReferenceScan,
} = require('./context-recovery-storage-contract');
const {
  visitRecoveryStorage,
  visitRecoveryReferenceStorage,
} = require('./context-recovery-storage-scan');
const { parseRecoveryStorageRecord } = require('./context-recovery-storage-record');
const { referenceStateFromCheckpoint } = require('./context-recovery-reference-state');
const {
  nativeReaderPromise,
  rejectAsyncReaderResult,
} = require('./context-recovery-reader-result');
const { cleanupRecoveryStaging } = require('./context-recovery-storage-staging');

// Startup denial-index discovery only. No ledger, source, snapshot, binding,
// publication or read capability escapes this boundary. Current authorization
// and publication filtering must still precede any subsequent session import.
async function discoverRecoveryStorage(storage, available = () => true) {
  try {
    const slot = storage && Object.getOwnPropertyDescriptor(storage, 'execute');
    if (typeof slot?.value !== 'function' || typeof available !== 'function')
      throw storageFailure();
    function check() {
      const result = available();
      rejectAsyncReaderResult(result);
      if (result !== true) throw storageFailure();
    }
    async function call(request) {
      check();
      const result = slot.value.call(storage, request);
      const value = storageReplyData(
        nativeReaderPromise(result) ? await result : result,
        request.operation
      );
      check();
      return value;
    }
    const roots = [];
    const records = [];
    const referenceOnly = supportsRecoveryReferenceScan(slot.value);
    const visit = (entry, record) => {
      const root = referenceOnly ? record.reference.metadata : record.state.root;
      records.push({ entry, record });
      roots.push({
        rootId: root.rootId,
        principal: root.principal,
        createdAt: root.createdAt,
        expiresAt: root.expiresAt,
      });
    };
    if (referenceOnly) await visitRecoveryReferenceStorage(call, visit);
    else await visitRecoveryStorage(call, supportsRecoveryScan(slot.value), visit);
    if (referenceOnly) {
      const staged = [];
      // An interrupted owner can leave unpublished raw payloads. Explicitly
      // authenticate those legacy cleanup records; never hydrate ordinary roots.
      for (const { entry, record } of records) {
        if (!record.reference.stagedSources.length) continue;
        const full = parseRecoveryStorageRecord(
          await call({ operation: 'load', scope: entry.scope }),
          entry
        );
        if (referenceStateFromCheckpoint(full.state).digest !== record.reference.digest)
          throw storageFailure();
        staged.push({ entry, record: full });
      }
      await cleanupRecoveryStaging(
        staged,
        call,
        records.map(({ entry }) => entry)
      );
    } else await cleanupRecoveryStaging(records, call);
    check();
    return roots;
  } catch {
    throw storageFailure();
  }
}

module.exports = { discoverRecoveryStorage };
