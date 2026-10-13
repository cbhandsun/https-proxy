'use strict';

const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

function boundedInteger(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function artifactLifecyclePolicy(options, limits) {
  const { ttlMs, maxBytes, maxEntries, maxArtifactBytes } = limits;
  const maxLifetimeMs = Math.max(
    ttlMs,
    boundedInteger(options.maxLifetimeMs, DEFAULT_MAX_LIFETIME_MS, MAX_LIFETIME_MS)
  );
  const maxOwnerBytes = Math.max(
    maxArtifactBytes,
    boundedInteger(options.maxOwnerBytes, Math.min(maxBytes, 8 * 1024 * 1024), maxBytes)
  );
  const maxSessionBytes = Math.max(
    maxArtifactBytes,
    boundedInteger(options.maxSessionBytes, Math.min(maxOwnerBytes, 4 * 1024 * 1024), maxOwnerBytes)
  );
  const maxOwnerEntries = boundedInteger(
    options.maxOwnerEntries,
    Math.min(maxEntries, 128),
    maxEntries
  );
  const maxSessionEntries = boundedInteger(
    options.maxSessionEntries,
    Math.min(maxOwnerEntries, 64),
    maxOwnerEntries
  );
  return { maxLifetimeMs, maxOwnerBytes, maxSessionBytes, maxOwnerEntries, maxSessionEntries };
}

// A live receipt is a lease, not a FIFO candidate. Reject new evidence rather
// than invalidate receipts already handed to this task or another task.
function canAdmitArtifact(records, owner, session, bytes, limits) {
  const usage = {
    bytes: 0,
    entries: 0,
    ownerBytes: 0,
    ownerEntries: 0,
    sessionBytes: 0,
    sessionEntries: 0,
  };
  for (const record of records.values()) {
    usage.bytes += record.bytes;
    usage.entries += 1;
    if (record.owner !== owner) continue;
    usage.ownerBytes += record.bytes;
    usage.ownerEntries += 1;
    if (record.session !== session) continue;
    usage.sessionBytes += record.bytes;
    usage.sessionEntries += 1;
  }
  const fits = () =>
    usage.bytes + bytes <= limits.maxBytes &&
    usage.entries + 1 <= limits.maxEntries &&
    usage.ownerBytes + bytes <= limits.maxOwnerBytes &&
    usage.ownerEntries + 1 <= limits.maxOwnerEntries &&
    usage.sessionBytes + bytes <= limits.maxSessionBytes &&
    usage.sessionEntries + 1 <= limits.maxSessionEntries;
  return fits();
}

module.exports = {
  MAX_LIFETIME_MS,
  DEFAULT_MAX_LIFETIME_MS,
  artifactLifecyclePolicy,
  canAdmitArtifact,
};
