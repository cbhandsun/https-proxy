'use strict';

// Admission limits, shared with diagnostics. Reading or reopening a root does
// not extend its original deadline. Changing these requires migration review.
const LEGACY_RECOVERY_TTL_MS = 30 * 60 * 1000;
const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const RECOVERY_MAX_ROOTS = 4;

function recoveryComponentTtl(version) {
  if (version === 1) return LEGACY_RECOVERY_TTL_MS;
  if (version === 2) return RECOVERY_TTL_MS;
  throw new TypeError('invalid_context_recovery_retention_version');
}

module.exports = {
  LEGACY_RECOVERY_TTL_MS,
  RECOVERY_TTL_MS,
  RECOVERY_MAX_ROOTS,
  recoveryComponentTtl,
};
