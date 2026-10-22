'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const {
  fingerprintContextData,
  fingerprintRecoveryReference,
} = require('./context-recovery-fingerprint');
const { fingerprintNormalizedValue } = require('./context-recovery-fingerprint-value');
const { parseReferencePayloads } = require('./context-recovery-reference-write');
const { recoveryRootCapacity } = require('./context-recovery-capacity');
const {
  normalizeRecoveryCheckpointData,
  normalizeRecoveryReferenceData,
} = require('./context-recovery-state-data');

const identity = [
  'rootId',
  'principal',
  'protocol',
  'target',
  'policyFingerprint',
  'createdAt',
  'expiresAt',
];
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
function invalid() {
  return Object.assign(new TypeError('invalid_recovery_reference_state'), {
    code: 'invalid_recovery_reference_state',
  });
}
const sources = (state) => [...state.metadata.ledger.sources, ...state.stagedSources];
function parseReferenceStateData(input, reader = false) {
  try {
    let value;
    if (reader) {
      const own = (record, key) =>
        record && typeof record === 'object'
          ? Object.getOwnPropertyDescriptor(record, key)?.value
          : undefined;
      const metadata = own(input, 'metadata');
      const daily =
        own(metadata, 'kind') === 'recovery-root-metadata' && own(metadata, 'sourceVersion') === 10;
      // Reader settlement previously applied the 12 MiB envelope admission
      // before the reference codec's 2/16 MiB admission. Preserve their exact
      // intersection in one descriptor-only clone, including depth/node bounds.
      // This shape selects only a byte ceiling; semantic validation stays below.
      value = normalizeCompactionData(input, (daily ? 12 : 2) * 1024 * 1024);
      if (
        daily &&
        (value?.metadata?.kind !== 'recovery-root-metadata' || value.metadata.sourceVersion !== 10)
      )
        throw invalid();
    } else value = normalizeRecoveryReferenceData(input);
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'digest,kind,metadata,publications,stagedSources,version' ||
      value.version !== 1 ||
      value.kind !== 'recovery-reference-state'
    )
      throw invalid();
    // This payload belongs to this call's bounded descriptor-only clone.
    // Keep unknown-input normalization at every external parser entry.
    const { digest, ...payload } = value;
    if (
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      digest !== fingerprintNormalizedValue(payload)
    )
      throw invalid();
    require('./context-recovery-root-state').validateRecoveryRootMetadata({
      metadata: value.metadata,
      stagedSources: value.stagedSources,
    });
    const capacity = recoveryRootCapacity(value.metadata.sourceVersion);
    if (sources(value).length > capacity.maxSources) throw invalid();
    require('./context-recovery-root-checkpoint').parseRecoveryPublications(
      value.publications,
      value.metadata.snapshots.map((snapshot) => snapshot.id),
      capacity.maxSnapshots
    );
    return value;
  } catch {
    throw invalid();
  }
}
function parseReferenceState(input) {
  return parseReferenceStateData(input);
}
function parseReaderReferenceState(input) {
  return parseReferenceStateData(input, true);
}
function createReferenceState(metadata, stagedSources, publications = []) {
  const payload = {
    version: 1,
    kind: 'recovery-reference-state',
    metadata,
    stagedSources,
    publications,
  };
  try {
    return parseReferenceState({ ...payload, digest: fingerprintRecoveryReference(payload) });
  } catch {
    throw invalid();
  }
}
function referenceStateFromCheckpoint(input) {
  try {
    const codec = require('./context-recovery-root-checkpoint');
    const safe = normalizeRecoveryCheckpointData(input);
    const state = codec.parseRootCheckpoint(safe, safe.root);
    const { version: sourceVersion, ...root } = state.root;
    const project = (values) => values.map(({ output: _output, ...source }) => source);
    return createReferenceState(
      {
        ...root,
        version: 1,
        kind: 'recovery-root-metadata',
        sourceVersion,
        ledger: {
          ...root.ledger,
          kind: 'evidence-ledger-metadata',
          sources: project(root.ledger.sources),
        },
      },
      project(state.stagedSources),
      state.publications ?? []
    );
  } catch {
    throw invalid();
  }
}
// Private comparison of fresh parser outputs. No caller can bypass parsing,
// and no normalized value or authority is cached across public invocations.
function compareReferenceTransition(next, prior) {
  if (
    identity.some((key) => prior.metadata[key] !== next.metadata[key]) ||
    recoveryRootCapacity(prior.metadata.sourceVersion) !==
      recoveryRootCapacity(next.metadata.sourceVersion) ||
    (prior.metadata.binding.format ?? 2) !== (next.metadata.binding.format ?? 2) ||
    next.metadata.budget.version !== prior.metadata.budget.version ||
    next.metadata.observedAt < prior.metadata.observedAt ||
    next.metadata.callCount < prior.metadata.callCount ||
    next.metadata.ledger.capturedCount < prior.metadata.ledger.capturedCount ||
    next.metadata.ledger.readCount < prior.metadata.ledger.readCount
  )
    throw invalid();
  // Public-only ancestry is a property of the original published response,
  // never a mutable annotation on an existing snapshot during persistence.
  if (prior.metadata.publicGenerationFormat === 1 || next.metadata.publicGenerationFormat === 1) {
    const priorViews = new Map(prior.metadata.snapshots.map((view) => [view.id, view]));
    for (const view of next.metadata.snapshots) {
      const previous = priorViews.get(view.id);
      if (previous && (previous.publicResponse === true) !== (view.publicResponse === true))
        throw invalid();
    }
  }
  const remaining = new Map(sources(next).map((source) => [source.sourceId, source]));
  for (const old of sources(prior)) {
    const source = remaining.get(old.sourceId);
    if (!source) {
      if (old.expiresAt > next.metadata.observedAt) throw invalid();
    } else if (
      immutable.some((key) => source[key] !== old[key]) ||
      source.coveredThrough < old.coveredThrough ||
      (old.readComplete && !source.readComplete)
    )
      throw invalid();
  }
  return next;
}
// Return both independent safe clones for callers that also need the prior
// source inventory. Every external input is still completely parsed here.
function parseReferenceTransition(nextInput, priorInput) {
  try {
    const next = parseReferenceState(nextInput);
    const prior = priorInput === null ? null : parseReferenceState(priorInput);
    if (prior !== null) compareReferenceTransition(next, prior);
    return { next, prior };
  } catch {
    throw invalid();
  }
}
function validateReferenceTransition(nextInput, priorInput) {
  return parseReferenceTransition(nextInput, priorInput).next;
}

// Stored metadata proves association only. The live owner supplies the current
// policy, binding scope and budget; storage must not choose its own authority.
function validateReferenceAgainstCurrent(input, currentInput) {
  try {
    const current = parseReferenceState(currentInput),
      stored = parseReferenceState(input);
    compareReferenceTransition(current, stored);
    if (
      fingerprintContextData(stored.metadata.budget) !==
      fingerprintContextData(current.metadata.budget)
    )
      throw invalid();
    if (
      stored.metadata.ledger.ownerBinding !== current.metadata.ledger.ownerBinding ||
      fingerprintContextData(stored.metadata.ledger.policy) !==
        fingerprintContextData(current.metadata.ledger.policy)
    )
      throw invalid();
    require('./context-recovery-binding-state').parseContextBindingState(
      stored.metadata.binding,
      current.metadata.binding,
      recoveryRootCapacity(current.metadata.sourceVersion).maxSnapshots
    );
    return stored;
  } catch {
    throw invalid();
  }
}
function hydrateReferenceState(input, incoming) {
  try {
    const reference = parseReferenceState(input);
    const payloads = new Map(
      parseReferencePayloads(incoming, reference.metadata.sourceVersion).map((source) => [
        source.sourceId,
        source.output,
      ])
    );
    const hydrate = (list) =>
      list.map((source) => {
        if (!payloads.has(source.sourceId)) throw invalid();
        const output = payloads.get(source.sourceId);
        payloads.delete(source.sourceId);
        return { ...source, output };
      });
    const { sourceVersion, ...metadata } = reference.metadata;
    const root = {
      ...metadata,
      version: sourceVersion,
      kind: 'recovery-root',
      ledger: {
        ...metadata.ledger,
        kind: 'evidence-ledger',
        sources: hydrate(metadata.ledger.sources),
      },
    };
    const staged = hydrate(reference.stagedSources);
    if (payloads.size) throw invalid();
    const codec = require('./context-recovery-root-checkpoint');
    return codec.parseRootCheckpoint(
      codec.createRootCheckpoint(root, staged, reference.publications),
      root
    );
  } catch {
    throw invalid();
  }
}

module.exports = {
  parseReferenceState,
  parseReaderReferenceState,
  createReferenceState,
  referenceStateFromCheckpoint,
  validateReferenceTransition,
  parseReferenceTransition,
  validateReferenceAgainstCurrent,
  hydrateReferenceState,
};
