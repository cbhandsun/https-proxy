'use strict';

const { storageFailure, storageCatalog } = require('./context-recovery-storage-contract');
const { parseRecoveryStorageRecord } = require('./context-recovery-storage-record');
const {
  fingerprintContextData,
  fingerprintRecoveryCheckpoint,
} = require('./context-recovery-fingerprint');
const { parseRootCheckpoint } = require('./context-recovery-root-checkpoint');

// Startup-only, before the new owner can admit live sessions. Staged bytes from
// a previous owner cannot be imported as evidence. Never prune committed roots,
// publication history, capture/read counters, budgets or absolute lifetimes.
async function cleanupRecoveryStaging(records, call, catalog) {
  const expectedCatalog = storageCatalog(catalog ?? records.map(({ entry }) => ({ ...entry })));
  const plans = [];
  // Plan the whole bounded generation before the first write. Corruption in a
  // later record must not disappear behind a successful earlier cleanup.
  for (const { entry, record } of records) {
    const value = parseRecoveryStorageRecord(record, entry);
    if (!value.state.stagedSources.length) continue;
    if (entry.revision === Number.MAX_SAFE_INTEGER) throw storageFailure();
    const payload = {
      root: value.state.root,
      stagedSources: [],
      ...(Object.hasOwn(value.state, 'publications')
        ? { publications: value.state.publications }
        : {}),
    };
    const state = {
      version: value.state.version,
      kind: value.state.kind,
      ...payload,
      digest: fingerprintRecoveryCheckpoint(payload),
    };
    parseRootCheckpoint(state, value.state.root);
    plans.push({ entry, state });
  }
  if (!plans.length) return;
  for (const { entry, state } of plans) {
    const revision = entry.revision + 1;
    const result = await call({
      operation: 'save',
      scope: entry.scope,
      expectedRevision: entry.revision,
      expiresAt: entry.expiresAt,
      state,
    });
    if (
      !result ||
      Array.isArray(result) ||
      Object.keys(result).join(',') !== 'revision' ||
      result.revision !== revision
    )
      throw storageFailure();
    const expected = { ...entry, revision };
    const loaded = parseRecoveryStorageRecord(
      await call({ operation: 'load', scope: entry.scope }),
      expected
    );
    if (loaded.state.digest !== state.digest) throw storageFailure();
    expectedCatalog.find((item) => item.scope === entry.scope).revision = revision;
  }
  if (
    fingerprintContextData(expectedCatalog) !==
    fingerprintContextData(storageCatalog(await call({ operation: 'catalog' })))
  )
    throw storageFailure();
}

module.exports = { cleanupRecoveryStaging };
