'use strict';

const { createHash } = require('node:crypto');
const { parseAnchorSnapshot } = require('./context-recovery-anchor-contract');
const { storageFailure } = require('./context-recovery-storage-contract');

// Fixed independent domain; parser supplies canonical field and scope order.
const DOMAIN = 'hpm.context.recovery.anchor.legacy-enrollment.v1\0';

function fingerprint(snapshot) {
  return createHash('sha256').update(DOMAIN).update(JSON.stringify(snapshot)).digest('hex');
}

// Metadata review only: this does not authenticate a database. The trusted
// offline owner must hold the lifetime OS writer lock during review and use.
function recoveryLegacyEnrollmentPreview(fullAnchorSnapshot) {
  try {
    const snapshot = parseAnchorSnapshot(fullAnchorSnapshot);
    return Object.freeze({
      fingerprint: fingerprint(snapshot),
      storeId: snapshot.storeId,
      scopeCount: snapshot.scopes.length,
      maxTime: snapshot.maxTime,
    });
  } catch {
    throw storageFailure();
  }
}

// A trusted offline composition supplies this explicit approval fingerprint.
// Never interpret this as automatic enrollment or a public/worker capability.
function assertLegacyEnrollment(fullAnchorSnapshot, expectedFingerprint) {
  try {
    if (
      typeof expectedFingerprint !== 'string' ||
      expectedFingerprint.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(expectedFingerprint)
    )
      throw storageFailure();
    const snapshot = parseAnchorSnapshot(fullAnchorSnapshot);
    if (fingerprint(snapshot) !== expectedFingerprint) throw storageFailure();
    return snapshot;
  } catch {
    throw storageFailure();
  }
}

module.exports = { recoveryLegacyEnrollmentPreview, assertLegacyEnrollment };
