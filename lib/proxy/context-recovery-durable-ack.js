'use strict';

const { parseReferenceState } = require('./context-recovery-reference-state');
const { validateRecoveryRootMetadata } = require('./context-recovery-root-state');
const { fingerprintContextData } = require('./context-recovery-fingerprint');

const receipts = new WeakMap();
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
const sources = (state) => [...state.metadata.ledger.sources, ...state.stagedSources];
function invalid() {
  return Object.assign(new Error('context_recovery_durable_ack_invalid'), {
    code: 'context_recovery_durable_ack_invalid',
  });
}

// Trusted storage service only, after its validated CAS acknowledgement. This
// opaque token has no serializable data and cannot be supplied by a model/tool.
function createRecoveryDurableAck(input, revision) {
  try {
    if (!Number.isSafeInteger(revision) || revision < 1) throw invalid();
    const reference = parseReferenceState(input);
    const token = Object.freeze({});
    receipts.set(token, {
      identity: identity.map((key) => reference.metadata[key]),
      policy: fingerprintContextData(reference.metadata.ledger.policy),
      sources: sources(reference).map((source) => immutable.map((key) => source[key])),
    });
    return token;
  } catch {
    throw invalid();
  }
}

// The current owner must separately check its lease and session capability.
// Older ACKs can release only their unchanged sources, never newly captured
// bytes. Check the whole batch before returning any IDs to the eviction owner.
function acknowledgedRecoverySources(token, input) {
  try {
    const receipt = receipts.get(token);
    if (!receipt) throw invalid();
    const current = validateRecoveryRootMetadata(input);
    if (
      identity.some((key, index) => current.metadata[key] !== receipt.identity[index]) ||
      fingerprintContextData(current.metadata.ledger.policy) !== receipt.policy
    )
      throw invalid();
    const indexed = new Map(sources(current).map((source) => [source.sourceId, source]));
    for (const values of receipt.sources) {
      const source = indexed.get(values[0]);
      if (!source || immutable.some((key, index) => source[key] !== values[index])) throw invalid();
    }
    return receipt.sources.map((values) => values[0]);
  } catch {
    throw invalid();
  }
}

module.exports = { createRecoveryDurableAck, acknowledgedRecoverySources };
