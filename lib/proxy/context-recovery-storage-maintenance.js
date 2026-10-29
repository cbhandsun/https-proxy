'use strict';

const { storageFailure } = require('./context-recovery-storage-contract');

// The caller owns BEGIN/COMMIT and the monotonic authenticated clock. Verify
// every row before deletion: corrupt or unrecognized records never disappear
// merely because their unauthenticated expiry metadata says they are old.
function pruneExpiredRecoveryRows(
  database,
  decode,
  time,
  removePayloads = () => 0,
  beforeRemove = () => {}
) {
  if (typeof beforeRemove !== 'function') throw storageFailure();
  const rows = database.prepare('SELECT * FROM recovery_state ORDER BY scope LIMIT 257').all();
  if (rows.length > 256 || !Number.isSafeInteger(time) || time < 0) throw storageFailure();
  let removedRecords = 0;
  let removedBytes = 0;
  let totalBytes = 0;
  for (const row of rows) {
    if (!['state', 'revoked'].includes(row.kind) || !(row.envelope instanceof Uint8Array))
      throw storageFailure();
    totalBytes += row.envelope.length;
    if (totalBytes > 64 * 1024 * 1024) throw storageFailure();
    decode(row);
    if (row.expires_at <= time) {
      removedRecords++;
      removedBytes += row.envelope.length;
    }
  }
  // Startup quota admission reuses this transaction's authenticated row tags.
  // It must still finish before any payload or row is deleted, even when the
  // first pass found expired records. An admission failure propagates to the
  // owner's rollback; it never becomes a successful cleanup.
  beforeRemove();
  if (removedRecords) {
    for (const row of rows) if (row.expires_at <= time) removedBytes += removePayloads(row.scope);
    const result = database.prepare('DELETE FROM recovery_state WHERE expires_at<=?').run(time);
    if (result.changes !== removedRecords) throw storageFailure();
  }
  return { removedRecords, removedBytes };
}

module.exports = { pruneExpiredRecoveryRows };
