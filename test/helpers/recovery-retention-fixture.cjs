'use strict';

// Manufacture the previously emitted schema using synthetic test state only.
// All four original deadlines are explicit; no production migration uses this.
function legacyRecoveryRoot(input, version = 2) {
  const state = globalThis.structuredClone(input);
  const ttlMs = 1800000;
  state.version = version;
  state.ledger.policy.maxEntries = 64;
  state.ledger.policy.maxBytes = 4 * 1024 * 1024;
  if (version === 1) delete state.policyBasis;
  if (version < 6) for (const snapshot of state.snapshots) delete snapshot.privateHistoryComplete;
  state.expiresAt = state.createdAt + ttlMs;
  state.binding.version = 1;
  delete state.binding.format;
  for (const snapshot of state.binding.snapshots) delete snapshot.window;
  if (version < 4)
    for (const snapshot of state.snapshots) {
      delete snapshot.pendingResults;
      delete snapshot.pendingReady;
    }
  for (const snapshot of state.binding.snapshots) snapshot.expiresAt = snapshot.createdAt + ttlMs;
  state.ledger.policy.ttlMs = ttlMs;
  for (const source of state.ledger.sources) source.expiresAt = source.createdAt + ttlMs;
  state.history.version = 1;
  delete state.history.rootId;
  const deadlines = new Map();
  for (const entry of state.history.entries) {
    entry.expiresAt =
      entry.parentId === null ? entry.createdAt + ttlMs : deadlines.get(entry.parentId);
    deadlines.set(entry.id, entry.expiresAt);
  }
  return state;
}

module.exports = { legacyRecoveryRoot };
