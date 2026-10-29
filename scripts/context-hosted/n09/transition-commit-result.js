'use strict';
const { fields } = require('../n09-ack/contract');
const { data } = require('../n09-ipc/driver-boundary');
const { publicationTransitionRoute } = require('../n09-business/publication-transition-route');
const fail = () => new Error('n09_transition_commit_result_rejected');
const resultKeys = Object.freeze([
  'evidenceLevel',
  'boundary',
  'forcedKill',
  'actualTargetWritePending',
  'readAdmissionBlocked',
  'predecessorAckObserved',
  'preparedPredecessorAckObserved',
  'sendingPredecessorAckObserved',
  'publicTransportCompletedBeforeBoundary',
  'cancellationBeforeBoundary',
  'clientTransportClosedBeforeBoundary',
  'interruptedWithZeroPublicBytes',
  'positivePublicCompletion',
  'cleanupCompletionObserved',
  'publicationCompletionObserved',
  'opaqueTargetAckNotDeliveredAtKill',
  'sameDirectoryNewPid',
  'originalReadAfterRestart',
  'originalExpiryPreserved',
  'n09Complete',
]);
function transitionCommitClosedReceipt(input, group) {
  try {
    if (
      !['sending-commit', 'finished-commit', 'withdrawn-commit', 'uncertain-commit'].includes(group)
    )
      throw fail();
    const name = group.slice(0, -7),
      transition = name === 'finished' ? 'transport-finished' : name;
    const route = publicationTransitionRoute(transition),
      killName = name + 'CommitKill',
      releaseName = name + 'CommitRelease';
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
    for (const [key, kill] of [
      [killName, true],
      [releaseName, false],
    ]) {
      const result = fields(value[key], resultKeys),
        observed = data(evidence[key]);
      if (
        result.evidenceLevel !== 'adapter-orchestration-only' ||
        result.boundary !== transition + '-save-reference-state-commit-pending' ||
        result.forcedKill !== kill ||
        result.actualTargetWritePending !== true ||
        result.readAdmissionBlocked !== true ||
        result.predecessorAckObserved !== true ||
        result.preparedPredecessorAckObserved !== true ||
        result.sendingPredecessorAckObserved !== (route.delta === 3) ||
        result.publicTransportCompletedBeforeBoundary !== route.publicTransportCompleted ||
        result.cancellationBeforeBoundary !== route.cancellation ||
        result.clientTransportClosedBeforeBoundary !== route.cancellation ||
        result.interruptedWithZeroPublicBytes !==
          (kill && !route.cancellation && !route.publicTransportCompleted) ||
        result.positivePublicCompletion !== (!kill && !route.cancellation) ||
        result.cleanupCompletionObserved !== (!kill && route.cancellation) ||
        result.publicationCompletionObserved !== (!kill && !route.cancellation) ||
        result.opaqueTargetAckNotDeliveredAtKill !== kill ||
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
      phase: 'n09_' + group.replace('-', '_') + '_scenario_closed',
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
module.exports = { transitionCommitClosedReceipt };
