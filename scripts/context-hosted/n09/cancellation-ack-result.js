'use strict';
const { fields } = require('../n09-ack/contract');
const { data } = require('../n09-ipc/driver-boundary');
const fail = () => new Error('n09_cancellation_ack_result_rejected');

// A closed synthetic case receipt only. The parent must still verify the
// original owned Job and network teardown; this never grants full acceptance.
function cancellationAckClosedReceipt(input, group) {
  try {
    if (!['withdrawn-ack', 'uncertain-ack'].includes(group)) throw fail();
    const uncertain = group === 'uncertain-ack',
      transition = uncertain ? 'uncertain' : 'withdrawn',
      prefix = uncertain ? 'uncertainAck' : 'withdrawnAck',
      killName = prefix + 'Kill',
      releaseName = prefix + 'Release';
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
        result.boundary !== transition + '-durable-store-before-host-ack' ||
        result.forcedKill !== kill ||
        result.interruptedWithZeroPublicBytes !== false ||
        result.positivePublicCompletion !== false ||
        result.actualDurableStoreObserved !== true ||
        result.preAckBoundaryObserved !== true ||
        result.preparedPredecessorAckObserved !== true ||
        result.sendingPredecessorAckObserved !== uncertain ||
        result.publicTransportCompletedBeforeBoundary !== false ||
        result.publicationCompletionObserved !== false ||
        result.cancellationBeforeTerminalAckObserved !== true ||
        result.clientTransportClosedBeforeBoundary !== true ||
        result.publicationCleanupObserved !== !kill ||
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
      phase: uncertain ? 'n09_uncertain_ack_scenario_closed' : 'n09_withdrawn_ack_scenario_closed',
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
module.exports = { cancellationAckClosedReceipt };
