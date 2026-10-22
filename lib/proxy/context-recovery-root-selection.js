'use strict';

const { probeContextBindingRegistry } = require('./context-binding');
const {
  restoreRecoveryRootStates,
  restoreRecoveryRootMetadataStates,
  rootStateFailure,
} = require('./context-recovery-root-state');

// Trusted owner admission only. Validate candidates in temporary component
// owners, jointly match their fingerprints against live state, then destroy all
// temporary capabilities. Nothing is adopted or registered for storage here.
function probeRootStates(context, input, request, compaction, restore) {
  let restored;
  try {
    context.check();
    restored = restore({ now: context.now }, input);
    const selected = probeContextBindingRegistry(
      context.registry,
      request,
      [restored.registry],
      compaction
    );
    const time = context.check();
    if (!selected.ok) return selected;
    const id = selected.rootSnapshotId;
    const live = id === null ? null : context.roots.get(id);
    const root = live ?? restored.roots.get(id);
    if (id !== null && (!root?.active || time >= root.expiresAt)) throw rootStateFailure();
    return Object.freeze({
      ok: true,
      reason: selected.reason,
      parentSnapshotId: selected.parentSnapshotId,
      rootId: id,
      location: id === null ? null : live ? 'online' : 'offline',
      policyFingerprint: selected.policyFingerprint,
    });
  } catch {
    throw rootStateFailure();
  } finally {
    restored?.registry.close();
    restored?.historyMap.close();
    for (const root of restored?.roots.values() ?? []) root.ledger.close();
  }
}

function probeRecoveryRootStates(context, input, request, compaction) {
  return probeRootStates(context, input, request, compaction, restoreRecoveryRootStates);
}

function probeRecoveryRootMetadataStates(context, input, request, compaction) {
  return probeRootStates(context, input, request, compaction, restoreRecoveryRootMetadataStates);
}

module.exports = { probeRecoveryRootStates, probeRecoveryRootMetadataStates };
