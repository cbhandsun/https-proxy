'use strict';

const { createHash } = require('node:crypto');
const {
  storageEnvelopeData,
  storageState,
  storageContext,
  storageFailure,
} = require('./context-recovery-storage-contract');
const { parseRootCheckpoint } = require('./context-recovery-root-checkpoint');
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
  function open(row) {
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
      Buffer.byteLength(value.output) !== value.bytes ||
      Buffer.from(value.output).toString('utf8') !== value.output ||
      hash(value.output) !== value.digest ||
      blobId({ ...value, createdAt: row.created_at, expiresAt: row.expires_at }) !== row.blob_id
    )
      throw storageFailure();
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
    const bytes = Buffer.from(output, 'utf8'),
      prefix = bytes.subarray(0, source.coveredThrough);
    if (
      bytes.length !== source.bytes ||
      bytes.toString('utf8') !== output ||
      hash(bytes) !== source.digest ||
      !Buffer.from(prefix.toString('utf8')).equals(prefix)
    )
      throw storageFailure();
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
    saveReference(input, incoming, priorState, scope) {
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
            payload(source, open(selected).output);
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
      let checkpoint;
      const cold = codec.isReferenceState(state);
      if (cold) {
        const reference = codec.referenceState(state, scope);
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
