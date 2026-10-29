'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeEvidenceLedgerEnvelope } = require('./context-evidence-payload-envelope');
const { createEvidencePayloadVerifier } = require('./context-evidence-payload-verifier');
const { normalizeOwnedRecoveryLedger } = require('./context-recovery-ledger-admission');

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const identity = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
function ledgerStateFailure() {
  return Object.assign(new TypeError('invalid_evidence_ledger_state'), {
    code: 'invalid_evidence_ledger_state',
  });
}
function exact(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== fields
  )
    throw ledgerStateFailure();
}
function evidenceLedgerPolicy(limits) {
  return {
    ttlMs: limits.ttlMs,
    maxEntries: limits.maxEntries,
    maxOutputBytes: limits.maxOutputBytes,
    maxBytes: limits.maxBytes,
  };
}

// Only the trusted owner calls this after authenticating an encrypted root.
// Data hashes check integrity/association, never confer restore authorization.
function parseLedger(input, ownerBinding, limits, metadata, proof) {
  try {
    const state = metadata
      ? normalizeCompactionData(input, 256 * 1024)
      : proof !== undefined
        ? normalizeOwnedRecoveryLedger(input, proof, limits)
        : normalizeEvidenceLedgerEnvelope(
            input,
            limits.maxOutputBytes,
            limits.maxEntries,
            limits.maxBytes > 8 * 1024 * 1024 ? 112 * 1024 * 1024 : 12 * 1024 * 1024
          );
    exact(state, 'capturedCount,kind,observedAt,ownerBinding,policy,readCount,sources,version');
    exact(state.policy, 'maxBytes,maxEntries,maxOutputBytes,ttlMs');
    if (
      state.version !== 1 ||
      state.kind !== (metadata ? 'evidence-ledger-metadata' : 'evidence-ledger') ||
      state.ownerBinding !== ownerBinding ||
      Object.entries(evidenceLedgerPolicy(limits)).some(
        ([name, value]) => state.policy[name] !== value
      ) ||
      !integer(state.observedAt) ||
      state.observedAt > Number.MAX_SAFE_INTEGER - limits.ttlMs ||
      !integer(state.capturedCount) ||
      !integer(state.readCount) ||
      (state.capturedCount === 0 && state.readCount !== 0) ||
      !Array.isArray(state.sources) ||
      state.sources.length > limits.maxEntries ||
      state.capturedCount < state.sources.length
    )
      throw ledgerStateFailure();
    const ids = new Set(),
      calls = new Set();
    const verifyPayload = metadata ? null : createEvidencePayloadVerifier();
    let bytes = 0,
      previous = 0,
      readSources = 0;
    for (const source of state.sources) {
      exact(
        source,
        metadata
          ? 'argumentsDigest,bytes,callId,coveredThrough,createdAt,digest,expiresAt,readComplete,sourceId,toolName'
          : 'argumentsDigest,bytes,callId,coveredThrough,createdAt,digest,expiresAt,output,readComplete,sourceId,toolName'
      );
      if (
        typeof source.sourceId !== 'string' ||
        !/^hce_[a-f0-9]{32}$/.test(source.sourceId) ||
        !identity(source.callId, 256) ||
        !identity(source.toolName, 128) ||
        typeof source.argumentsDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(source.argumentsDigest) ||
        typeof source.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(source.digest) ||
        (!metadata && typeof source.output !== 'string') ||
        !integer(source.bytes) ||
        source.bytes > limits.maxOutputBytes ||
        !integer(source.createdAt) ||
        source.createdAt < previous ||
        source.createdAt > state.observedAt ||
        !integer(source.expiresAt) ||
        source.expiresAt !== source.createdAt + limits.ttlMs ||
        source.expiresAt <= state.observedAt ||
        !integer(source.coveredThrough) ||
        source.coveredThrough > source.bytes ||
        typeof source.readComplete !== 'boolean' ||
        (source.readComplete && source.coveredThrough !== source.bytes) ||
        (source.bytes > 0 && source.readComplete !== (source.coveredThrough === source.bytes)) ||
        ids.has(source.sourceId) ||
        calls.has(source.callId)
      )
        throw ledgerStateFailure();
      if (
        !metadata &&
        !verifyPayload(source.output, source.bytes, source.digest, source.coveredThrough)
      )
        throw ledgerStateFailure();
      if (source.coveredThrough > 0 || source.readComplete) readSources++;
      bytes += source.bytes;
      if (bytes > limits.maxBytes) throw ledgerStateFailure();
      previous = source.createdAt;
      ids.add(source.sourceId);
      calls.add(source.callId);
    }
    if (state.readCount < readSources) throw ledgerStateFailure();
    return state;
  } catch {
    throw ledgerStateFailure();
  }
}

function parseEvidenceLedgerState(input, ownerBinding, limits) {
  return parseLedger(input, ownerBinding, limits, false);
}

// Internal full-root route only. A proof must authenticate this exact isolated
// clone's structure; all ordinary ledger semantics above remain mandatory.
function parseOwnedEvidenceLedgerState(input, ownerBinding, limits, proof) {
  if (proof === undefined) throw ledgerStateFailure();
  return parseLedger(input, ownerBinding, limits, false, proof);
}

// Metadata is an association/accounting index, never proof of payload bytes or
// UTF-8 offsets. Those remain checked when a stored page/full state is read.
// A distinct kind and exact fields prevent using it as a legacy restore token.
function parseEvidenceLedgerMetadata(input, ownerBinding, limits) {
  return parseLedger(input, ownerBinding, limits, true);
}

module.exports = {
  evidenceLedgerPolicy,
  ledgerStateFailure,
  parseEvidenceLedgerState,
  parseOwnedEvidenceLedgerState,
  parseEvidenceLedgerMetadata,
};
