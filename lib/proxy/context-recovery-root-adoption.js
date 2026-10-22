'use strict';

const { RECOVERY_MAX_ROOTS } = require('./context-recovery-limits');
const { RECOVERY_ROOT_VERSION } = require('./context-recovery-capacity');

const { prepareContextBindingAdoption } = require('./context-binding');
const { prepareContextHistoryAdoption } = require('./context-history-map');
const {
  restoreRecoveryRootStates,
  restoreRecoveryRootMetadataStates,
  rootStateFailure,
} = require('./context-recovery-root-state');
const { createRecoveryRootOwner } = require('./context-recovery-root-owner');

// Private session-owner transaction. The caller has authenticated and projected
// the input already; the standard importer still validates every association.
// No await or callback is allowed between the final checks and the commits.
function adoptRootStates(context, input, restore) {
  let restored;
  let committed = false;
  try {
    context.check();
    restored = restore({ now: context.now }, input);
    const ids = [...restored.roots.keys()];
    if (!ids.length) return { ok: true, rootIds: [] };
    const checkRoots = () => {
      const legacySnapshots = [
        ...context.snapshots.values(),
        ...restored.snapshots.values(),
      ].filter((snapshot) => snapshot.root.capacityVersion !== RECOVERY_ROOT_VERSION).length;
      if (
        legacySnapshots > 256 ||
        context.roots.size + ids.length > RECOVERY_MAX_ROOTS ||
        ids.some((id) => context.roots.has(id)) ||
        [...restored.snapshots.keys()].some((id) => context.snapshots.has(id))
      )
        throw rootStateFailure();
    };
    checkRoots();
    const binding = prepareContextBindingAdoption(context.registry, restored.registry);
    const history = prepareContextHistoryAdoption(context.historyMap, restored.historyMap);
    for (const root of restored.roots.values()) {
      root.owner = createRecoveryRootOwner();
      context.register(root);
    }
    const time = context.check();
    if ([...restored.roots.values()].some((root) => time >= root.expiresAt))
      throw rootStateFailure();
    checkRoots();
    binding.check();
    history.check();
    history.commit();
    binding.commit();
    for (const [id, root] of restored.roots) context.roots.set(id, root);
    for (const [id, snapshot] of restored.snapshots) context.snapshots.set(id, snapshot);
    committed = true;
    return { ok: true, rootIds: ids };
  } catch {
    throw rootStateFailure();
  } finally {
    restored?.registry.close();
    restored?.historyMap.close();
    if (!committed)
      for (const root of restored?.roots.values() ?? []) {
        root.owner?.close();
        root.ledger.close();
      }
  }
}

function adoptRecoveryRootStates(context, input) {
  return adoptRootStates(context, input, restoreRecoveryRootStates);
}

function adoptRecoveryRootMetadataStates(context, input) {
  return adoptRootStates(context, input, restoreRecoveryRootMetadataStates);
}

module.exports = { adoptRecoveryRootStates, adoptRecoveryRootMetadataStates };
