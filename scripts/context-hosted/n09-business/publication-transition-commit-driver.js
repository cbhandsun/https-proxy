'use strict';
const {
  data,
  invoke,
  identity,
  baseline,
  sameDirectory,
  accounting,
  forceKill,
} = require('../n09-ipc/driver-boundary');
const { publicationTransitionRoute } = require('./publication-transition-route');
const fail = () => new Error('n09_transition_commit_driver_failed');
async function runTransitionPublicationCommit(adapter, kill, transition) {
  let active,
    result,
    failed = false;
  try {
    if (
      typeof kill !== 'boolean' ||
      !['sending', 'transport-finished', 'withdrawn', 'uncertain'].includes(transition)
    )
      throw fail();
    const route = publicationTransitionRoute(transition);
    active = identity(await invoke(adapter, 'startFreshBusinessHost'));
    const original = baseline(await invoke(adapter, 'seedThroughBusinessHttp', active));
    const before = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (before.exactRead !== true || before.externalToolReplays !== 0) throw fail();
    accounting(original, before.accounting);
    const held = data(await invoke(adapter, 'beginTransitionCommitHold', active, transition));
    const checkpoint = data(held.accounting);
    accounting(original, checkpoint);
    if (
      held.pid !== active.pid ||
      held.publicResponseHeld !== true ||
      held.publicBytes !== 0 ||
      held.exactRead !== true ||
      held.externalToolReplays !== 0 ||
      held.prefixArmed !== true ||
      held.ackArmed !== true
    )
      throw fail();
    const released = data(invoke(adapter, 'releasePublicResponseForAck', active));
    if (released.upstreamReleased !== true || released.publicBytes !== 0) throw fail();
    const pending = data(await invoke(adapter, 'waitTransitionCommitPending', active));
    const predecessor = data(pending.accounting);
    accounting(baseline(checkpoint), predecessor);
    if (
      pending.boundary !== transition + '-save-reference-state-commit-pending' ||
      pending.pid !== active.pid ||
      pending.actualTransitionWritePending !== true ||
      pending.transition !== transition ||
      pending.actualPreparedWritePending !== false ||
      pending.readAdmissionBlocked !== true ||
      pending.predecessorAckObserved !== true ||
      pending.targetAckDelivered !== false ||
      pending.publicTransportCompleted !== route.publicTransportCompleted ||
      pending.clientCancelled !== route.cancellation ||
      pending.clientTransportClosed !== route.cancellation ||
      pending.expectedRevision !== checkpoint.revision + route.delta - 1 ||
      predecessor.revision !== pending.expectedRevision ||
      predecessor.calls !== checkpoint.calls ||
      predecessor.returnedBytes !== checkpoint.returnedBytes ||
      (route.publicTransportCompleted
        ? !Number.isSafeInteger(pending.publicBytes) ||
          pending.publicBytes < 1 ||
          pending.publicBytes > 262144
        : pending.publicBytes !== 0)
    )
      throw fail();
    let durable = predecessor;
    if (kill) {
      const first = active;
      // No I/O between the qualified pending write and forced interruption.
      await forceKill(adapter, first);
      active = undefined;
      const interrupted = data(await invoke(adapter, 'finishInterruptedPublicResponse', first));
      if (
        route.cancellation
          ? interrupted.clientCancelled !== true ||
            interrupted.clientTransportClosed !== true ||
            interrupted.publicBytes !== 0
          : route.publicTransportCompleted
            ? interrupted.publicTransportCompleted !== true ||
              interrupted.publicBytes !== pending.publicBytes
            : interrupted.interrupted !== true || interrupted.publicBytes !== 0
      )
        throw fail();
      const release = data(invoke(adapter, 'releasePreparedCommitWitness', first));
      if (release.released !== true) throw fail();
      active = identity(await invoke(adapter, 'restartSameBusinessHost', first));
      sameDirectory(first, active);
      const recovered = data(invoke(adapter, 'readCommittedSnapshot', active));
      if (
        recovered.present !== true ||
        ['rootId', 'expiresAt', 'revision', 'calls', 'returnedBytes'].some(
          (key) => recovered[key] !== predecessor[key]
        )
      )
        throw fail();
    } else {
      const release = data(invoke(adapter, 'releasePreparedCommitWitness', active));
      if (release.released !== true) throw fail();
      const completed = data(await invoke(adapter, 'finishReleasedTransitionCommit', active));
      if (
        route.cancellation
          ? completed.cancelled !== true ||
            completed.cleanupFinished !== true ||
            completed.clientTransportClosed !== true ||
            completed.publicBytes !== 0
          : completed.publicCompleted !== true
      )
        throw fail();
      durable = data(completed.accounting);
      accounting(baseline(predecessor), durable);
      if (
        !Number.isSafeInteger(durable.revision) ||
        durable.revision < checkpoint.revision + route.delta ||
        durable.calls !== checkpoint.calls ||
        durable.returnedBytes !== checkpoint.returnedBytes
      )
        throw fail();
      const first = active;
      await forceKill(adapter, first);
      active = undefined;
      active = identity(await invoke(adapter, 'restartSameBusinessHost', first));
      sameDirectory(first, active);
    }
    const after = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (after.exactRead !== true || after.externalToolReplays !== 0) throw fail();
    accounting(baseline(durable), after.accounting);
    if (
      !Number.isSafeInteger(after.accounting.revision) ||
      after.accounting.revision < durable.revision
    )
      throw fail();
    result = Object.freeze({
      evidenceLevel: 'adapter-orchestration-only',
      boundary: transition + '-save-reference-state-commit-pending',
      forcedKill: kill,
      actualTargetWritePending: true,
      readAdmissionBlocked: true,
      predecessorAckObserved: true,
      preparedPredecessorAckObserved: true,
      sendingPredecessorAckObserved: route.delta === 3,
      publicTransportCompletedBeforeBoundary: route.publicTransportCompleted,
      cancellationBeforeBoundary: route.cancellation,
      clientTransportClosedBeforeBoundary: route.cancellation,
      interruptedWithZeroPublicBytes:
        kill && !route.publicTransportCompleted && !route.cancellation,
      positivePublicCompletion: !kill && !route.cancellation,
      cleanupCompletionObserved: !kill && route.cancellation,
      publicationCompletionObserved: !kill && !route.cancellation,
      opaqueTargetAckNotDeliveredAtKill: kill,
      sameDirectoryNewPid: true,
      originalReadAfterRestart: true,
      originalExpiryPreserved: true,
      n09Complete: false,
    });
  } catch {
    failed = true;
  } finally {
    if (active) {
      try {
        await forceKill(adapter, active);
      } catch {
        failed = true;
      }
    }
    try {
      await invoke(adapter, 'close');
    } catch {
      failed = true;
    }
  }
  if (failed) throw fail();
  return result;
}
module.exports = { runTransitionPublicationCommit };
