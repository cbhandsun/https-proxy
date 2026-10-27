'use strict';

const { createHash } = require('node:crypto');
const {
  storageEnvelopeData,
  storageState,
  storageContext,
  storageFailure,
} = require('./context-recovery-storage-contract');
const { parseRootCheckpoint } = require('./context-recovery-root-checkpoint');
const { parseCompletedEvidenceSource } = require('./context-evidence-source');
const {
  normalizeRecoveryCheckpointData,
  RECOVERY_STATE_BYTES,
} = require('./context-recovery-state-data');
const { recoveryRootCapacity } = require('./context-recovery-capacity');
const { parseReferencePayloads } = require('./context-recovery-reference-write');
const {
  parseReferenceState,
  referenceStateFromCheckpoint,
  hydrateReferenceState,
  validateReferenceTransition,
  parseReferenceTransition,
} = require('./context-recovery-reference-state');
const { buildContextArtifactPage } = require('./context-artifact-page');
const {
  contextEvidencePageBudget,
  attachContextEvidencePageSource,
} = require('./context-evidence-page');

const FORMAT = 'recovery-referenced-checkpoint';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hashText = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value) => value && !Array.isArray(value) && Object.keys(value).sort().join(',');
const blobId = (source) =>
  hash(
    JSON.stringify([
      'hpm/recovery/blob/v1',
      source.sourceId,
      source.digest,
      source.bytes,
      source.createdAt,
      source.expiresAt,
    ])
  );

// Internal persistence codec, never a reader capability. The SQLite owner must
// hold its writer transaction for every operation, including hydration. The
// session layer still performs principal/policy/branch authorization separately.
function createRecoveryBlobStorage(database, cipher, getStoreId, enabled) {
  function context(row) {
    if (!hashText(row.scope) || !hashText(row.blob_id)) throw storageFailure();
    return storageContext({
      storeId: getStoreId(),
      scope: hash('hpm/recovery/blob/aad/v1\0' + row.scope + '\0' + row.blob_id),
      revision: 1,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      kind: 'state',
      version: 1,
    });
  }
  function coveredPrefix(bytes, through) {
    const prefix = bytes.subarray(0, through);
    if (!Buffer.from(prefix.toString('utf8')).equals(prefix)) throw storageFailure();
  }
  function open(row, source) {
    const value = cipher.open(context(row), row.envelope);
    if (
      keys(value) !== 'bytes,digest,output,sourceId,version' ||
      value.version !== 1 ||
      typeof value.sourceId !== 'string' ||
      !/^hce_[a-f0-9]{32}$/.test(value.sourceId) ||
      typeof value.output !== 'string' ||
      !hashText(value.digest) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > 2 * 1024 * 1024 ||
      Buffer.byteLength(value.output) !== value.bytes
    )
      throw storageFailure();
    const bytes = Buffer.from(value.output, 'utf8');
    if (
      bytes.length !== value.bytes ||
      bytes.toString('utf8') !== value.output ||
      hash(bytes) !== value.digest ||
      blobId({ ...value, createdAt: row.created_at, expiresAt: row.expires_at }) !== row.blob_id
    )
      throw storageFailure();
    if (source !== undefined) {
      if (
        value.sourceId !== source.sourceId ||
        value.bytes !== source.bytes ||
        value.digest !== source.digest
      )
        throw storageFailure();
      // Only this call's freshly authenticated bytes can validate the parsed
      // reference prefix. Nothing is retained or lent to another transaction.
      coveredPrefix(bytes, source.coveredThrough);
    }
    return value;
  }
  function rows(scope) {
    const selected = database
      .prepare('SELECT * FROM recovery_blob WHERE scope=? LIMIT 1025')
      .all(scope);
    if (selected.length > 1024) throw storageFailure();
    return selected;
  }
  function remove(scope, retained = new Set()) {
    if (!enabled()) return 0;
    let bytes = 0;
    // Authenticate before deleting even an unreferenced row. Corruption cannot
    // disappear through revocation, expiry or a new manifest replacing it.
    for (const row of rows(scope)) {
      open(row);
      if (retained.has(row.blob_id)) continue;
      const result = database
        .prepare('DELETE FROM recovery_blob WHERE scope=? AND blob_id=?')
        .run(scope, row.blob_id);
      if (result.changes !== 1) throw storageFailure();
      bytes += row.envelope.length;
    }
    return bytes;
  }
  function put(source, scope) {
    const id = blobId(source);
    const prior = database
      .prepare('SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?')
      .get(scope, id);
    if (prior) {
      if (open(prior).output !== source.output) throw storageFailure();
    } else {
      const row = {
        scope,
        blob_id: id,
        created_at: source.createdAt,
        expires_at: source.expiresAt,
      };
      const envelope = cipher.seal(context(row), {
        version: 1,
        sourceId: source.sourceId,
        digest: source.digest,
        bytes: source.bytes,
        output: source.output,
      });
      database
        .prepare('INSERT INTO recovery_blob VALUES(?,?,?,?,?)')
        .run(scope, id, row.created_at, row.expires_at, envelope);
    }
    const { output: _output, ...metadata } = source;
    return { ...metadata, outputRef: id };
  }
  function arrays(checkpoint) {
    if (
      !Array.isArray(checkpoint?.root?.ledger?.sources) ||
      !Array.isArray(checkpoint.stagedSources)
    )
      throw storageFailure();
    return [checkpoint.root.ledger.sources, checkpoint.stagedSources];
  }
  const referenceSources = (reference) => [
    ...reference.metadata.ledger.sources,
    ...reference.stagedSources,
  ];
  function referenceRows(reference, scope) {
    const sources = new Map(referenceSources(reference).map((source) => [blobId(source), source]));
    const selected = database
      .prepare(
        'SELECT blob_id,created_at,expires_at,length(envelope) AS bytes FROM recovery_blob WHERE scope=? LIMIT 513'
      )
      .all(scope);
    if (
      selected.length !== sources.size ||
      selected.length > recoveryRootCapacity(reference.metadata.sourceVersion).maxSources
    )
      throw storageFailure();
    for (const row of selected) {
      const source = sources.get(row.blob_id);
      if (
        !source ||
        row.created_at !== source.createdAt ||
        row.expires_at !== source.expiresAt ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 30 ||
        row.bytes > 12 * 1024 * 1024
      )
        throw storageFailure();
    }
  }
  function payload(source, output) {
    if (typeof output !== 'string') throw storageFailure();
    const bytes = Buffer.from(output, 'utf8');
    if (
      bytes.length !== source.bytes ||
      bytes.toString('utf8') !== output ||
      hash(bytes) !== source.digest
    )
      throw storageFailure();
    coveredPrefix(bytes, source.coveredThrough);
  }
  function snapshotShapeAdmitted(reference) {
    try {
      const { sourceVersion, ...metadata } = reference.metadata;
      const empty = (list) => list.map((source) => ({ ...source, output: '' }));
      // The exact hydrated shape, with scalar empty strings instead of originals,
      // preserves both normalizers' node/depth and array-prefix requirements.
      const skeleton = normalizeRecoveryCheckpointData({
        version: 1,
        kind: 'recovery-write-ahead',
        digest: '0'.repeat(64),
        root: {
          ...metadata,
          version: sourceVersion,
          kind: 'recovery-root',
          ledger: {
            ...metadata.ledger,
            kind: 'evidence-ledger',
            sources: empty(metadata.ledger.sources),
          },
        },
        stagedSources: empty(reference.stagedSources),
        publications: reference.publications,
      });
      function rawBytes(value) {
        if (typeof value === 'string') return Buffer.byteLength(value);
        if (!value || typeof value !== 'object') return 0;
        return Object.keys(value).reduce(
          (bytes, key) => bytes + Buffer.byteLength(key) + rawBytes(value[key]),
          0
        );
      }
      const maximum =
        sourceVersion === 9 || sourceVersion === 10 ? RECOVERY_STATE_BYTES : 12 * 1024 * 1024;
      // Every UTF-8 byte needs at most six JSON bytes. This proves both the
      // final envelope and its payload/ledger subsets fit their old aggregate
      // admissions, including legacy raw-key accounting. Near a boundary, use
      // the original exact hydrate rather than rejecting a valid checkpoint.
      const originals = referenceSources(reference).reduce(
        (bytes, source) => bytes + source.bytes,
        0
      );
      return (
        Math.max(Buffer.byteLength(JSON.stringify(skeleton)), rawBytes(skeleton)) + 6 * originals <=
        maximum
      );
    } catch {
      return false;
    }
  }
  // Only the private reference-read composition supplies admittedReference.
  // It is freshly parsed and row-associated under this same synchronous SQL
  // transaction; it is never retained as a cache or accepted from a request.
  function readPage(state, scope, request, admittedReference, observePayload) {
    let checkpoint;
    const cold = codec.isReferenceState(state);
    if (cold) {
      const reference = admittedReference ?? codec.referenceState(state, scope);
      checkpoint = {
        root: { version: reference.metadata.sourceVersion, ledger: reference.metadata.ledger },
        stagedSources: reference.stagedSources,
      };
    } else if (state.kind === FORMAT) {
      if (!enabled() || keys(state) !== 'checkpoint,kind,version' || state.version !== 2)
        throw storageFailure();
      checkpoint = state.checkpoint;
    } else checkpoint = parseRootCheckpoint(state, state.root);
    const lists = arrays(checkpoint);
    if (lists.flat().length > recoveryRootCapacity(checkpoint.root.version).maxSources)
      throw storageFailure();
    const selected = lists.flat().filter((source) => source.sourceId === request.source.sourceId);
    if (selected.length !== 1) throw storageFailure();
    const source = selected[0];
    if (
      Object.keys(request.source).some(
        (key) => key !== 'trust' && source[key] !== request.source[key]
      )
    )
      throw storageFailure();
    let output = source.output;
    if (state.kind === FORMAT) {
      if ((!cold && source.outputRef !== blobId(source)) || Object.hasOwn(source, 'output'))
        throw storageFailure();
      const row = database
        .prepare('SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?')
        .get(scope, cold ? blobId(source) : source.outputRef);
      if (!row) throw storageFailure();
      output = open(row).output;
      if (observePayload) observePayload({ id: row.blob_id, tag: payloadWitness(row), output });
    }
    const { sourceId: _sourceId, digest: _digest, ...range } = request.arguments;
    const result = buildContextArtifactPage(
      output,
      'utf8',
      source.digest,
      range,
      contextEvidencePageBudget(request.source, request.maxResultBytes)
    );
    return attachContextEvidencePageSource(result, request.source, request.maxResultBytes);
  }
  function payloadWitness(row) {
    return createHash('sha256')
      .update(JSON.stringify(context(row)))
      .update(row.envelope)
      .digest('hex');
  }
  function saveReference(input, incoming, priorState, scope, observed) {
    let prior, reference;
    if (priorState !== null && codec.isReferenceState(priorState)) {
      if (!enabled() || keys(priorState) !== 'kind,reference,version') throw storageFailure();
      // The transition parser returns its own fully validated prior clone.
      // Use it for row association and inventory instead of parsing it twice.
      const parsed = parseReferenceTransition(input, priorState.reference);
      prior = parsed.prior;
      reference = parsed.next;
      referenceRows(prior, scope);
    } else {
      prior = priorState === null ? null : codec.referenceState(priorState, scope);
      reference = validateReferenceTransition(input, prior);
    }
    const old = new Map(
      prior ? referenceSources(prior).map((source) => [source.sourceId, source]) : []
    );
    const payloads = new Map(
      parseReferencePayloads(incoming, reference.metadata.sourceVersion).map((source) => [
        source.sourceId,
        source.output,
      ])
    );
    const retained = new Set();
    let migrated;
    for (const source of referenceSources(reference)) {
      const existing = old.get(source.sourceId),
        id = blobId(source);
      if (retained.has(id)) throw storageFailure();
      retained.add(id);
      if (existing) {
        if (payloads.has(source.sourceId)) throw storageFailure();
        const row = database
          .prepare('SELECT blob_id FROM recovery_blob WHERE scope=? AND blob_id=?')
          .get(scope, id);
        if (!row) {
          if (priorState === null || priorState.kind === FORMAT) throw storageFailure();
          migrated ??= new Map(
            arrays(codec.decode(priorState, scope))
              .flat()
              .map((value) => [value.sourceId, value])
          );
          const output = migrated.get(source.sourceId)?.output;
          payload(source, output);
          put({ ...source, output }, scope);
        } else if (
          source.coveredThrough !== existing.coveredThrough ||
          source.readComplete !== existing.readComplete
        ) {
          const selected = database
            .prepare('SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?')
            .get(scope, id);
          if (!selected) throw storageFailure();
          if (observed?.id === id && observed.tag !== payloadWitness(selected))
            throw storageFailure();
          payload(source, observed?.id === id ? observed.output : open(selected).output);
        }
      } else {
        if (!payloads.has(source.sourceId)) throw storageFailure();
        const output = payloads.get(source.sourceId);
        payloads.delete(source.sourceId);
        payload(source, output);
        put({ ...source, output }, scope);
      }
    }
    if (payloads.size) throw storageFailure();
    // Retained immutable ciphertext is not decrypted for metadata saves.
    // Anything being discarded must still authenticate before deletion.
    for (const row of database
      .prepare('SELECT blob_id FROM recovery_blob WHERE scope=? LIMIT 1025')
      .all(scope)) {
      if (retained.has(row.blob_id)) continue;
      open(
        database
          .prepare('SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?')
          .get(scope, row.blob_id)
      );
      if (
        database
          .prepare('DELETE FROM recovery_blob WHERE scope=? AND blob_id=?')
          .run(scope, row.blob_id).changes !== 1
      )
        throw storageFailure();
    }
    referenceRows(reference, scope);
    return storageState({ version: 3, kind: FORMAT, reference });
  }
  const codec = {
    isReferenceState(state) {
      return state.kind === FORMAT && state.version === 3;
    },
    referenceState(state, scope) {
      if (!codec.isReferenceState(state))
        return referenceStateFromCheckpoint(codec.decode(state, scope));
      if (!enabled() || keys(state) !== 'kind,reference,version') throw storageFailure();
      const reference = parseReferenceState(state.reference);
      referenceRows(reference, scope);
      return reference;
    },
    authenticateReferenceSnapshot(state, scope) {
      // Metadata already validates root/ledger/branch/publication associations.
      // Authenticate every payload under this transaction without rebuilding a
      // full plaintext checkpoint merely to return its revision/expiry witness.
      // Nothing from this pass survives this call or authorizes a later read.
      const reference = codec.referenceState(state, scope);
      if (!snapshotShapeAdmitted(reference)) return codec.decode(state, scope).root.expiresAt;
      for (const source of referenceSources(reference)) {
        const row = database
          .prepare('SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?')
          .get(scope, blobId(source));
        if (!row) throw storageFailure();
        const value = open(row, source);
        if (
          !parseCompletedEvidenceSource({
            callId: source.callId,
            toolName: source.toolName,
            arguments: {},
            completed: true,
            output: value.output,
          }).ok
        )
          throw storageFailure();
      }
      return reference.metadata.expiresAt;
    },
    saveReference(input, incoming, priorState, scope) {
      return saveReference(input, incoming, priorState, scope);
    },
    isCheckpoint(state) {
      if (state.kind === FORMAT) throw storageFailure();
      return state.kind === 'recovery-write-ahead';
    },
    encode(input, scope) {
      const checkpoint = storageState(input);
      parseRootCheckpoint(checkpoint, checkpoint.root);
      const retained = new Set();
      for (const list of arrays(checkpoint)) {
        for (let index = 0; index < list.length; index++) {
          const reference = put(list[index], scope);
          if (retained.has(reference.outputRef)) throw storageFailure();
          retained.add(reference.outputRef);
          list[index] = reference;
        }
      }
      remove(scope, retained);
      return storageState({ version: 2, kind: FORMAT, checkpoint });
    },
    decode(state, scope) {
      if (codec.isReferenceState(state)) {
        const reference = codec.referenceState(state, scope);
        const payloads = referenceSources(reference).map((source) => {
          const row = database
            .prepare('SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?')
            .get(scope, blobId(source));
          if (!row) throw storageFailure();
          return { sourceId: source.sourceId, output: open(row).output };
        });
        return hydrateReferenceState(reference, payloads);
      }
      if (state.kind !== FORMAT) {
        if (enabled() && rows(scope).length) throw storageFailure();
        return state;
      }
      if (!enabled() || keys(state) !== 'checkpoint,kind,version' || state.version !== 2)
        throw storageFailure();
      const checkpoint = storageEnvelopeData(state.checkpoint, 'state');
      const seen = new Set();
      for (const list of arrays(checkpoint)) {
        for (let index = 0; index < list.length; index++) {
          const { outputRef, ...source } = list[index];
          if (
            !hashText(outputRef) ||
            Object.hasOwn(source, 'output') ||
            seen.has(outputRef) ||
            blobId(source) !== outputRef
          )
            throw storageFailure();
          seen.add(outputRef);
          const row = database
            .prepare('SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?')
            .get(scope, outputRef);
          if (!row) throw storageFailure();
          const value = open(row);
          if (
            value.sourceId !== source.sourceId ||
            value.digest !== source.digest ||
            value.bytes !== source.bytes
          )
            throw storageFailure();
          list[index] = { ...source, output: value.output };
        }
      }
      if (rows(scope).length !== seen.size) throw storageFailure();
      parseRootCheckpoint(checkpoint, checkpoint.root);
      return storageState(checkpoint);
    },
    validateOwnership() {
      if (!enabled()) return;
      if (
        database
          .prepare(
            "SELECT 1 FROM recovery_blob b LEFT JOIN recovery_state s ON b.scope=s.scope WHERE s.scope IS NULL OR s.kind<>'state' LIMIT 1"
          )
          .get()
      )
        throw storageFailure();
    },
    remove,
    readPage(state, scope, request) {
      return readPage(state, scope, request);
    },
    readAndSettleReference(state, scope, request, prepare, apply) {
      // This composition cannot return its authenticated plaintext witness or
      // reuse it across calls/transactions. Save and observation stay synchronous.
      if (!codec.isReferenceState(state)) throw storageFailure();
      let observed;
      try {
        const reference = codec.referenceState(state, scope);
        const settle = prepare(reference);
        const page = readPage(state, scope, request, reference, (value) => {
          observed = value;
        });
        const settlement = settle(page);
        const nextReference = apply(reference, settlement);
        const saved = saveReference(nextReference, [], state, scope, observed);
        return { page, settlement, nextReference, state: saved };
      } finally {
        if (observed) observed.output = undefined;
      }
    },
    readReferencePage(state, scope, request, prepare) {
      if (!codec.isReferenceState(state)) throw storageFailure();
      const reference = codec.referenceState(state, scope);
      // Reservation validation must finish before touching the payload. Its
      // returned synchronous settlement consumes the actual authenticated page.
      const settle = prepare(reference);
      const page = readPage(state, scope, request, reference);
      return { reference, page, settlement: settle(page) };
    },
    usage(scope) {
      if (!enabled()) return { records: 0, bytes: 0 };
      return database
        .prepare(
          'SELECT count(*) AS records, coalesce(sum(length(envelope)),0) AS bytes FROM recovery_blob WHERE scope=?'
        )
        .get(scope);
    },
  };
  return codec;
}

module.exports = { createRecoveryBlobStorage };
