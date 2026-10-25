'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { types } = require('node:util');
const { createStorageCipher } = require('./context-recovery-storage-cipher');
const { createRecoveryBlobStorage } = require('./context-recovery-storage-blobs');
const { assertRecoveryReferenceAdmission } = require('./context-recovery-reference-admission');
const {
  applyReaderSettlement,
  applyReferenceReaderSettlement,
} = require('./context-recovery-reader-settlement');
const { prepareRecoveryReadSettlement } = require('./context-recovery-read-settlement');
const { materializeReferenceWrite } = require('./context-recovery-reference-write');
const { recoveryRootCapacity } = require('./context-recovery-capacity');
const { pruneExpiredRecoveryRows } = require('./context-recovery-storage-maintenance');
const {
  APPLICATION_ID,
  HEADER_SQL,
  STATE_SQL,
  BLOB_SQL,
  recoveryStorageSchemaState,
} = require('./context-recovery-storage-schema');
const {
  STORAGE_TTL_MS,
  storageFailure,
  storageRequest,
  storageContext,
  storageCatalog,
  declareRecoveryScan,
  declareRecoverySourcePages,
  declareRecoveryReaderSettlement,
  declareRecoveryReadSettlement,
  declareRecoveryReferenceWrites,
  declareRecoveryReferenceStates,
  declareRecoveryReferenceAdmission,
  declareRecoveryReferenceScan,
} = require('./context-recovery-storage-contract');
const {
  RECOVERY_DATABASE_BYTES,
  validateRecoveryStorageUsage,
} = require('./context-recovery-storage-quota');

const ZERO_SCOPE = '0'.repeat(64);
const headerContext = (storeId) => ({
  storeId,
  scope: ZERO_SCOPE,
  revision: 1,
  createdAt: 0,
  expiresAt: 1,
  kind: 'header',
  version: 1,
});

// Synchronous transaction engine for an exclusively owned SQLite connection.
// The filesystem owner and worker lifecycle are separate integration boundaries.
// It stores opaque validated checkpoint state; only the session restore layer can
// turn that state into trusted capabilities. No model-facing write/read API here.
function openRecoverySqliteStore(options, inspection) {
  // Reject hostile option access before reading any callback or database field.
  if (
    !options ||
    typeof options !== 'object' ||
    types.isProxy(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw storageFailure();
  for (const name of Reflect.ownKeys(options)) {
    const slot = Object.getOwnPropertyDescriptor(options, name);
    if (typeof name !== 'string' || !slot || !Object.hasOwn(slot, 'value')) throw storageFailure();
    if (inspection && (!slot.enumerable || !['database', 'dataKey'].includes(name)))
      throw storageFailure();
  }
  if (inspection && (!Object.hasOwn(options, 'database') || !Object.hasOwn(options, 'dataKey')))
    throw storageFailure();
  const {
    database,
    dataKey,
    now = Date.now,
    beforeStartup,
    initialStoreId,
    anchoredStartup = false,
  } = options;
  if (typeof anchoredStartup !== 'boolean' || (anchoredStartup && beforeStartup === undefined))
    throw storageFailure();
  if (
    initialStoreId !== undefined &&
    (typeof initialStoreId !== 'string' ||
      initialStoreId.length !== 32 ||
      !/^[a-f0-9]{32}$/.test(initialStoreId))
  )
    throw storageFailure();
  if (
    beforeStartup !== undefined &&
    (typeof beforeStartup !== 'function' ||
      types.isProxy(beforeStartup) ||
      types.isAsyncFunction(beforeStartup))
  )
    throw storageFailure();
  const cipher = createStorageCipher(dataKey);
  let closed = false;
  let storeId;
  const schemaVersion = () => database.prepare('PRAGMA user_version').get().user_version;
  const blobs = createRecoveryBlobStorage(
    database,
    cipher,
    () => storeId,
    () => schemaVersion() >= 2
  );
  // A quota classification can be reused only for identical authenticated bytes
  // and AAD under this transaction. Retain small hashes, never plaintext roots.
  const admissionTag = (row) =>
    createHash('sha256')
      .update(row.envelope)
      .update(JSON.stringify(context(row)))
      .digest('hex');
  const prune = (time, admissions, beforeRemove, selected) => {
    return pruneExpiredRecoveryRows(
      database,
      (row) => {
        const state = cipher.open(context(row), row.envelope);
        let decoded;
        if (row.kind === 'state' && row.expires_at > time && blobs.isReferenceState(state)) {
          decoded = blobs.referenceState(state, row.scope);
          if (decoded.metadata.expiresAt !== row.expires_at) throw storageFailure();
        } else decoded = decodeState(row, state);
        // This row has already passed authenticated decryption in this
        // transaction. Reuse that value for the same strict semantic checks.
        if (admissions && row.kind === 'state' && row.expires_at > time) {
          const admitted = {
            tag: admissionTag(row),
            version:
              state.kind === 'recovery-referenced-checkpoint'
                ? blobs.isReferenceState(state)
                  ? decoded.metadata.sourceVersion
                  : decoded.root.version
                : null,
          };
          admissions.set(row.scope, admitted);
          // Keep only this mutation's selected reference metadata, never raw
          // source bodies or another root. Its tag must match the later read.
          if (selected && row.scope === selected.scope && blobs.isReferenceState(state)) {
            selected.tag = admitted.tag;
            selected.value = state;
          }
        }
        return decoded;
      },
      time,
      blobs.remove,
      beforeRemove
    );
  };
  function transaction(operation, expectedSchema = 'ready', readOnly = false) {
    let active = false;
    try {
      if (closed) throw storageFailure();
      database.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
      active = true;
      if (recoveryStorageSchemaState(database) !== expectedSchema) throw storageFailure();
      // The transaction pins a consistent ownership view for this operation. Validate
      // once before reading or pruning; never reuse the result across locks.
      if (expectedSchema === 'ready') blobs.validateOwnership();
      const result = operation();
      if (expectedSchema === 'empty' && recoveryStorageSchemaState(database) !== 'ready')
        throw storageFailure();
      database.exec('COMMIT');
      active = false;
      return result;
    } catch {
      if (active) {
        try {
          database.exec('ROLLBACK');
        } catch {
          closed = true;
          cipher.close();
        }
      }
      throw storageFailure();
    }
  }
  function readHeader() {
    const row = database
      .prepare('SELECT store_id, envelope FROM recovery_header WHERE singleton=1')
      .get();
    if (!row || (storeId !== undefined && row.store_id !== storeId)) throw storageFailure();
    const context = headerContext(row.store_id);
    const value = cipher.open(context, row.envelope);
    if (
      Object.keys(value).sort().join(',') !== 'lastTime,schema' ||
      value.schema !== schemaVersion() ||
      !Number.isSafeInteger(value.lastTime) ||
      value.lastTime < 0
    )
      throw storageFailure();
    return { row, value };
  }
  function clock() {
    const { value } = readHeader();
    const time = now();
    if (
      !Number.isSafeInteger(time) ||
      time < value.lastTime ||
      time < 0 ||
      time > Number.MAX_SAFE_INTEGER - STORAGE_TTL_MS
    )
      throw storageFailure();
    // The authenticated watermark is already durable at this exact time.
    // Re-encrypting an unchanged value needlessly dirties SQLite pages and
    // forces FULL-synchronous journal work even for an otherwise empty sweep.
    // Authentication, schema admission and row validation still run each time.
    if (time !== value.lastTime) {
      const envelope = cipher.seal(headerContext(storeId), {
        schema: value.schema,
        lastTime: time,
      });
      database.prepare('UPDATE recovery_header SET envelope=? WHERE singleton=1').run(envelope);
    }
    return time;
  }
  function context(row) {
    return storageContext({
      storeId,
      scope: row.scope,
      revision: row.revision,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      kind: row.kind,
      version: 1,
    });
  }
  function decodeState(row, opened) {
    const state = blobs.decode(opened, row.scope);
    if (
      row.kind === 'revoked' &&
      (Object.keys(state).join(',') !== 'revoked' || state.revoked !== true)
    )
      throw storageFailure();
    return state;
  }
  function decode(row) {
    return decodeState(row, cipher.open(context(row), row.envelope));
  }
  function metadataSnapshot(header = readHeader()) {
    const rows = database.prepare('SELECT * FROM recovery_state ORDER BY scope LIMIT 257').all();
    if (rows.length > 256) throw storageFailure();
    let bytes = 0;
    const scopes = rows.map((row) => {
      if (!['state', 'revoked'].includes(row.kind) || !(row.envelope instanceof Uint8Array))
        throw storageFailure();
      bytes += row.envelope.length;
      if (bytes > 64 * 1024 * 1024) throw storageFailure();
      const state = cipher.open(context(row), row.envelope);
      if (row.kind === 'state' && blobs.isReferenceState(state)) {
        if (blobs.authenticateReferenceSnapshot(state, row.scope) !== row.expires_at)
          throw storageFailure();
      } else decodeState(row, state);
      return Object.freeze({
        scope: row.scope,
        revision: row.revision,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        kind: row.kind,
        tag: admissionTag(row),
      });
    });
    return Object.freeze({
      storeId,
      maxTime: header.value.lastTime,
      scopes: Object.freeze(scopes),
    });
  }
  function usageVersion(row) {
    const state = cipher.open(context(row), row.envelope);
    // Only an authenticated, semantically validated partitioned root can
    // select the physical category. Opaque inline states remain legacy.
    return state.kind === 'recovery-referenced-checkpoint'
      ? blobs.isReferenceState(state)
        ? blobs.referenceState(state, row.scope).metadata.sourceVersion
        : blobs.decode(state, row.scope).root.version
      : null;
  }
  function liveUsage(time, admissions) {
    const rows = database
      .prepare(
        "SELECT * FROM recovery_state WHERE kind='state' AND expires_at>? ORDER BY scope LIMIT 5"
      )
      .all(time);
    return validateRecoveryStorageUsage(
      rows.map((row) => {
        const admitted = admissions?.get(row.scope);
        const version =
          admitted && admitted.tag === admissionTag(row) ? admitted.version : usageVersion(row);
        const usage = blobs.usage(row.scope);
        return { version, sources: usage.records, bytes: row.envelope.length + usage.bytes };
      })
    );
  }
  function enableBlobs() {
    if (schemaVersion() >= 2) return;
    const { value } = readHeader();
    // One explicit layout transition, under the same transaction as the first
    // referenced save. Old inline rows remain readable at their original expiry.
    database.exec(BLOB_SQL);
    database.exec('PRAGMA user_version=2');
    database
      .prepare('UPDATE recovery_header SET envelope=? WHERE singleton=1')
      .run(cipher.seal(headerContext(storeId), { schema: 2, lastTime: value.lastTime }));
    if (recoveryStorageSchemaState(database) !== 'ready') throw storageFailure();
  }
  // Runs only inside an already admitted write transaction. The default owner
  // seals its startup atomically; explicit legacy callers retain their private
  // standalone transition. Neither path grants enrollment authority.
  function sealAnchoredFormat() {
    const current = readHeader();
    if (current.value.schema === 3) return;
    enableBlobs();
    const { value } = readHeader();
    database.exec('PRAGMA user_version=3');
    database
      .prepare('UPDATE recovery_header SET envelope=? WHERE singleton=1')
      .run(cipher.seal(headerContext(storeId), { schema: 3, lastTime: value.lastTime }));
    if (recoveryStorageSchemaState(database) !== 'ready') throw storageFailure();
  }
  function get(scope) {
    return database.prepare('SELECT * FROM recovery_state WHERE scope=?').get(scope);
  }
  function catalog(time) {
    const rows = database
      .prepare(
        'SELECT scope, revision, created_at, expires_at, kind FROM recovery_state ORDER BY scope LIMIT 257'
      )
      .all();
    if (rows.length > 256) throw storageFailure();
    return storageCatalog(
      rows
        .filter((row) => row.kind === 'state' && row.expires_at > time)
        .map((row) => ({
          scope: row.scope,
          revision: row.revision,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        }))
    );
  }
  function scan(request, time) {
    // Match the original catalog/load/catalog generation boundary. Intermediate
    // pages authenticate their selected row; the caller must finish the whole
    // generation before importing authority or performing staging cleanup.
    if (request.after === null) prune(time);
    const entries = catalog(time);
    if (request.after !== null && !entries.some((entry) => entry.scope === request.after))
      throw storageFailure();
    const entry = entries.find((item) => request.after === null || item.scope > request.after);
    if (request.after !== null && (!entry || entry.scope === entries.at(-1).scope)) prune(time);
    if (!entry) {
      if (entries.length) throw storageFailure();
      return { catalog: entries, scope: null, record: null };
    }
    const row = get(entry.scope);
    if (!row) throw storageFailure();
    return {
      catalog: entries,
      scope: entry.scope,
      record: {
        revision: row.revision,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        ...(request.operation === 'scan-reference'
          ? { reference: blobs.referenceState(cipher.open(context(row), row.envelope), row.scope) }
          : { state: decode(row) }),
      },
    };
  }
  function revokeBatch(request) {
    const entries =
      request.operation === 'revoke-all'
        ? database
            .prepare('SELECT * FROM recovery_state ORDER BY scope')
            .all()
            .map((row) => ({
              scope: row.scope,
              createdAt: row.created_at,
              expiresAt: row.expires_at,
            }))
        : request.entries;
    const count = database.prepare('SELECT count(*) AS count FROM recovery_state').get().count;
    const pending = [];
    let added = 0;
    if (entries.length > 256 || count > 256) throw storageFailure();
    for (const entry of entries) {
      const prior = get(entry.scope);
      if (prior) {
        decode(prior);
        if (prior.created_at < entry.createdAt || prior.expires_at !== entry.expiresAt)
          throw storageFailure();
        if (prior.kind === 'revoked') continue;
      } else added++;
      const row = {
        scope: entry.scope,
        revision: (prior?.revision ?? 0) + 1,
        created_at: prior?.created_at ?? entry.createdAt,
        expires_at: prior?.expires_at ?? entry.expiresAt,
        kind: 'revoked',
      };
      const envelope = cipher.seal(context(row), { revoked: true });
      pending.push({ row, envelope });
    }
    if (count + added > 256) throw storageFailure();
    for (const { row, envelope } of pending) {
      database
        .prepare(
          'INSERT INTO recovery_state VALUES(?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at, expires_at=excluded.expires_at, kind=excluded.kind, envelope=excluded.envelope'
        )
        .run(row.scope, row.revision, row.created_at, row.expires_at, row.kind, envelope);
      blobs.remove(row.scope);
    }
    return { revoked: entries.length };
  }
  try {
    if (typeof now !== 'function') throw storageFailure();
    database.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY');
    if (inspection) {
      try {
        return transaction(
          () => {
            // Existing-schema inspection authenticates every retained row and blob,
            // including expired and revoked records, without advancing the clock.
            const header = readHeader();
            storeId = header.row.store_id;
            const result = metadataSnapshot(header);
            const pageSize = database.prepare('PRAGMA page_size').get().page_size;
            const pages = database.prepare('PRAGMA page_count').get().page_count;
            if (
              !Number.isSafeInteger(pageSize) ||
              pageSize <= 0 ||
              !Number.isSafeInteger(pages) ||
              pages < 0 ||
              pages > Math.floor(RECOVERY_DATABASE_BYTES / pageSize)
            )
              throw storageFailure();
            // Use only the authenticated stored watermark for capacity admission.
            // No wall-clock callback, maintenance or persistent pragma runs here.
            liveUsage(header.value.lastTime);
            return result;
          },
          'ready',
          true
        );
      } finally {
        closed = true;
        cipher.close();
      }
    }
    const initialSchema = recoveryStorageSchemaState(database);
    // A readonly snapshot can overlap the final COMMIT in DELETE journal mode.
    // Wait for a short reader inside SQLite's existing transaction, never replay
    // its body. The worker's 30s deadline and exclusive owner mutex are unchanged;
    // persistent contention still rolls back and cannot produce a durable ACK.
    database.exec('PRAGMA busy_timeout=1000');
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON');
    transaction(() => {
      if (initialSchema === 'empty') {
        database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`);
        database.exec(HEADER_SQL);
        database.exec(STATE_SQL);
        storeId = initialStoreId ?? randomBytes(16).toString('hex');
        database
          .prepare('INSERT INTO recovery_header VALUES(1,?,?)')
          .run(storeId, cipher.seal(headerContext(storeId), { schema: 1, lastTime: 0 }));
        // Admit the newly created schema before the common startup reads,
        // while retaining the same writer lock and atomic durable commit.
        if (recoveryStorageSchemaState(database) !== 'ready') throw storageFailure();
        blobs.validateOwnership();
      }
      // Recheck schema under the writer lock before reading application tables.
      // Another connection may have changed it since initial admission.
      const header = readHeader();
      storeId = header.row.store_id;
      if (initialStoreId !== undefined && initialStoreId !== storeId) throw storageFailure();
      // A synchronous undefined return is the only admission ACK. Never inspect
      // callback return properties or accept an asynchronously pending decision.
      if (
        beforeStartup !== undefined &&
        beforeStartup(metadataSnapshot(header), initialSchema === 'empty') !== undefined
      )
        throw storageFailure();
      // Preserve both fresh-store clock checks, including rollback detection,
      // while keeping independent anchor admission ahead of either mutation.
      if (initialSchema === 'empty') clock();
      // Bound database growth before maintenance can delete anything.
      const pageSize = database.prepare('PRAGMA page_size').get().page_size;
      const maximumPages = Math.floor(RECOVERY_DATABASE_BYTES / pageSize);
      if (database.prepare('PRAGMA page_count').get().page_count > maximumPages)
        throw storageFailure();
      database.exec('PRAGMA max_page_count=' + maximumPages);
      if (database.prepare('PRAGMA max_page_count').get().max_page_count !== maximumPages)
        throw storageFailure();
      const time = clock();
      // Authenticate and semantically validate each row once under the same
      // startup writer lock. Keep only authenticated tags/category proofs;
      // quota admission still completes before maintenance deletes anything.
      const admissions = new Map();
      prune(time, admissions, () => {
        liveUsage(time, admissions);
      });
      if (anchoredStartup) sealAnchoredFormat();
    }, initialSchema);
  } catch {
    closed = true;
    cipher.close();
    throw storageFailure();
  }

  const store = {
    // Private owner capability, never a storageRequest operation. Seal the
    // authenticated layout before an anchored owner can return ready. Released
    // schema-one/two readers must refuse this unknown epoch before writing.
    prepareAnchoredFormat() {
      return transaction(sealAnchoredFormat);
    },
    // Private authenticated metadata; no clock advancement or maintenance.
    snapshot() {
      return transaction(() => metadataSnapshot(), 'ready', true);
    },
    execute: declareRecoveryReferenceScan(
      declareRecoveryReferenceStates(
        declareRecoveryReferenceWrites(
          declareRecoveryReaderSettlement(
            declareRecoverySourcePages(
              declareRecoveryScan(function (input) {
                const request = storageRequest(input);
                return transaction(() => {
                  const time = clock();
                  // Exists only inside this locked write callback. Nothing is
                  // retained after COMMIT, rollback, failure or a later request.
                  const admissions = ['save', 'save-reference', 'save-reference-state'].includes(
                    request.operation
                  )
                    ? new Map()
                    : undefined;
                  const selected = admissions ? { scope: request.scope } : undefined;
                  if (
                    ['catalog', 'save', 'save-reference', 'save-reference-state', 'sweep'].includes(
                      request.operation
                    )
                  ) {
                    const result = prune(time, admissions, undefined, selected);
                    if (request.operation === 'sweep') return result;
                  }
                  if (request.operation === 'catalog') return catalog(time);
                  if (['scan', 'scan-reference'].includes(request.operation))
                    return scan(request, time);
                  if (['revoke-all', 'revoke-scopes'].includes(request.operation))
                    return revokeBatch(request);
                  const prior = request.scope === undefined ? null : get(request.scope);
                  // This row and its AAD are fixed under this synchronous locked
                  // mutation. Share its authenticated value between admission,
                  // settlement and encoding; never retain it across callbacks.
                  let priorValue =
                    selected?.tag && prior && selected.tag === admissionTag(prior)
                      ? selected.value
                      : undefined;
                  const openPrior = () =>
                    (priorValue ??= cipher.open(context(prior), prior.envelope));
                  if (request.admission) {
                    if (
                      !prior ||
                      prior.kind !== 'state' ||
                      prior.expires_at <= time ||
                      prior.revision !== request.expectedRevision
                    )
                      throw storageFailure();
                    assertRecoveryReferenceAdmission(
                      blobs.referenceState(openPrior(), prior.scope),
                      request.admission
                    );
                  }
                  if (request.operation === 'load-reference') {
                    if (!prior) return null;
                    if (prior.kind !== 'state' || prior.expires_at <= time) {
                      decodeState(prior, openPrior());
                      return null;
                    }
                    const reference = blobs.referenceState(openPrior(), prior.scope);
                    if (reference.metadata.expiresAt !== prior.expires_at) throw storageFailure();
                    return {
                      revision: prior.revision,
                      createdAt: prior.created_at,
                      expiresAt: prior.expires_at,
                      reference,
                    };
                  }
                  if (request.operation === 'inspect') {
                    return liveUsage(time);
                  }
                  if (request.operation === 'load') {
                    if (!prior) return null;
                    const state = decodeState(prior, openPrior());
                    if (prior.kind !== 'state' || prior.expires_at <= time) return null;
                    return {
                      revision: prior.revision,
                      createdAt: prior.created_at,
                      expiresAt: prior.expires_at,
                      state,
                    };
                  }
                  if (request.operation === 'read-source') {
                    if (
                      !prior ||
                      prior.kind !== 'state' ||
                      prior.revision !== request.expectedRevision ||
                      prior.expires_at <= time ||
                      request.source.expiresAt <= time
                    )
                      throw storageFailure();
                    return blobs.readPage(openPrior(), request.scope, request);
                  }
                  let settlement,
                    previousState,
                    combinedPage,
                    combinedSettlement,
                    referenceSettlement = false;
                  if (request.operation === 'read-source-and-settle') {
                    if (
                      !prior ||
                      prior.kind !== 'state' ||
                      prior.revision !== request.expectedRevision ||
                      prior.expires_at <= time ||
                      request.source.expiresAt <= time
                    )
                      throw storageFailure();
                    const priorState = openPrior();
                    if (!blobs.isReferenceState(priorState)) throw storageFailure();
                    const read = blobs.readReferencePage(
                      priorState,
                      request.scope,
                      request,
                      (reference) => prepareRecoveryReadSettlement(reference, request, time)
                    );
                    combinedPage = read.page;
                    combinedSettlement = read.settlement;
                    settlement = applyReferenceReaderSettlement(read.reference, combinedSettlement);
                    referenceSettlement = true;
                  } else if (request.operation === 'settle-reader') {
                    if (!prior || request.settlement.observedAt > time) throw storageFailure();
                    const priorState = openPrior();
                    referenceSettlement = blobs.isReferenceState(priorState);
                    settlement = referenceSettlement
                      ? applyReferenceReaderSettlement(
                          blobs.referenceState(priorState, prior.scope),
                          request.settlement
                        )
                      : applyReaderSettlement(decodeState(prior, openPrior()), request.settlement);
                  } else if (request.operation === 'save-reference') {
                    settlement = materializeReferenceWrite(
                      request.reference,
                      request.payloads,
                      prior ? decodeState(prior, openPrior()) : null
                    );
                  } else if (prior && request.operation !== 'save-reference-state')
                    previousState = decodeState(prior, openPrior());
                  if (
                    (prior?.revision ?? 0) !== request.expectedRevision ||
                    prior?.kind === 'revoked' ||
                    (prior && prior.expires_at <= time)
                  )
                    throw storageFailure();
                  if (request.operation === 'revoke' && !prior) throw storageFailure();
                  const expiresAt = ['revoke', 'settle-reader', 'read-source-and-settle'].includes(
                    request.operation
                  )
                    ? prior.expires_at
                    : request.expiresAt;
                  if (
                    expiresAt <= time ||
                    expiresAt > time + STORAGE_TTL_MS ||
                    (prior && expiresAt > prior.expires_at)
                  )
                    throw storageFailure();
                  const row = {
                    scope: request.scope,
                    revision: request.expectedRevision + 1,
                    created_at: prior?.created_at ?? time,
                    expires_at: expiresAt,
                    kind: request.operation === 'revoke' ? 'revoked' : 'state',
                  };
                  let state =
                    row.kind === 'revoked' ? { revoked: true } : (settlement ?? request.state);
                  if (
                    request.operation === 'save' &&
                    prior &&
                    state.kind === 'recovery-write-ahead'
                  ) {
                    const previousRoot =
                      previousState?.kind === 'recovery-root'
                        ? previousState
                        : previousState?.kind === 'recovery-write-ahead'
                          ? previousState.root
                          : null;
                    // Full snapshots can replace staged state. Pin the resource
                    // category without imposing incremental reference semantics.
                    if (
                      previousRoot &&
                      (recoveryRootCapacity(previousRoot.version) !==
                        recoveryRootCapacity(state.root.version) ||
                        previousRoot.budget.version !== state.root.budget.version ||
                        (previousRoot.binding.format ?? 2) !== (state.root.binding.format ?? 2))
                    )
                      throw storageFailure();
                  }
                  if (request.operation === 'save-reference-state' || referenceSettlement) {
                    const reference = referenceSettlement ? settlement : request.reference;
                    if (reference.metadata.observedAt > time) throw storageFailure();
                    enableBlobs();
                    state = blobs.saveReference(
                      reference,
                      referenceSettlement ? [] : request.payloads,
                      prior ? openPrior() : null,
                      row.scope
                    );
                  } else if (row.kind === 'state' && blobs.isCheckpoint(state)) {
                    enableBlobs();
                    state = blobs.encode(state, row.scope);
                  } else blobs.remove(row.scope);
                  const envelope = cipher.seal(context(row), state);
                  if (
                    !prior &&
                    database.prepare('SELECT count(*) AS count FROM recovery_state').get().count >=
                      256
                  )
                    throw storageFailure();
                  database
                    .prepare(
                      'INSERT INTO recovery_state VALUES(?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at, expires_at=excluded.expires_at, kind=excluded.kind, envelope=excluded.envelope'
                    )
                    .run(
                      row.scope,
                      row.revision,
                      row.created_at,
                      row.expires_at,
                      row.kind,
                      envelope
                    );
                  if (row.kind === 'state') liveUsage(time, admissions);
                  return combinedSettlement
                    ? { page: combinedPage, revision: row.revision, settlement: combinedSettlement }
                    : { revision: row.revision };
                });
              })
            )
          )
        )
      )
    ),
    close() {
      closed = true;
      cipher.close();
    },
  };
  declareRecoveryReferenceAdmission(store.execute);
  declareRecoveryReadSettlement(store.execute);
  return store;
}

function createRecoverySqliteStore(options = {}) {
  return openRecoverySqliteStore(options, false);
}

// Private offline-owner seam. Caller retains the lifetime OS writer lock and
// owns the existing database connection. Never grants execution capabilities.
function inspectRecoverySqliteSnapshot(options) {
  return openRecoverySqliteStore(options, true);
}

module.exports = { createRecoverySqliteStore, inspectRecoverySqliteSnapshot };
