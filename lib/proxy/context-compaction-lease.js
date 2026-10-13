'use strict';

const LOCAL_COMPACTION_PREFIX = 'hpm-local-compaction-v1:';
const RENEWABLE_COMPACTION_PREFIX = 'hpm-local-compaction-v2:';
const DEFAULT_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

function compactionTokenPrefix(token) {
  if (typeof token !== 'string') return null;
  return (
    [LOCAL_COMPACTION_PREFIX, RENEWABLE_COMPACTION_PREFIX].find((prefix) =>
      token.startsWith(prefix)
    ) || null
  );
}

function compactionLeasePolicy(options, ttlMs) {
  const renewable = options.renewable === undefined ? false : options.renewable;
  const maxLifetimeMs =
    options.maxLifetimeMs === undefined
      ? Math.max(ttlMs, DEFAULT_MAX_LIFETIME_MS)
      : options.maxLifetimeMs;
  if (
    typeof renewable !== 'boolean' ||
    !Number.isSafeInteger(maxLifetimeMs) ||
    maxLifetimeMs < ttlMs ||
    maxLifetimeMs > MAX_LIFETIME_MS
  ) {
    const error = new TypeError('Invalid local compaction lease policy');
    error.code = 'invalid_local_compaction';
    throw error;
  }
  return { renewable, maxLifetimeMs: renewable ? maxLifetimeMs : ttlMs };
}

module.exports = {
  LOCAL_COMPACTION_PREFIX,
  RENEWABLE_COMPACTION_PREFIX,
  compactionTokenPrefix,
  compactionLeasePolicy,
};
