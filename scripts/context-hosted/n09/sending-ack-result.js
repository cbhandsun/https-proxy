'use strict';
const { fields } = require('../n09-ack/contract');
const { data } = require('../n09-ipc/driver-boundary');
const fail = () => new Error('n09_sending_ack_result_rejected');

// Only the pinned child composition calls this. A flat receipt is a bounded
// diagnostic result, never a replacement for the parent's owned-Job capability.
function publicationAckClosedReceipt(input, finished) {
  const killName = finished ? 'finishedAckKill' : 'sendingAckKill';
  const releaseName = finished ? 'finishedAckRelease' : 'sendingAckRelease';
  try {
    const value = fields(input, [
      killName,
      releaseName,
      'businessEvidence',
      'networkProof',
      'originalControllerReused',
      'tlsValidationDisabled',
      'remoteModelRequests',
      'n09Complete',
      'cleanup',
    ]);
    const network = data(value.networkProof),
      cleanup = data(value.cleanup);
    if (
      value.originalControllerReused !== true ||
      value.tlsValidationDisabled !== false ||
      value.remoteModelRequests !== 0 ||
      value.n09Complete !== false ||
      ['probesPassed', 'tlsVerified', 'nonLoopbackBlocked', 'listenerOwned'].some(
        (key) => network[key] !== true
      ) ||
      cleanup.adaptersClosed !== 2 ||
      cleanup.listenerClosed !== true
    )
      throw fail();
    const evidence = fields(value.businessEvidence, [killName, releaseName]);
    for (const [name, kill] of [
      [killName, true],
      [releaseName, false],
    ]) {
      const result = data(value[name]),
        observed = data(evidence[name]);
      if (
        result.evidenceLevel !== 'adapter-orchestration-only' ||
        result.boundary !==
          (finished ? 'transport-finished' : 'sending') + '-durable-store-before-host-ack' ||
        result.forcedKill !== kill ||
        result.interruptedWithZeroPublicBytes !== (kill && !finished) ||
        result.positivePublicCompletion !== !kill ||
        result.actualDurableStoreObserved !== true ||
        result.preAckBoundaryObserved !== true ||
        result.preparedPredecessorAckObserved !== true ||
        (finished &&
          (result.sendingPredecessorAckObserved !== true ||
            result.publicTransportCompletedBeforeBoundary !== true ||
            result.publicationCompletionObserved !== !kill)) ||
        result.opaqueAckNotDeliveredAtKill !== kill ||
        result.sameDirectoryNewPid !== true ||
        result.originalReadAfterRestart !== true ||
        result.originalExpiryPreserved !== true ||
        result.n09Complete !== false ||
        observed.seeded !== true ||
        observed.validatedReadCount !== 3 ||
        observed.publicGenerationCount !== 3 ||
        observed.externalToolExecutions !== 1 ||
        observed.clearAckCount !== 0 ||
        observed.saveAckCount !== 0 ||
        observed.revokeAckCount !== 0
      )
        throw fail();
    }
    return Object.freeze({
      schemaVersion: 1,
      phase: finished ? 'n09_finished_ack_scenario_closed' : 'n09_sending_ack_scenario_closed',
      probesPassed: true,
      tlsVerified: true,
      nonLoopbackBlocked: true,
      listenerOwned: true,
      syntheticSocketsClosed: true,
      cases: 2,
      n09Complete: false,
    });
  } catch {
    throw fail();
  }
}
const sendingAckClosedReceipt = (input) => publicationAckClosedReceipt(input, false);
const finishedAckClosedReceipt = (input) => publicationAckClosedReceipt(input, true);
module.exports = { sendingAckClosedReceipt, finishedAckClosedReceipt };
