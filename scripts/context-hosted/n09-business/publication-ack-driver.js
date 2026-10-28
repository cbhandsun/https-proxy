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
const fail = () => new Error('n09_publication_ack_driver_failed');
// Both cases use fresh daemons under the original owned Job. The pure driver
// does not confer native/daemon qualification; the fixed hosted entry does I/O.
async function runPreparedPublicationAck(adapter, kill, transition = 'prepared') {
  let active,
    result,
    failed = false;
  try {
    if (
      typeof kill !== 'boolean' ||
      !['prepared', 'sending', 'transport-finished'].includes(transition)
    )
      throw fail();
    const delta = ['prepared', 'sending', 'transport-finished'].indexOf(transition) + 1;
    active = identity(await invoke(adapter, 'startFreshBusinessHost'));
    const original = baseline(await invoke(adapter, 'seedThroughBusinessHttp', active));
    const before = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (before.exactRead !== true || before.externalToolReplays !== 0) throw fail();
    accounting(original, before.accounting);
    const held = data(await invoke(adapter, 'beginPreparedAckHold', active, transition));
    const checkpoint = data(held.accounting);
    accounting(original, checkpoint);
    if (
      held.pid !== active.pid ||
      held.publicResponseHeld !== true ||
      held.publicBytes !== 0 ||
      held.exactRead !== true ||
      held.externalToolReplays !== 0 ||
      held.ackArmed !== true ||
      !Number.isSafeInteger(checkpoint.revision) ||
      checkpoint.revision < 1
    )
      throw fail();
    const released = data(invoke(adapter, 'releasePublicResponseForAck', active));
    if (released.upstreamReleased !== true || released.publicBytes !== 0) throw fail();
    const pending = data(await invoke(adapter, 'waitPreparedAckHeld', active));
    if (
      pending.boundary !== transition + '-durable-store-before-host-ack' ||
      pending.pid !== active.pid ||
      (delta === 3
        ? !Number.isSafeInteger(pending.publicBytes) ||
          pending.publicBytes < 1 ||
          pending.publicBytes > 262144
        : pending.publicBytes !== 0) ||
      pending.publicTransportCompleted !== (delta === 3) ||
      pending.hostAckDelivered !== false ||
      pending.durableStoreObserved !== true ||
      pending.revision !== checkpoint.revision + delta ||
      pending.expectedRevision !== checkpoint.revision + delta - 1
    )
      throw fail();
    let durable = data(pending.accounting);
    accounting(baseline(checkpoint), durable);
    if (
      durable.revision !== checkpoint.revision + delta ||
      durable.calls !== checkpoint.calls ||
      durable.returnedBytes !== checkpoint.returnedBytes
    )
      throw fail();
    if (kill) {
      const first = active;
      // Nothing may run between the qualified pre-ACK boundary and forced kill.
      await forceKill(adapter, first);
      active = undefined;
      const interrupted = data(await invoke(adapter, 'finishInterruptedPublicResponse', first));
      if (
        delta === 3
          ? interrupted.publicTransportCompleted !== true ||
            interrupted.publicBytes !== pending.publicBytes
          : interrupted.interrupted !== true || interrupted.publicBytes !== 0
      )
        throw fail();
      // Reopen through the genuine default owner before inspecting metadata.
      // The durable prepared revision must survive even though no ACK escaped.
      active = identity(await invoke(adapter, 'restartSameBusinessHost', first));
      sameDirectory(first, active);
      const recovered = data(invoke(adapter, 'readCommittedSnapshot', active));
      if (
        recovered.present !== true ||
        recovered.revision !== checkpoint.revision + delta ||
        recovered.calls !== checkpoint.calls ||
        recovered.returnedBytes !== checkpoint.returnedBytes ||
        recovered.rootId !== checkpoint.rootId ||
        recovered.expiresAt !== checkpoint.expiresAt
      )
        throw fail();
    } else {
      const release = data(await invoke(adapter, 'releasePreparedAck', active));
      if (release.released !== true) throw fail();
      const completed = data(await invoke(adapter, 'finishReleasedPublicResponse', active));
      if (completed.publicCompleted !== true) throw fail();
      durable = data(completed.accounting);
      accounting(baseline(checkpoint), durable);
      if (!Number.isSafeInteger(durable.revision) || durable.revision < checkpoint.revision + delta)
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
    const finalRevision = data(after.accounting).revision;
    if (!Number.isSafeInteger(finalRevision) || finalRevision < durable.revision) throw fail();
    result = Object.freeze({
      evidenceLevel: 'adapter-orchestration-only',
      boundary: transition + '-durable-store-before-host-ack',
      forcedKill: kill,
      interruptedWithZeroPublicBytes: kill && delta !== 3,
      positivePublicCompletion: !kill,
      actualDurableStoreObserved: true,
      preAckBoundaryObserved: true,
      preparedPredecessorAckObserved: delta >= 2,
      sendingPredecessorAckObserved: delta === 3,
      publicTransportCompletedBeforeBoundary: delta === 3,
      publicationCompletionObserved: !kill,
      opaqueAckNotDeliveredAtKill: kill,
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
module.exports = { runPreparedPublicationAck };
