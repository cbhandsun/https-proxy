'use strict';

const { storageFailure } = require('./context-recovery-storage-contract');

const APPLICATION_ID = 1213222211;
// Preserve the exact version-one DDL already emitted by released candidates.
// An unknown layout is never interpreted as an implicit migration request.
const HEADER_SQL =
  'CREATE TABLE recovery_header (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, envelope BLOB NOT NULL) STRICT';
const STATE_SQL =
  "CREATE TABLE recovery_state (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('state','revoked')), envelope BLOB NOT NULL) STRICT";
const BLOB_SQL =
  'CREATE TABLE recovery_blob (scope TEXT NOT NULL, blob_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, envelope BLOB NOT NULL, PRIMARY KEY(scope,blob_id)) STRICT';
const EXPECTED = new Map([
  ['recovery_header', ['table', 'recovery_header', HEADER_SQL]],
  ['recovery_state', ['table', 'recovery_state', STATE_SQL]],
  ['sqlite_autoindex_recovery_state_1', ['index', 'recovery_state', null]],
]);

// Reads schema records only, with bounded row/field sizes. Do not query a
// potentially replaced application table or write its clock before admission.
function recoveryStorageSchemaState(database) {
  try {
    const version = database.prepare('PRAGMA user_version').get().user_version;
    const application = database.prepare('PRAGMA application_id').get().application_id;
    if (
      !(
        (version === 0 && application === 0) ||
        ([1, 2].includes(version) && application === APPLICATION_ID)
      )
    )
      throw storageFailure();
    if (database.prepare('SELECT 1 FROM sqlite_temp_schema LIMIT 1').get()) throw storageFailure();
    const rows = database
      .prepare(
        'SELECT type, CASE WHEN length(name)<=128 THEN name END AS name, CASE WHEN length(tbl_name)<=128 THEN tbl_name END AS tbl_name, CASE WHEN length(sql)<=1024 THEN sql END AS sql FROM sqlite_schema LIMIT 6'
      )
      .all();
    if (version === 0) {
      if (rows.length !== 0) throw storageFailure();
      return 'empty';
    }
    const layout = new Map(EXPECTED);
    if (version === 2) {
      layout.set('recovery_blob', ['table', 'recovery_blob', BLOB_SQL]);
      layout.set('sqlite_autoindex_recovery_blob_1', ['index', 'recovery_blob', null]);
    }
    if (rows.length !== layout.size) throw storageFailure();
    const seen = new Set();
    for (const row of rows) {
      const expected = layout.get(row.name);
      if (
        !expected ||
        seen.has(row.name) ||
        row.type !== expected[0] ||
        row.tbl_name !== expected[1] ||
        row.sql !== expected[2]
      )
        throw storageFailure();
      seen.add(row.name);
    }
    return 'ready';
  } catch {
    throw storageFailure();
  }
}

module.exports = { APPLICATION_ID, HEADER_SQL, STATE_SQL, BLOB_SQL, recoveryStorageSchemaState };
