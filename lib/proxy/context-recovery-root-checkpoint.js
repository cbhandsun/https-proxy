'use strict';

const { storageData, storageFailure } = require('./context-recovery-storage-contract');
const { fingerprintNormalizedValue } = require('./context-recovery-fingerprint-value');
const { parseEvidenceBudgetState } = require('./context-evidence-budget-state');
const { parseEvidenceLedgerState } = require('./context-evidence-ledger-state');
const { parseCompletedEvidenceSource } = require('./context-evidence-source');
const { parseContextBindingState } = require('./context-recovery-binding-state');
const { validateRecoveryRootPolicy } = require('./context-recovery-root-policy');
const { recoveryRootCapacity } = require('./context-recovery-capacity');
const { normalizeRecoveryCheckpointData } = require('./context-recovery-state-data');

const keys = (value) => value && !Array.isArray(value) && Object.keys(value).sort().join(',');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function checkpointData(input) {
  try {
    return normalizeRecoveryCheckpointData(input);
  } catch {
    throw storageFailure();
  }
}

// This is a write-ahead envelope, deliberately not a recovery-root. Staged raw
// bytes have no branch/restore capability. Authorization import remains a
// separate trusted operation with publication and revocation checks.
function createRootCheckpoint(root, stagedSources, publications = []) {
  const payload = checkpointData({ root, stagedSources, publications });
  return checkpointData({
    version: 1,
    kind: 'recovery-write-ahead',
    // This owned payload just crossed checkpointData's complete admission.
    // External fingerprint and parser inputs still normalize independently.
    digest: fingerprintNormalizedValue(payload),
    ...payload,
  });
}

function parseRecoveryPublications(publications, snapshotIds, maximum = 256) {
  if (![256, 512].includes(maximum)) throw storageFailure();
  const value = storageData({ publications, snapshotIds }, 128 * 1024);
  if (
    !Array.isArray(value.publications) ||
    value.publications.length > maximum ||
    !Array.isArray(value.snapshotIds) ||
    value.snapshotIds.length > maximum ||
    value.snapshotIds.some((id) => typeof id !== 'string' || !/^hbs_[a-f0-9]{32}$/.test(id))
  )
    throw storageFailure();
  const ids = new Set(),
    snapshots = new Set(value.snapshotIds);
  for (const item of value.publications) {
    if (
      keys(item) !== 'snapshotId,state' ||
      typeof item.snapshotId !== 'string' ||
      !/^hbs_[a-f0-9]{32}$/.test(item.snapshotId) ||
      ids.has(item.snapshotId) ||
      ![
        'unobserved',
        'prepared',
        'sending',
        'transport-finished',
        'uncertain',
        'withdrawn',
      ].includes(item.state) ||
      (!snapshots.has(item.snapshotId) && !['uncertain', 'withdrawn'].includes(item.state))
    )
      throw storageFailure();
    ids.add(item.snapshotId);
  }
  return value.publications;
}

// The caller supplies a freshly exported live root. Stored content is never
// used to serve a read here; checks protect association/accounting, not import.
function parseRootCheckpoint(input, expected) {
  const value = checkpointData(input);
  if (
    ![
      'digest,kind,root,stagedSources,version',
      'digest,kind,publications,root,stagedSources,version',
    ].includes(keys(value)) ||
    value.version !== 1 ||
    value.kind !== 'recovery-write-ahead' ||
    value.digest !==
      // checkpointData owns and bounds every projected field. Recompute the
      // digest from those fields without re-admitting the same local copy.
      fingerprintNormalizedValue({
        root: value.root,
        stagedSources: value.stagedSources,
        ...(Object.hasOwn(value, 'publications') ? { publications: value.publications } : {}),
      })
  )
    throw storageFailure();
  return validateCheckpointRoot(value, expected);
}

// The creator already applies the payload and final-envelope admission and
// computes the digest from its own normalized copy. Validate that same owned
// value without cloning and hashing the generated envelope a second time.
function createValidatedRootCheckpoint(root, stagedSources, publications = []) {
  const value = createRootCheckpoint(root, stagedSources, publications);
  return validateCheckpointRoot(value, value.root);
}

function validateCheckpointRoot(value, expected) {
  const root = value.root;
  validateRecoveryRootPolicy(root);
  const capacity = recoveryRootCapacity(root.version);
  if (
    root.kind !== 'recovery-root' ||
    [
      'rootId',
      'principal',
      'protocol',
      'target',
      'policyFingerprint',
      'createdAt',
      'expiresAt',
    ].some((key) => root[key] !== expected[key]) ||
    !integer(root.observedAt) ||
    root.observedAt < root.createdAt ||
    root.observedAt >= root.expiresAt ||
    root.observedAt > expected.observedAt ||
    !integer(root.callCount) ||
    capacity !== recoveryRootCapacity(expected.version) ||
    root.callCount > capacity.maxCalls ||
    !Array.isArray(root.snapshots) ||
    root.snapshots.length < 1 ||
    root.snapshots.length > capacity.maxSnapshots ||
    !Array.isArray(value.stagedSources) ||
    value.stagedSources.length > capacity.maxSources ||
    !Array.isArray(root.ledger?.sources)
  )
    throw storageFailure();
  const binding = parseContextBindingState(root.binding, expected.binding, capacity.maxSnapshots);
  if (
    binding.rootId !== root.rootId ||
    binding.snapshots.length !== root.snapshots.length ||
    binding.snapshots.some((snapshot, index) => snapshot.id !== root.snapshots[index]?.id)
  )
    throw storageFailure();
  const budget = parseEvidenceBudgetState(root.budget);
  if (budget.version !== expected.budget?.version) throw storageFailure();
  parseRecoveryPublications(
    value.publications ?? [],
    root.snapshots.map((snapshot) => snapshot.id),
    capacity.maxSnapshots
  );
  const ledger = parseEvidenceLedgerState(
    {
      ...root.ledger,
      sources: [...root.ledger.sources, ...value.stagedSources].sort(
        (a, b) => a.createdAt - b.createdAt
      ),
    },
    expected.ledger.ownerBinding,
    expected.ledger.policy
  );
  if (budget.successfulReads > ledger.readCount || ledger.readCount > budget.calls)
    throw storageFailure();
  for (const source of ledger.sources) {
    if (
      !parseCompletedEvidenceSource({
        callId: source.callId,
        toolName: source.toolName,
        arguments: {},
        output: source.output,
        completed: true,
      }).ok
    )
      throw storageFailure();
  }
  return value;
}

module.exports = {
  createRootCheckpoint,
  createValidatedRootCheckpoint,
  parseRootCheckpoint,
  parseRecoveryPublications,
};
