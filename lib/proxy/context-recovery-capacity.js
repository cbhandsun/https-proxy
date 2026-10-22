'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');

// Version 8 changes count admission. Version 9 adds original-byte capacity;
// source size, absolute expiry and read budgets keep their separate limits.
const RECOVERY_ROOT_VERSION = 10;
const RECOVERY_MAX_SNAPSHOTS = 2048;
const legacy = Object.freeze({ maxCalls: 128, maxSources: 64, maxSnapshots: 256 });
const daily = Object.freeze({ maxCalls: 1024, maxSources: 512, maxSnapshots: 512 });
const large = Object.freeze({ ...daily });
const privateLarge = Object.freeze({ ...daily });

function recoveryRootCapacity(version) {
  if (version === 10) return privateLarge;
  if (version === 9) return large;
  if (version === 8) return daily;
  if (Number.isSafeInteger(version) && version >= 1 && version <= 7) return legacy;
  throw new TypeError('invalid_context_recovery_capacity_version');
}

function recoveryRootOriginalBytes(version) {
  recoveryRootCapacity(version);
  return version >= 9 ? 16 * 1024 * 1024 : 4 * 1024 * 1024;
}

// Includes in-flight writes and retained denial journals. Old roots keep their
// shared 256-entry ceiling even when new roots coexist in the same owner.
function validateRecoveryPublicationCounts(input) {
  const entries = normalizeCompactionData(input, 16 * 1024);
  if (!Array.isArray(entries) || entries.length > 256)
    throw new TypeError('invalid_context_recovery_publication_capacity');
  let total = 0,
    old = 0;
  for (const entry of entries) {
    if (!entry || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'count,version')
      throw new TypeError('invalid_context_recovery_publication_capacity');
    const capacity = recoveryRootCapacity(entry.version);
    if (
      !Number.isSafeInteger(entry.count) ||
      entry.count < 0 ||
      entry.count > capacity.maxSnapshots
    )
      throw new TypeError('invalid_context_recovery_publication_capacity');
    total += entry.count;
    if (capacity === legacy) old += entry.count;
  }
  if (total > RECOVERY_MAX_SNAPSHOTS || old > legacy.maxSnapshots)
    throw new TypeError('invalid_context_recovery_publication_capacity');
}

module.exports = {
  RECOVERY_ROOT_VERSION,
  RECOVERY_MAX_SNAPSHOTS,
  recoveryRootCapacity,
  recoveryRootOriginalBytes,
  validateRecoveryPublicationCounts,
};
