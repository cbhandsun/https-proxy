'use strict';

const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { storageFailure } = require('./context-recovery-storage-contract');
const { LEGACY_RECOVERY_TTL_MS, RECOVERY_TTL_MS } = require('./context-recovery-limits');
const { recoveryRootCapacity, recoveryRootOriginalBytes } = require('./context-recovery-capacity');

const V1_FIELDS =
  'binding,budget,callCount,createdAt,expiresAt,history,kind,ledger,observedAt,policyFingerprint,principal,protocol,rootId,snapshots,target,version';
const V2_FIELDS = V1_FIELDS.replace('policyFingerprint', 'policyBasis,policyFingerprint');
const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;

function hasResponsesSummary(binding, maximum) {
  if (own(binding, 'protocol') !== 'responses') return false;
  const snapshots = own(binding, 'snapshots');
  const length = own(snapshots, 'length');
  if (!Array.isArray(snapshots) || !Number.isSafeInteger(length) || length < 1 || length > maximum)
    throw storageFailure();
  for (let index = 0; index < length; index++) {
    const snapshot = own(snapshots, String(index));
    if (own(own(snapshot, 'window'), 'kind') === 'summary') return true;
  }
  return false;
}

// Shared schema boundary for already normalized roots. Inspect descriptors so
// direct misuse cannot run accessors. Policy validation stays within the same
// 2 MiB request/fingerprint bound, independently of the 12 MiB root ceiling.
function validateRecoveryRootPolicy(root) {
  try {
    if (!root || ![Object.prototype, null].includes(Object.getPrototypeOf(root)))
      throw storageFailure();
    const slots = Object.getOwnPropertyDescriptors(root);
    for (const key of Reflect.ownKeys(slots)) {
      const slot = slots[key];
      if (typeof key !== 'string' || !slot.enumerable || !Object.hasOwn(slot, 'value'))
        throw storageFailure();
    }
    const version = slots.version?.value;
    const hasPublicGeneration = Object.hasOwn(slots, 'publicGenerationFormat');
    if (
      hasPublicGeneration &&
      (slots.publicGenerationFormat.value !== 1 ||
        version < 6 ||
        slots.protocol?.value !== 'responses')
    )
      throw storageFailure();
    const capacity = recoveryRootCapacity(version);
    // Version 7 adds Responses summary-window semantics. An older reader must
    // reject that checkpoint before attempting to adopt any retained authority.
    const summary = hasResponsesSummary(slots.binding?.value, capacity.maxSnapshots);
    if (version < 7 && summary) throw storageFailure();
    const bindingFormat = own(slots.binding?.value, 'format');
    if (version >= 5 !== [2, 3].includes(bindingFormat) || (bindingFormat === 3 && version < 8))
      throw storageFailure();
    if (version < 6 && own(slots.history?.value, 'format') === 2) throw storageFailure();
    const fields = hasPublicGeneration
      ? V2_FIELDS.split(',').concat('publicGenerationFormat').sort().join(',')
      : version === 1
        ? V1_FIELDS
        : V2_FIELDS;
    if (Reflect.ownKeys(slots).sort().join(',') !== fields) throw storageFailure();
    if (version >= 4) {
      const snapshots = slots.snapshots.value;
      if (!Array.isArray(snapshots) || Object.getPrototypeOf(snapshots) !== Array.prototype)
        throw storageFailure();
      const length = own(snapshots, 'length');
      if (
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > capacity.maxSnapshots ||
        Reflect.ownKeys(snapshots).length !== length + 1
      )
        throw storageFailure();
      for (let index = 0; index < length; index++) {
        const slot = Object.getOwnPropertyDescriptor(snapshots, String(index));
        if (
          !slot?.enumerable ||
          !Object.hasOwn(slot, 'value') ||
          !Array.isArray(own(slot.value, 'pendingResults')) ||
          typeof own(slot.value, 'pendingReady') !== 'boolean' ||
          (version >= 6 && typeof own(slot.value, 'privateHistoryComplete') !== 'boolean') ||
          (hasPublicGeneration
            ? typeof own(slot.value, 'publicResponse') !== 'boolean'
            : Object.hasOwn(slot.value, 'publicResponse'))
        )
          throw storageFailure();
      }
    }
    if (
      version >= 2 &&
      fingerprintContextData(slots.policyBasis.value) !== slots.policyFingerprint.value
    )
      throw storageFailure();
    const createdAt = slots.createdAt.value;
    const expiresAt = slots.expiresAt.value;
    const longRetention =
      version === 3 || (version >= 4 && own(slots.binding.value, 'version') === 2);
    const ttlMs = longRetention ? RECOVERY_TTL_MS : LEGACY_RECOVERY_TTL_MS;
    const ledgerPolicy = own(slots.ledger.value, 'policy');
    if (
      own(ledgerPolicy, 'maxEntries') !== capacity.maxSources ||
      own(ledgerPolicy, 'maxOutputBytes') !== 1024 * 1024 ||
      own(ledgerPolicy, 'maxBytes') !== recoveryRootOriginalBytes(version)
    )
      throw storageFailure();
    if (
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt - createdAt !== ttlMs
    )
      throw storageFailure();
    const componentVersion = longRetention ? 2 : 1;
    const history = slots.history.value;
    const entries = own(history, 'entries');
    const historyVersion = own(history, 'version');
    if (historyVersion === 3 && (version < 10 || own(history, 'rootId') !== slots.rootId.value))
      throw storageFailure();
    if (
      own(slots.binding.value, 'version') !== componentVersion ||
      own(own(slots.ledger.value, 'policy'), 'ttlMs') !== ttlMs ||
      !Array.isArray(entries) ||
      !Array.isArray(own(history, 'tips')) ||
      own(history, 'tips').length > capacity.maxSnapshots ||
      (entries.length
        ? historyVersion !== (version >= 10 ? 3 : componentVersion)
        : ![1, 2, ...(version >= 10 ? [3] : [])].includes(historyVersion))
    )
      throw storageFailure();
    return version;
  } catch {
    throw storageFailure();
  }
}

// Validation basis only, never a replacement for current request selection.
// Compaction can omit generation tools. The joint selector still uses the
// ORIGINAL current request, including instructions/system and explicit tools.
function recoveryRootBinding(root, request, compaction) {
  const version = validateRecoveryRootPolicy(root);
  if (!compaction) return request;
  if (version >= 2) return { ...request, policy: root.policyBasis };
  if (root.policyFingerprint !== fingerprintContextData(request.policy ?? null))
    throw storageFailure();
  return request;
}

// Explicit metadata boundary; never infer a full root from arbitrary input.
function recoveryRootMetadataBinding(input, request, compaction) {
  const { metadata } = require('./context-recovery-root-state').validateRecoveryRootMetadata({
    metadata: input,
    stagedSources: [],
  });
  const { sourceVersion, ...fields } = metadata;
  return recoveryRootBinding(
    { ...fields, kind: 'recovery-root', version: sourceVersion },
    request,
    compaction
  );
}

module.exports = { validateRecoveryRootPolicy, recoveryRootBinding, recoveryRootMetadataBinding };
