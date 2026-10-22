'use strict';

const {
  storageCatalog,
  storageScanPage,
  storageReferenceScanPage,
  storageFailure,
} = require('./context-recovery-storage-contract');
const {
  parseRecoveryStorageRecord,
  parseRecoveryReferenceRecord,
} = require('./context-recovery-storage-record');
const { fingerprintContextData } = require('./context-recovery-fingerprint');

// No legacy retry after an explicitly supported scan operation has failed.
async function visitStorage(call, scan, visit, referenceOnly) {
  const seen = new Set();
  function accept(entry, input) {
    const record = referenceOnly
      ? parseRecoveryReferenceRecord(input, entry)
      : parseRecoveryStorageRecord(input, entry);
    const id = referenceOnly ? record.reference.metadata.rootId : record.state.root.rootId;
    if (seen.has(id)) throw storageFailure();
    seen.add(id);
    visit(entry, record);
  }
  if (!scan) {
    const catalog = storageCatalog(await call({ operation: 'catalog' }));
    for (const entry of catalog)
      accept(entry, await call({ operation: 'load', scope: entry.scope }));
    if (
      fingerprintContextData(catalog) !==
      fingerprintContextData(storageCatalog(await call({ operation: 'catalog' })))
    )
      throw storageFailure();
    return;
  }
  let after = null,
    generation,
    index = 0;
  for (;;) {
    const command = { operation: referenceOnly ? 'scan-reference' : 'scan', after };
    const page = referenceOnly
      ? storageReferenceScanPage(await call(command), after)
      : storageScanPage(await call(command), after);
    const fingerprint = fingerprintContextData(page.catalog);
    if (generation !== undefined && generation !== fingerprint) throw storageFailure();
    generation = fingerprint;
    if (!page.catalog.length) return;
    const entry = page.catalog[index];
    if (!entry || page.scope !== entry.scope) throw storageFailure();
    accept(entry, page.record);
    if (++index === page.catalog.length) return;
    after = entry.scope;
  }
}
function visitRecoveryStorage(call, scan, visit) {
  return visitStorage(call, scan, visit, false);
}
function visitRecoveryReferenceStorage(call, visit) {
  return visitStorage(call, true, visit, true);
}

module.exports = { visitRecoveryStorage, visitRecoveryReferenceStorage };
