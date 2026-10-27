'use strict';

// Acceptance-only observer. Never imports an owner, writer, original blob or
// live authorization capability. Dependencies below are trusted test seams.
const { createReadonlyFiles, optionsData, failure } = require('./readonly-files.js');
const { types } = require('node:util');
const {
  recoveryStorageSchemaState,
} = require('../../../lib/proxy/context-recovery-storage-schema');
const { createStorageCipher } = require('../../../lib/proxy/context-recovery-storage-cipher');
const { parseReferenceState } = require('../../../lib/proxy/context-recovery-reference-state');
const { parseStoredEvidenceSource } = require('../../../lib/proxy/context-evidence-stored-page');
const { storageContext } = require('../../../lib/proxy/context-recovery-storage-contract');
const { protectWithCurrentUser } = require('../../../lib/proxy/context-recovery-key-dpapi');

const META = Object.freeze({ evidenceLevel: 'committed-metadata-only', hostDurableAck: false });
const ROW_SQL =
  'SELECT scope,revision,created_at,expires_at,kind,CASE WHEN length(envelope)<=16781340 THEN envelope END AS envelope FROM recovery_state LIMIT 2';
const BOUND_ROW_SQL =
  'SELECT scope,revision,created_at,expires_at,kind,CASE WHEN length(envelope)<=16781340 THEN envelope END AS envelope FROM recovery_state WHERE scope=? LIMIT 2';
const HEADER_SQL =
  'SELECT store_id,CASE WHEN length(envelope)<=4096 THEN envelope END AS envelope FROM recovery_header WHERE singleton=1';

function sqliteBusy(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return false;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  const number = Object.getOwnPropertyDescriptor(error, 'errcode');
  return code?.value === 'ERR_SQLITE_ERROR' && number?.value === 5;
}

function createDurableSnapshotReader(input, trusted = {}) {
  let files, onPhase;
  try {
    if (!trusted || typeof trusted !== 'object' || types.isProxy(trusted)) throw failure();
    const slot = Object.getOwnPropertyDescriptor(trusted, 'onPhase');
    const observer = slot ? slot.value : () => {};
    if (
      typeof observer !== 'function' ||
      types.isProxy(observer) ||
      types.isAsyncFunction(observer) ||
      types.isGeneratorFunction(observer)
    )
      throw failure();
    onPhase = (phase) => {
      try {
        observer(phase);
      } catch {
        throw failure();
      }
    };
    onPhase(174);
    optionsData(input);
    files = (trusted.createFiles ?? createReadonlyFiles)(input);
  } catch {
    throw failure();
  }
  let closed = false,
    binding,
    storePin,
    lastRevision = 0;
  const open =
    trusted.openReadonly ??
    ((file) => {
      const { DatabaseSync } = require('node:sqlite');
      return new DatabaseSync(file, { readOnly: true, allowExtension: false });
    });
  function read() {
    let database,
      cipher,
      begun = false,
      result,
      failed = false;
    try {
      if (closed) throw failure();
      onPhase(175);
      files.verify();
      onPhase(176);
      const wrapped = files.readKey();
      onPhase(177);
      const key = (trusted.unprotect ?? protectWithCurrentUser)({
        operation: 'unprotect',
        value: wrapped,
      });
      cipher = createStorageCipher(key);
      files.verify();
      onPhase(178);
      database = open(files.databaseFile);
      database.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN');
      begun = true;
      onPhase(179);
      let format;
      try {
        format = database.prepare('PRAGMA user_version').get().user_version;
        if (recoveryStorageSchemaState(database) !== 'ready' || (format !== 2 && format !== 3))
          throw failure();
      } catch (error) {
        // Retain the original zero-wait rejection. Only a fixed numeric marker
        // distinguishes actual SQL contention from other schema/read failures;
        // no caught error, message, path or database data leaves this boundary.
        if (sqliteBusy(error)) onPhase(255);
        throw error;
      }
      onPhase(180);
      const header = database.prepare(HEADER_SQL).get();
      if (
        !header ||
        typeof header.store_id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(header.store_id) ||
        (storePin !== undefined && storePin !== header.store_id)
      )
        throw failure();
      // Copy the bounded encrypted rows under one consistent read transaction.
      // Release SQLite before decryption/validation so an acceptance observer
      // does not keep the owner's final publication COMMIT waiting on CPU work.
      const rows = binding
        ? database.prepare(BOUND_ROW_SQL).all(binding.scope)
        : database.prepare(ROW_SQL).all();
      if (rows.length > 1) throw failure();
      if (binding && rows.length === 0 && database.prepare(ROW_SQL).all().length !== 0)
        throw failure();
      database.exec('ROLLBACK');
      begun = false;
      const completedRead = database;
      database = undefined;
      completedRead.close();
      onPhase(181);
      const clock = cipher.open(
        {
          storeId: header.store_id,
          scope: '0'.repeat(64),
          revision: 1,
          createdAt: 0,
          expiresAt: 1,
          kind: 'header',
          version: 1,
        },
        header.envelope
      );
      if (
        Object.keys(clock).sort().join(',') !== 'lastTime,schema' ||
        clock.schema !== format ||
        !Number.isSafeInteger(clock.lastTime) ||
        clock.lastTime < 0
      )
        throw failure();
      onPhase(182);
      if (rows.length === 0) {
        result = {
          ...META,
          present: false,
          reason: binding ? 'absent' : 'empty',
          ...(binding ? { rootId: binding.rootId } : {}),
        };
      } else {
        const row = rows[0];
        const context = storageContext({
          storeId: header.store_id,
          scope: row.scope,
          revision: row.revision,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          kind: row.kind,
          version: 1,
        });
        const state = cipher.open(context, row.envelope);
        if (binding && (binding.scope !== row.scope || context.revision < lastRevision))
          throw failure();
        if (row.kind === 'revoked') {
          // Authenticate the tombstone; do not invent budget zeroes or bind an
          // unauthenticated root identity from caller arguments.
          if (
            !binding ||
            Object.keys(state).sort().join(',') !== 'revoked' ||
            state.revoked !== true
          )
            throw failure();
          result = {
            ...META,
            present: false,
            reason: 'revoked',
            rootId: binding.rootId,
            revision: context.revision,
          };
        } else {
          if (
            Object.keys(state).sort().join(',') !== 'kind,reference,version' ||
            state.kind !== 'recovery-referenced-checkpoint' ||
            state.version !== 3
          )
            throw failure();
          onPhase(183);
          const reference = parseReferenceState(state.reference);
          const metadata = reference.metadata;
          if (
            // The root exists before its first durable save. The row pins
            // that first save time; absolute root expiry must still match.
            metadata.createdAt > context.createdAt ||
            metadata.expiresAt !== context.expiresAt ||
            (binding && binding.rootId !== metadata.rootId)
          )
            throw failure();
          result = {
            ...META,
            present: true,
            rootId: metadata.rootId,
            expiresAt: metadata.expiresAt,
            calls: metadata.budget.calls,
            returnedBytes: metadata.budget.returnedBytes,
            revision: context.revision,
            capturedEvidence: metadata.snapshots.flatMap((snapshot) =>
              snapshot.captured.map((capture) => {
                const source = metadata.ledger.sources.find(
                  (item) => item.sourceId === capture.sourceId
                );
                if (!source) throw failure();
                const { sourceId, callId, toolName, argumentsDigest, digest, bytes, expiresAt } =
                  source;
                return {
                  capturedCallId: capture.callId,
                  source: parseStoredEvidenceSource({
                    sourceId,
                    callId,
                    toolName,
                    argumentsDigest,
                    digest,
                    bytes,
                    expiresAt,
                    trust: 'tool_data_not_instructions',
                  }),
                };
              })
            ),
          };
          // Binding is staged and published only after rollback/close/pins pass.
          result.binding = { rootId: metadata.rootId, scope: context.scope };
        }
      }
      result.storeId = header.store_id;
    } catch {
      failed = true;
    } finally {
      if (!failed) {
        try {
          onPhase(184);
        } catch {
          failed = true;
        }
      }
      if (begun) {
        try {
          database.exec('ROLLBACK');
        } catch {
          failed = true;
        }
      }
      if (database) {
        try {
          database.close();
        } catch {
          failed = true;
        }
      }
      if (cipher) {
        try {
          cipher.close();
        } catch {
          failed = true;
        }
      }
      try {
        files.verify();
      } catch {
        failed = true;
      }
    }
    if (failed) throw failure();
    storePin = result.storeId;
    delete result.storeId;
    if (result.binding) {
      binding = result.binding;
      delete result.binding;
    }
    if (result.revision !== undefined) lastRevision = result.revision;
    return Object.freeze(result);
  }
  return Object.freeze({
    read,
    close() {
      closed = true;
      binding = undefined;
      storePin = undefined;
    },
  });
}
module.exports = { createDurableSnapshotReader };
