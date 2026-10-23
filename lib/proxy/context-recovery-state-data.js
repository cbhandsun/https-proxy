'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { types } = require('node:util');

const {
  RECOVERY_STATE_BYTES,
  cloneRecoveryStateData,
} = require('./context-recovery-state-encoder');

function invalid() {
  return new TypeError('invalid_context_recovery_state_data');
}
function normalizeRecoveryStateData(input, maximum = RECOVERY_STATE_BYTES) {
  return cloneRecoveryStateData(input, maximum);
}

// The checkpoint carries its own root version. Read only data descriptors to
// choose a size category; semantic policy/owner checks still follow cloning.
// Legacy checkpoints never acquire the new byte capability through a caller.
function normalizeRecoveryCheckpointData(input) {
  if (types.isProxy(input)) throw invalid();
  const root =
    input && typeof input === 'object'
      ? Object.getOwnPropertyDescriptor(input, 'root')?.value
      : null;
  if (types.isProxy(root)) throw invalid();
  const version =
    root && typeof root === 'object'
      ? Object.getOwnPropertyDescriptor(root, 'version')?.value
      : null;
  return version === 9 || version === 10
    ? normalizeRecoveryStateData(input)
    : normalizeCompactionData(input, 12 * 1024 * 1024);
}

// Reference envelopes retain private history but omit original evidence bodies.
// Only the explicit v10 metadata capability selects the larger admission size.
function normalizeRecoveryReferenceData(input, legacyMaximum = 2 * 1024 * 1024) {
  if (![2 * 1024 * 1024, 12 * 1024 * 1024].includes(legacyMaximum)) throw invalid();
  const own = (value, key) =>
    value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  const metadata = own(input, 'kind') === 'recovery-root-metadata' ? input : own(input, 'metadata');
  return own(metadata, 'kind') === 'recovery-root-metadata' && own(metadata, 'sourceVersion') === 10
    ? normalizeRecoveryStateData(input, 16 * 1024 * 1024)
    : normalizeCompactionData(input, legacyMaximum);
}

module.exports = {
  RECOVERY_STATE_BYTES,
  normalizeRecoveryStateData,
  normalizeRecoveryCheckpointData,
  normalizeRecoveryReferenceData,
};
