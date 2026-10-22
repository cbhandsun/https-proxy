'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const {
  RECOVERY_STATE_BYTES,
  normalizeRecoveryStateData,
} = require('./context-recovery-state-data');

const own = (value, name) =>
  value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined;
const checkpoint = (value) =>
  own(value, 'kind') === 'recovery-write-ahead' &&
  own(own(value, 'root'), 'kind') === 'recovery-root' &&
  [9, 10].includes(own(own(value, 'root'), 'version'));
const LEGACY_MANIFEST_BYTES = 12 * 1024 * 1024;
const RECOVERY_MANIFEST_BYTES = 16 * 1024 * 1024 + 4096;
function storageManifestMaximum(value) {
  if (own(value, 'kind') !== 'recovery-referenced-checkpoint') return LEGACY_MANIFEST_BYTES;
  const version = own(value, 'version');
  const state = version === 2 ? own(value, 'checkpoint') : own(value, 'reference');
  const daily =
    version === 2
      ? checkpoint(state) && own(own(state, 'root'), 'version') === 10
      : version === 3 &&
        own(state, 'kind') === 'recovery-reference-state' &&
        own(state, 'version') === 1 &&
        own(own(state, 'metadata'), 'kind') === 'recovery-root-metadata' &&
        own(own(state, 'metadata'), 'sourceVersion') === 10;
  return daily ? RECOVERY_MANIFEST_BYTES : LEGACY_MANIFEST_BYTES;
}
function request(value) {
  const operation = own(value, 'operation');
  if (operation === 'save') return checkpoint(own(value, 'state'));
  if (!['save-reference', 'save-reference-state'].includes(operation)) return false;
  const reference = own(value, 'reference');
  return (
    own(reference, 'version') === 1 &&
    own(reference, 'kind') ===
      (operation === 'save-reference' ? 'recovery-reference-write' : 'recovery-reference-state') &&
    own(own(reference, 'metadata'), 'kind') === 'recovery-root-metadata' &&
    [9, 10].includes(own(own(reference, 'metadata'), 'sourceVersion'))
  );
}
function version9StorageEnvelope(input, kind) {
  if (kind === 'state') return checkpoint(input);
  if (kind === 'request') return request(input);
  if (kind === 'record' || kind === 'reference-record') return checkpoint(own(input, 'state'));
  if (kind === 'scan' || kind === 'scan-reference')
    return checkpoint(own(own(input, 'record'), 'state'));
  if (kind === 'worker-request') return request(own(input, 'request'));
  if (kind === 'worker-result') {
    const value = own(input, 'result');
    return checkpoint(own(value, 'state')) || checkpoint(own(own(value, 'record'), 'state'));
  }
  throw new TypeError('invalid_recovery_storage_envelope');
}

// Only named storage representations can select the larger byte capability.
// This is shape/size admission, never ownership or authority. Existing codecs
// still validate versions, hashes, policies, aggregate raw bytes and revisions.
function normalizeStorageEnvelope(input, kind) {
  const large = version9StorageEnvelope(input, kind);
  if (kind === 'state' && storageManifestMaximum(input) === RECOVERY_MANIFEST_BYTES)
    return normalizeRecoveryStateData(input, RECOVERY_MANIFEST_BYTES);
  const reference = (value) =>
    own(value, 'kind') === 'recovery-reference-state' &&
    own(value, 'version') === 1 &&
    own(own(value, 'metadata'), 'kind') === 'recovery-root-metadata' &&
    own(own(value, 'metadata'), 'sourceVersion') === 10;
  const reply = kind === 'worker-result' ? own(input, 'result') : input;
  const dailyReference =
    kind !== 'state' &&
    (reference(own(reply, 'reference')) || reference(own(own(reply, 'record'), 'reference')));
  const slack = kind === 'state' ? 0 : kind.startsWith('worker-') ? 8192 : 4096;
  return large
    ? normalizeRecoveryStateData(input, RECOVERY_STATE_BYTES + Math.min(slack, 4096))
    : dailyReference
      ? normalizeRecoveryStateData(input, 16 * 1024 * 1024 + slack)
      : normalizeCompactionData(input, 12 * 1024 * 1024 + slack);
}

module.exports = {
  normalizeStorageEnvelope,
  version9StorageEnvelope,
  storageManifestMaximum,
  RECOVERY_MANIFEST_BYTES,
};
