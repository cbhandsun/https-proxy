'use strict';

const { createHash } = require('node:crypto');
const {
  storageReplyData,
  storageCatalog,
  storageFailure,
  STORAGE_TTL_MS,
} = require('./context-recovery-storage-contract');
const { parseRootCheckpoint } = require('./context-recovery-root-checkpoint');
const { parseReferenceState } = require('./context-recovery-reference-state');

// Association and integrity validation only; this never creates read authority.
// Both startup discovery and current-request reconstruction use this boundary
// before filtering records by identity, so a mismatched record cannot hide a
// malformed checkpoint. Callers separately check catalog generation/uniqueness.
function parseRecord(input, metadata, referenceOnly) {
  try {
    const [entry] = storageCatalog([metadata]);
    const record = storageReplyData(input, referenceOnly ? 'load-reference' : 'load');
    if (
      !record ||
      Array.isArray(record) ||
      Object.keys(record).sort().join(',') !==
        (referenceOnly
          ? 'createdAt,expiresAt,reference,revision'
          : 'createdAt,expiresAt,revision,state') ||
      ['revision', 'createdAt', 'expiresAt'].some((key) => record[key] !== entry[key])
    )
      throw storageFailure();
    if (referenceOnly) record.reference = parseReferenceState(record.reference);
    const root = referenceOnly ? record.reference.metadata : record.state?.root;
    if (
      !root ||
      typeof root.rootId !== 'string' ||
      !/^hbs_[a-f0-9]{32}$/.test(root.rootId) ||
      typeof root.principal !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(root.principal) ||
      !Number.isSafeInteger(root.createdAt) ||
      root.createdAt < 0 ||
      root.createdAt > entry.createdAt ||
      root.expiresAt !== entry.expiresAt ||
      root.expiresAt - root.createdAt > STORAGE_TTL_MS ||
      createHash('sha256')
        .update('hpm/recovery-root/v1\0' + root.rootId)
        .digest('hex') !== entry.scope
    )
      throw storageFailure();
    if (!referenceOnly) parseRootCheckpoint(record.state, root);
    return record;
  } catch {
    throw storageFailure();
  }
}
function parseRecoveryStorageRecord(input, metadata) {
  return parseRecord(input, metadata, false);
}
function parseRecoveryReferenceRecord(input, metadata) {
  return parseRecord(input, metadata, true);
}

module.exports = { parseRecoveryStorageRecord, parseRecoveryReferenceRecord };
