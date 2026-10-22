'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { parseContextEvidenceRequest } = require('./context-evidence-request');
const { parseStoredEvidenceSource } = require('./context-evidence-stored-page');
const { parseReaderSettlement } = require('./context-recovery-reader-settlement');
const {
  parseReferenceCheckpoint,
  parseReferencePayloads,
} = require('./context-recovery-reference-write');
const { parseReferenceState } = require('./context-recovery-reference-state');
const {
  normalizeStorageEnvelope,
  version9StorageEnvelope,
} = require('./context-recovery-storage-data');
const { RECOVERY_STATE_BYTES } = require('./context-recovery-state-data');

const MAX_STATE_BYTES = 12 * 1024 * 1024;
const MAX_STORAGE_BYTES = 32 * 1024 * 1024;
const { RECOVERY_TTL_MS: STORAGE_TTL_MS } = require('./context-recovery-limits');
const HASH = /^[a-f0-9]{64}$/;
const STORE_ID = /^[a-f0-9]{32}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

function storageFailure() {
  return Object.assign(new Error('context_recovery_storage_unavailable'), {
    code: 'context_recovery_storage_unavailable',
    statusCode: 503,
  });
}
function storageData(value, maximum = MAX_STATE_BYTES) {
  try {
    return normalizeCompactionData(value, maximum);
  } catch {
    throw storageFailure();
  }
}
function storageEnvelopeData(input, kind) {
  try {
    return normalizeStorageEnvelope(input, kind);
  } catch {
    throw storageFailure();
  }
}
function storageReplyData(input, operation) {
  if (operation === 'load') return storageEnvelopeData(input, 'record');
  if (operation === 'scan') return storageEnvelopeData(input, 'scan');
  if (operation === 'load-reference') return storageEnvelopeData(input, 'reference-record');
  if (operation === 'scan-reference') return storageEnvelopeData(input, 'scan-reference');
  return storageData(input, MAX_STATE_BYTES + 4096);
}
function exact(value, keys) {
  if (!record(value) || Object.keys(value).sort().join(',') !== keys) throw storageFailure();
}
function storageContext(input) {
  const value = storageData(input, 1024);
  exact(value, 'createdAt,expiresAt,kind,revision,scope,storeId,version');
  if (
    value.version !== 1 ||
    typeof value.storeId !== 'string' ||
    typeof value.scope !== 'string' ||
    !STORE_ID.test(value.storeId) ||
    !HASH.test(value.scope) ||
    !['state', 'revoked', 'header'].includes(value.kind) ||
    !integer(value.revision) ||
    value.revision < 1 ||
    !integer(value.createdAt) ||
    !integer(value.expiresAt) ||
    value.expiresAt <= value.createdAt ||
    value.expiresAt - value.createdAt > STORAGE_TTL_MS
  )
    throw storageFailure();
  return value;
}
function storageState(input) {
  const value = storageEnvelopeData(input, 'state');
  if (!record(value)) throw storageFailure();
  return value;
}
// Private startup metadata only. This is neither a content index nor authority
// to import a checkpoint. Bound and validate replies at both worker boundaries.
function storageCatalog(input) {
  const value = storageData(input, 4096);
  if (!Array.isArray(value) || value.length > 4) throw storageFailure();
  let previous = '';
  for (const entry of value) {
    exact(entry, 'createdAt,expiresAt,revision,scope');
    if (
      typeof entry.scope !== 'string' ||
      !HASH.test(entry.scope) ||
      entry.scope <= previous ||
      !integer(entry.revision) ||
      entry.revision < 1 ||
      !integer(entry.createdAt) ||
      !integer(entry.expiresAt) ||
      entry.expiresAt <= entry.createdAt ||
      entry.expiresAt - entry.createdAt > STORAGE_TTL_MS
    )
      throw storageFailure();
    previous = entry.scope;
  }
  return value;
}
// Only this parser's immutable clones can skip repeated in-process parsing.
// Weak ownership adds no retention, survives no structured-clone boundary and
// confers no session/read authority. Caller-owned frozen lookalikes still parse.
const validatedRequests = new WeakSet();
function freezeRequest(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRequest(child);
    Object.freeze(value);
  }
}
function storageRequest(input) {
  if (validatedRequests.has(input)) return input;
  const value = parseStorageRequest(input);
  return ownRequest(value);
}
function ownRequest(value) {
  freezeRequest(value);
  validatedRequests.add(value);
  return value;
}
function parseStorageRequest(input) {
  const value = storageEnvelopeData(input, 'request');
  return validateStorageRequest(value);
}
// The worker envelope already owns a complete bounded descriptor-only clone.
// Preserve the smaller request byte ceiling before reusing that clone; the
// envelope's depth/node limits are at least as strict as the nested request's.
// No caller-supplied marker can enter the private immutable-request cache.
function storageWorkerRequest(input) {
  try {
    const message = storageEnvelopeData(input, 'worker-request');
    let parsed;
    // Keep envelope admission separate from request semantics. The worker can
    // retain the validated id and send the same negative reply on request
    // failure, rather than turning an ordinary rejection into a terminal exit.
    return {
      id: message?.id,
      parseRequest() {
        try {
          if (parsed) return parsed;
          exact(message, 'id,request');
          if (!Number.isSafeInteger(message.id) || message.id < 1) throw storageFailure();
          const value = message.request;
          if (value?.operation === 'close') {
            exact(value, 'operation');
            parsed = Object.freeze(value);
          } else {
            const maximum =
              (version9StorageEnvelope(value, 'request') ? RECOVERY_STATE_BYTES : MAX_STATE_BYTES) +
              4096;
            if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw storageFailure();
            parsed = ownRequest(validateStorageRequest(value));
          }
          return parsed;
        } catch {
          throw storageFailure();
        }
      },
    };
  } catch {
    throw storageFailure();
  }
}
function validateStorageRequest(value) {
  if (!record(value) || typeof value.operation !== 'string') throw storageFailure();
  if (['scan', 'scan-reference'].includes(value.operation)) {
    exact(value, 'after,operation');
    if (value.after !== null && (typeof value.after !== 'string' || !HASH.test(value.after)))
      throw storageFailure();
    return value;
  }
  if (['inspect', 'revoke-all', 'catalog', 'sweep'].includes(value.operation)) {
    exact(value, 'operation');
    return value;
  }
  if (value.operation === 'revoke-scopes') {
    exact(value, 'entries,operation');
    if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 4)
      throw storageFailure();
    const seen = new Set();
    for (const entry of value.entries) {
      exact(entry, 'createdAt,expiresAt,scope');
      if (
        typeof entry.scope !== 'string' ||
        !HASH.test(entry.scope) ||
        seen.has(entry.scope) ||
        !integer(entry.createdAt) ||
        !integer(entry.expiresAt) ||
        entry.expiresAt <= entry.createdAt ||
        entry.expiresAt - entry.createdAt > STORAGE_TTL_MS
      )
        throw storageFailure();
      seen.add(entry.scope);
    }
    return value;
  }
  if (typeof value.scope !== 'string' || !HASH.test(value.scope)) throw storageFailure();
  if (['save-reference', 'save-reference-state'].includes(value.operation)) {
    exact(value, 'expectedRevision,expiresAt,operation,payloads,reference,scope');
    if (
      !integer(value.expectedRevision) ||
      value.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !integer(value.expiresAt)
    )
      throw storageFailure();
    try {
      value.reference =
        value.operation === 'save-reference-state'
          ? parseReferenceState(value.reference)
          : parseReferenceCheckpoint(value.reference);
      value.payloads = parseReferencePayloads(
        value.payloads,
        value.reference.metadata.sourceVersion
      );
      if (value.expiresAt !== value.reference.metadata.expiresAt) throw storageFailure();
    } catch {
      throw storageFailure();
    }
    return value;
  }
  if (value.operation === 'settle-reader') {
    exact(value, 'expectedRevision,operation,scope,settlement');
    if (
      !integer(value.expectedRevision) ||
      value.expectedRevision < 1 ||
      value.expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      throw storageFailure();
    try {
      value.settlement = parseReaderSettlement(value.settlement);
    } catch {
      throw storageFailure();
    }
    return value;
  }
  if (value.operation === 'read-source') {
    exact(value, 'arguments,expectedRevision,maxResultBytes,operation,scope,source');
    if (
      !integer(value.expectedRevision) ||
      value.expectedRevision < 1 ||
      !integer(value.maxResultBytes) ||
      value.maxResultBytes > 65536
    )
      throw storageFailure();
    try {
      value.source = parseStoredEvidenceSource(value.source);
      const parsed = parseContextEvidenceRequest('hpm_read_retained_evidence', value.arguments);
      if (
        !parsed.ok ||
        parsed.arguments.sourceId !== value.source.sourceId ||
        parsed.arguments.digest !== value.source.digest
      )
        throw storageFailure();
      value.arguments = parsed.arguments;
    } catch {
      throw storageFailure();
    }
    return value;
  }
  if (['load', 'load-reference'].includes(value.operation)) exact(value, 'operation,scope');
  else if (value.operation === 'revoke') exact(value, 'expectedRevision,operation,scope');
  else if (value.operation === 'save') {
    exact(value, 'expectedRevision,expiresAt,operation,scope,state');
    if (!integer(value.expiresAt)) throw storageFailure();
    value.state = storageState(value.state);
  } else throw storageFailure();
  if (
    !['load', 'load-reference'].includes(value.operation) &&
    (!integer(value.expectedRevision) || value.expectedRevision >= Number.MAX_SAFE_INTEGER)
  )
    throw storageFailure();
  return value;
}

// One bounded record and the complete metadata generation from one transaction.
// The request cursor is checked again at each asynchronous adapter boundary.
function parseScanPage(input, after, referenceOnly) {
  const value = storageReplyData(input, referenceOnly ? 'scan-reference' : 'scan');
  exact(value, 'catalog,record,scope');
  const catalog = storageCatalog(value.catalog);
  if (after !== undefined) {
    storageRequest({ operation: referenceOnly ? 'scan-reference' : 'scan', after });
    if (after !== null && !catalog.some((entry) => entry.scope === after)) throw storageFailure();
  }
  const entry =
    after === undefined
      ? catalog.find((item) => item.scope === value.scope)
      : catalog.find((item) => after === null || item.scope > after);
  if (value.scope === null && value.record === null) {
    if (catalog.length || entry) throw storageFailure();
    return value;
  }
  if (!entry || entry.scope !== value.scope) throw storageFailure();
  exact(
    value.record,
    referenceOnly ? 'createdAt,expiresAt,reference,revision' : 'createdAt,expiresAt,revision,state'
  );
  if (['revision', 'createdAt', 'expiresAt'].some((name) => value.record[name] !== entry[name]))
    throw storageFailure();
  if (referenceOnly) {
    try {
      value.record.reference = parseReferenceState(value.record.reference);
      if (
        value.record.reference.metadata.expiresAt !== entry.expiresAt ||
        value.record.reference.metadata.createdAt > entry.createdAt
      )
        throw storageFailure();
    } catch {
      throw storageFailure();
    }
  } else value.record.state = storageState(value.record.state);
  return value;
}
function storageScanPage(input, after) {
  return parseScanPage(input, after, false);
}
function storageReferenceScanPage(input, after) {
  return parseScanPage(input, after, true);
}

// An explicit internal capability; never inferred by issuing a request.
function declareRecoveryScan(execute) {
  Object.defineProperty(execute, 'recoveryScanVersion', { value: 1 });
  return execute;
}
function supportsRecoveryScan(execute) {
  return (
    typeof execute === 'function' &&
    Object.getOwnPropertyDescriptor(execute, 'recoveryScanVersion')?.value === 1
  );
}
function declareRecoverySourcePages(execute) {
  Object.defineProperty(execute, 'recoverySourcePageVersion', { value: 1 });
  return execute;
}
function supportsRecoverySourcePages(execute) {
  return (
    typeof execute === 'function' &&
    Object.getOwnPropertyDescriptor(execute, 'recoverySourcePageVersion')?.value === 1
  );
}

function declareRecoveryReaderSettlement(execute) {
  Object.defineProperty(execute, 'recoveryReaderSettlementVersion', { value: 1 });
  return execute;
}
function supportsRecoveryReaderSettlement(execute) {
  return (
    typeof execute === 'function' &&
    Object.getOwnPropertyDescriptor(execute, 'recoveryReaderSettlementVersion')?.value === 1
  );
}

function declareRecoveryReferenceWrites(execute) {
  Object.defineProperty(execute, 'recoveryReferenceWriteVersion', { value: 1 });
  return execute;
}
function supportsRecoveryReferenceWrites(execute) {
  return (
    typeof execute === 'function' &&
    Object.getOwnPropertyDescriptor(execute, 'recoveryReferenceWriteVersion')?.value === 1
  );
}

function declareRecoveryReferenceStates(execute) {
  Object.defineProperty(execute, 'recoveryReferenceStateVersion', { value: 1 });
  return execute;
}
function supportsRecoveryReferenceStates(execute) {
  return (
    typeof execute === 'function' &&
    Object.getOwnPropertyDescriptor(execute, 'recoveryReferenceStateVersion')?.value === 1
  );
}

function declareRecoveryReferenceScan(execute) {
  Object.defineProperty(execute, 'recoveryReferenceScanVersion', { value: 1 });
  return execute;
}
function supportsRecoveryReferenceScan(execute) {
  return (
    typeof execute === 'function' &&
    Object.getOwnPropertyDescriptor(execute, 'recoveryReferenceScanVersion')?.value === 1
  );
}

module.exports = {
  MAX_STATE_BYTES,
  MAX_STORAGE_BYTES,
  STORAGE_TTL_MS,
  storageFailure,
  storageData,
  storageEnvelopeData,
  storageReplyData,
  storageContext,
  storageState,
  storageCatalog,
  storageRequest,
  storageWorkerRequest,
  storageScanPage,
  storageReferenceScanPage,
  declareRecoveryScan,
  supportsRecoveryScan,
  declareRecoverySourcePages,
  supportsRecoverySourcePages,
  declareRecoveryReaderSettlement,
  supportsRecoveryReaderSettlement,
  declareRecoveryReferenceWrites,
  supportsRecoveryReferenceWrites,
  declareRecoveryReferenceStates,
  supportsRecoveryReferenceStates,
  declareRecoveryReferenceScan,
  supportsRecoveryReferenceScan,
};
