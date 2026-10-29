'use strict';

const { storageData, storageFailure } = require('./context-recovery-storage-contract');
const { parseRecoveryReferenceRecord } = require('./context-recovery-storage-record');

// A selected, currently authorized loader may remember scanned CAS facts. They
// grant no read authority: the first write still revalidates association and
// exact revision inside SQLite before acknowledging its maximum budget debit.
function parseRecoveryColdAdmission(input) {
  const value = storageData(input);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'entry,record')
    throw storageFailure();
  const record = parseRecoveryReferenceRecord(value.record, value.entry);
  const root = record.reference.metadata;
  return {
    root: {
      rootId: root.rootId,
      principal: root.principal,
      createdAt: root.createdAt,
      expiresAt: root.expiresAt,
    },
    scope: value.entry.scope,
    revision: record.revision,
    capacityVersion: root.sourceVersion,
    historyFormat: root.binding.format ?? 2,
    sourceIds: [...root.ledger.sources, ...record.reference.stagedSources].map(
      (source) => source.sourceId
    ),
    publications: record.reference.publications ?? [],
  };
}

module.exports = { parseRecoveryColdAdmission };
