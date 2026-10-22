'use strict';

const { storageData, storageFailure } = require('./context-recovery-storage-contract');
const { parseRootCheckpoint } = require('./context-recovery-root-checkpoint');
const {
  restoreRecoveryRootStates,
  restoreRecoveryRootMetadataStates,
  validateRecoveryRootMetadata,
} = require('./context-recovery-root-state');
const { parseReferenceState } = require('./context-recovery-reference-state');

function validateRoot(root, binding, time, restore = restoreRecoveryRootStates) {
  const restored = restore({ now: () => time }, [{ binding, state: root }]);
  restored.registry.close();
  restored.historyMap.close();
  for (const item of restored.roots.values()) item.ledger.close();
}

// Trusted owner-side projection, never an authorization endpoint. The caller
// supplies the current binding and checked time. Validate the entire stored root
// before pruning: corruption cannot be hidden in a branch that will be removed.
function projectPublishedRoot(input, binding, time, referenceOnly) {
  try {
    const checkpoint = referenceOnly ? parseReferenceState(input) : storageData(input);
    if (!referenceOnly) parseRootCheckpoint(checkpoint, checkpoint.root);
    const root = referenceOnly ? checkpoint.metadata : checkpoint.root;
    const restore = referenceOnly ? restoreRecoveryRootMetadataStates : restoreRecoveryRootStates;
    validateRoot(root, binding, time, restore);
    if (time >= root.expiresAt) return null;
    const states = new Map(
      (checkpoint.publications ?? []).map((entry) => [entry.snapshotId, entry.state])
    );
    const retained = new Set();
    for (const snapshot of root.binding.snapshots) {
      if (
        states.get(snapshot.id) === 'transport-finished' &&
        (snapshot.parentId === null || retained.has(snapshot.parentId))
      )
        retained.add(snapshot.id);
    }
    if (!retained.has(root.rootId)) return null;
    root.binding.snapshots = root.binding.snapshots.filter((entry) => retained.has(entry.id));
    root.snapshots = root.snapshots.filter((entry) => retained.has(entry.id));
    const sources = new Set(root.snapshots.flatMap((entry) => entry.visible));
    const excluded = root.ledger.sources.filter((entry) => !sources.has(entry.sourceId));
    root.ledger.sources = root.ledger.sources.filter((entry) => sources.has(entry.sourceId));
    root.history.tips = root.snapshots.map((entry) => entry.mappingId).filter((id) => id !== null);
    const history = new Map(root.history.entries.map((entry) => [entry.id, entry]));
    const reachable = new Set();
    for (const tip of root.history.tips)
      for (let entry = history.get(tip); entry; entry = history.get(entry.parentId))
        reachable.add(entry.id);
    root.history.entries = root.history.entries.filter((entry) => reachable.has(entry.id));
    // No staged source gains snapshot visibility. Cold admission retains its
    // descriptor solely for durable identity, quota and transition accounting.
    // Never refund counters, extend expiry or invent a remote acknowledgement.
    validateRoot(root, binding, time, restore);
    return referenceOnly
      ? validateRecoveryRootMetadata({
          metadata: root,
          stagedSources: [...checkpoint.stagedSources, ...excluded].sort(
            (a, b) => a.createdAt - b.createdAt
          ),
        })
      : root;
  } catch {
    throw storageFailure();
  }
}

function projectPublishedRecoveryRoot(input, binding, time) {
  return projectPublishedRoot(input, binding, time, false);
}

function projectPublishedRecoveryReference(input, binding, time) {
  return projectPublishedRoot(input, binding, time, true);
}

module.exports = { projectPublishedRecoveryRoot, projectPublishedRecoveryReference };
