'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { recoveryRootCapacity } = require('./context-recovery-capacity');

const LEGACY_STORAGE_BYTES = 32 * 1024 * 1024;
const RECOVERY_STORAGE_BYTES = 512 * 1024 * 1024;
const RECOVERY_DATABASE_BYTES = 1024 * 1024 * 1024;
const RECOVERY_DIRECTORY_BYTES = 2 * RECOVERY_DATABASE_BYTES + 2 * 1024 * 1024;
const RECOVERY_PENDING_BYTES = 128 * 1024 * 1024;

function validateRecoveryStorageUsage(input) {
  const entries = normalizeCompactionData(input, 4096);
  if (!Array.isArray(entries) || entries.length > 4)
    throw new TypeError('invalid_recovery_storage_usage');
  let bytes = 0,
    legacyBytes = 0;
  for (const entry of entries) {
    if (
      !entry ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'bytes,sources,version' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !Number.isSafeInteger(entry.sources) ||
      entry.sources < 0
    )
      throw new TypeError('invalid_recovery_storage_usage');
    const capacity = entry.version === null ? null : recoveryRootCapacity(entry.version);
    if (entry.sources > (capacity?.maxSources ?? 0))
      throw new TypeError('invalid_recovery_storage_usage');
    bytes += entry.bytes;
    if (entry.version === 9 || entry.version === 10) {
      if (entry.bytes > 128 * 1024 * 1024) throw new TypeError('invalid_recovery_storage_usage');
    } else legacyBytes += entry.bytes;
  }
  if (legacyBytes > LEGACY_STORAGE_BYTES || bytes > RECOVERY_STORAGE_BYTES)
    throw new TypeError('invalid_recovery_storage_usage');
  return { records: entries.length, bytes };
}

module.exports = {
  LEGACY_STORAGE_BYTES,
  RECOVERY_STORAGE_BYTES,
  RECOVERY_DATABASE_BYTES,
  RECOVERY_DIRECTORY_BYTES,
  RECOVERY_PENDING_BYTES,
  validateRecoveryStorageUsage,
};
