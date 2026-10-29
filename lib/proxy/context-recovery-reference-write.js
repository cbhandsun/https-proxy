'use strict';

const {
  normalizeRecoveryCheckpointData,
  normalizeRecoveryReferenceData,
} = require('./context-recovery-state-data');
const { normalizeEvidencePayloadEnvelope } = require('./context-evidence-payload-envelope');
const { fingerprintRecoveryReference } = require('./context-recovery-fingerprint');
const { parseStoredEvidenceSource } = require('./context-evidence-stored-page');
const { parseEvidenceLedgerMetadata } = require('./context-evidence-ledger-state');
const { RECOVERY_ROOT_VERSION, recoveryRootCapacity } = require('./context-recovery-capacity');

const immutable = [
  'sourceId',
  'digest',
  'bytes',
  'createdAt',
  'expiresAt',
  'callId',
  'toolName',
  'argumentsDigest',
];
const rootIdentity = [
  'rootId',
  'principal',
  'protocol',
  'target',
  'policyFingerprint',
  'createdAt',
  'expiresAt',
];
const keys = (value) => value && !Array.isArray(value) && Object.keys(value).sort().join(',');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function invalid() {
  return Object.assign(new TypeError('invalid_recovery_reference_write'), {
    code: 'invalid_recovery_reference_write',
  });
}
function data(input) {
  return normalizeRecoveryReferenceData(input, 12 * 1024 * 1024);
}
function codec() {
  // Wire parsing is imported by the storage contract. Defer this dependency.
  return require('./context-recovery-root-checkpoint');
}
function lists(state) {
  return [state.root.ledger.sources, state.stagedSources];
}
function sourceMetadata(input) {
  if (
    keys(input) !==
    'argumentsDigest,bytes,callId,coveredThrough,createdAt,digest,expiresAt,readComplete,sourceId,toolName'
  )
    throw invalid();
  const { sourceId, digest, bytes, callId, toolName, argumentsDigest, expiresAt } = input;
  parseStoredEvidenceSource({
    sourceId,
    digest,
    bytes,
    callId,
    toolName,
    argumentsDigest,
    expiresAt,
    trust: 'tool_data_not_instructions',
  });
  if (
    !integer(input.createdAt) ||
    input.createdAt >= expiresAt ||
    !integer(input.coveredThrough) ||
    input.coveredThrough > bytes ||
    typeof input.readComplete !== 'boolean' ||
    (input.readComplete && input.coveredThrough !== bytes) ||
    (bytes > 0 && input.readComplete !== (input.coveredThrough === bytes))
  )
    throw invalid();
  return input;
}

// A distinct wire representation, never a recovery-root or restoration token.
// The original digest remains bound to the fully materialized checkpoint.
function parseReferenceCheckpoint(input) {
  try {
    const value = data(input);
    if (
      keys(value) !== 'digest,kind,metadata,publications,sourceDigest,stagedSources,version' ||
      value.version !== 1 ||
      value.kind !== 'recovery-reference-write' ||
      !hash(value.sourceDigest)
    )
      throw invalid();
    const { digest, ...payload } = value;
    if (!hash(digest) || digest !== fingerprintRecoveryReference(payload)) throw invalid();
    const root = value.metadata;
    const capacity = recoveryRootCapacity(root?.sourceVersion);
    if (
      !root ||
      root.kind !== 'recovery-root-metadata' ||
      root.version !== 1 ||
      !integer(root.sourceVersion) ||
      root.sourceVersion < 1 ||
      root.sourceVersion > RECOVERY_ROOT_VERSION ||
      keys(root.ledger) !==
        'capturedCount,kind,observedAt,ownerBinding,policy,readCount,sources,version' ||
      root.ledger.kind !== 'evidence-ledger-metadata' ||
      root.ledger.version !== 1 ||
      !Array.isArray(root.ledger.sources) ||
      root.ledger.sources.length > capacity.maxSources ||
      !Array.isArray(value.stagedSources) ||
      value.stagedSources.length > capacity.maxSources ||
      root.ledger.sources.length + value.stagedSources.length > capacity.maxSources ||
      !Array.isArray(value.publications) ||
      value.publications.length > capacity.maxSnapshots
    )
      throw invalid();
    const { sourceVersion, ...metadata } = root;
    require('./context-recovery-root-policy').validateRecoveryRootPolicy({
      ...metadata,
      kind: 'recovery-root',
      version: sourceVersion,
    });
    const seen = new Set();
    for (const source of [...root.ledger.sources, ...value.stagedSources]) {
      sourceMetadata(source);
      if (seen.has(source.sourceId)) throw invalid();
      seen.add(source.sourceId);
    }
    parseEvidenceLedgerMetadata(
      {
        ...root.ledger,
        sources: [...root.ledger.sources, ...value.stagedSources].sort(
          (a, b) => a.createdAt - b.createdAt
        ),
      },
      root.ledger.ownerBinding,
      root.ledger.policy
    );
    require('./context-recovery-root-state').validateRecoveryRootMetadata({
      metadata: root,
      stagedSources: value.stagedSources,
    });
    codec().parseRecoveryPublications(
      value.publications,
      root.snapshots.map((snapshot) => snapshot.id),
      capacity.maxSnapshots
    );
    return value;
  } catch {
    throw invalid();
  }
}

function createReferenceWrite(input, prior) {
  try {
    const safe = normalizeRecoveryCheckpointData(input);
    const parsed = codec().parseRootCheckpoint(safe, safe.root);
    const state = codec().createRootCheckpoint(
      parsed.root,
      parsed.stagedSources,
      parsed.publications ?? []
    );
    const old = prior == null ? null : normalizeRecoveryCheckpointData(prior);
    if (old) codec().parseRootCheckpoint(old, old.root);
    if (old && rootIdentity.some((key) => old.root[key] !== state.root[key])) throw invalid();
    if (old && (old.root.binding.format ?? 2) !== (state.root.binding.format ?? 2)) throw invalid();
    if (old && old.root.budget.version !== state.root.budget.version) throw invalid();
    if (old && recoveryRootCapacity(old.root.version) !== recoveryRootCapacity(state.root.version))
      throw invalid();
    const retained = new Map(
      old
        ? lists(old)
            .flat()
            .map((source) => [source.sourceId, source])
        : []
    );
    const payloads = [];
    function project(sources) {
      return sources.map(({ output, ...source }) => {
        const existing = retained.get(source.sourceId);
        if (existing && immutable.some((key) => existing[key] !== source[key])) throw invalid();
        if (existing && existing.output !== output) throw invalid();
        if (!existing) payloads.push({ sourceId: source.sourceId, output });
        return source;
      });
    }
    const sources = project(state.root.ledger.sources);
    const stagedSources = project(state.stagedSources);
    const payload = {
      version: 1,
      kind: 'recovery-reference-write',
      sourceDigest: state.digest,
      metadata: {
        ...state.root,
        kind: 'recovery-root-metadata',
        version: 1,
        sourceVersion: state.root.version,
        ledger: { ...state.root.ledger, kind: 'evidence-ledger-metadata', version: 1, sources },
      },
      stagedSources,
      publications: state.publications ?? [],
    };
    return {
      reference: parseReferenceCheckpoint({
        ...payload,
        digest: fingerprintRecoveryReference(payload),
      }),
      payloads,
    };
  } catch {
    throw invalid();
  }
}

function parseReferencePayloads(input, sourceVersion = 1) {
  try {
    recoveryRootCapacity(sourceVersion);
    const values = normalizeEvidencePayloadEnvelope(
      input,
      sourceVersion === 9 || sourceVersion === 10 ? 112 * 1024 * 1024 : 12 * 1024 * 1024
    );
    if (!Array.isArray(values) || values.length > 512) throw invalid();
    const seen = new Set();
    for (const value of values) {
      if (
        keys(value) !== 'output,sourceId' ||
        typeof value.sourceId !== 'string' ||
        !/^hce_[a-f0-9]{32}$/.test(value.sourceId) ||
        seen.has(value.sourceId) ||
        typeof value.output !== 'string' ||
        Buffer.byteLength(value.output) > 2 * 1024 * 1024 ||
        Buffer.from(value.output).toString('utf8') !== value.output
      )
        throw invalid();
      seen.add(value.sourceId);
    }
    return values;
  } catch {
    throw invalid();
  }
}

function materializeReferenceWrite(input, incoming, prior) {
  try {
    const reference = parseReferenceCheckpoint(input);
    const payloads = new Map(
      parseReferencePayloads(incoming, reference.metadata.sourceVersion).map((value) => [
        value.sourceId,
        value.output,
      ])
    );
    const old = prior == null ? null : normalizeRecoveryCheckpointData(prior);
    if (old) codec().parseRootCheckpoint(old, old.root);
    if (old && rootIdentity.some((key) => old.root[key] !== reference.metadata[key]))
      throw invalid();
    if (old && (old.root.binding.format ?? 2) !== (reference.metadata.binding.format ?? 2))
      throw invalid();
    if (old && old.root.budget.version !== reference.metadata.budget.version) throw invalid();
    if (
      old &&
      recoveryRootCapacity(old.root.version) !==
        recoveryRootCapacity(reference.metadata.sourceVersion)
    )
      throw invalid();
    const retained = new Map(
      old
        ? lists(old)
            .flat()
            .map((source) => [source.sourceId, source])
        : []
    );
    function hydrate(sources) {
      return sources.map((source) => {
        const existing = retained.get(source.sourceId);
        if (existing && immutable.some((key) => existing[key] !== source[key])) throw invalid();
        if (existing && payloads.has(source.sourceId)) throw invalid();
        if (!existing && !payloads.has(source.sourceId)) throw invalid();
        const output = existing ? existing.output : payloads.get(source.sourceId);
        payloads.delete(source.sourceId);
        return { ...source, output };
      });
    }
    const { sourceVersion, ...metadata } = reference.metadata;
    const root = {
      ...metadata,
      kind: 'recovery-root',
      version: sourceVersion,
      ledger: {
        ...metadata.ledger,
        kind: 'evidence-ledger',
        version: 1,
        sources: hydrate(metadata.ledger.sources),
      },
    };
    const stagedSources = hydrate(reference.stagedSources);
    if (payloads.size) throw invalid();
    const state = codec().createRootCheckpoint(root, stagedSources, reference.publications);
    if (state.digest !== reference.sourceDigest) throw invalid();
    return codec().parseRootCheckpoint(state, root);
  } catch {
    throw invalid();
  }
}

module.exports = {
  parseReferenceCheckpoint,
  createReferenceWrite,
  parseReferencePayloads,
  materializeReferenceWrite,
};
