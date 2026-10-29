'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { fingerprintNormalizedValue } = require('./context-recovery-fingerprint-value');
const {
  normalizeRecoveryCheckpointData,
  normalizeRecoveryReferenceData,
} = require('./context-recovery-state-data');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');

// Equality only. Validation precedes traversal, so accessors, coercion and
// toJSON cannot participate. Array order and every validated field are retained.
function fingerprint(input, maximum) {
  const value = normalizeCompactionData(input, maximum);
  return fingerprintNormalizedValue(value);
}

function fingerprintContextData(input) {
  return fingerprint(input, 2 * 1024 * 1024);
}

// Explicit storage capability. Do not widen request/policy equality admission,
// or add a second argument that Array.map callers could accidentally supply.
function fingerprintRecoveryCheckpoint(input) {
  return fingerprintNormalizedValue(normalizeRecoveryCheckpointData(input));
}

function fingerprintRecoveryReference(input) {
  return fingerprintNormalizedValue(normalizeRecoveryReferenceData(input));
}

function fingerprintRecoveryHistory(history, format = 2) {
  return fingerprintNormalizedValue(
    normalizeRecoveryRequestBody('responses', { input: history }, format).input
  );
}

module.exports = {
  fingerprintContextData,
  fingerprintRecoveryCheckpoint,
  fingerprintRecoveryReference,
  fingerprintRecoveryHistory,
};
