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
const fail = () => new Error('n09_publication_commit_driver_failed');
// Both cases use fresh daemons under the original owned Job. The pure driver
// does not confer native/daemon qualification; the fixed hosted entry does I/O.
async function runPreparedPublicationCommit(adapter, kill) {
  let active,
    result,
    failed = false;
  try {
    if (typeof kill !== 'boolean') throw fail();
    active = identity(await invoke(adapter, 'startFreshBusinessHost'));
    const original = baseline(await invoke(adapter, 'seedThroughBusinessHttp', active));
    const before = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (before.exactRead !== true || before.externalToolReplays !== 0) throw fail();
    accounting(original, before.accounting);
    const held = data(await invoke(adapter, 'beginPreparedCommitHold', active));
    const checkpoint = data(held.accounting);
    accounting(original, checkpoint);
    if (
      held.pid !== active.pid ||
      held.publicResponseHeld !== true ||
      held.publicBytes !== 0 ||
      held.exactRead !== true ||
      held.externalToolReplays !== 0 ||
      held.readerHeld !== true ||
      !Number.isSafeInteger(checkpoint.revision) ||
      checkpoint.revision < 1
    )
      throw fail();
    const released = data(invoke(adapter, 'releasePublicResponseForCommit', active));
    if (released.upstreamReleased !== true || released.publicBytes !== 0) throw fail();
    const pending = data(await invoke(adapter, 'waitPreparedCommitPending', active));
    if (
      pending.boundary !== 'prepared-save-reference-state-commit-pending' ||
      pending.pid !== active.pid ||
      pending.publicBytes !== 0 ||
      pending.readAdmissionBlocked !== true ||
      pending.actualPreparedWritePending !== true ||
      pending.expectedRevision !== checkpoint.revision
    )
      throw fail();
    let durable = checkpoint;
    if (kill) {
      const first = active;
      // Nothing may run between the qualified pending boundary and forced kill.
      await forceKill(adapter, first);
      active = undefined;
      const interrupted = data(await invoke(adapter, 'finishInterruptedPublicResponse', first));
      if (interrupted.interrupted !== true || interrupted.publicBytes !== 0) throw fail();
      const release = data(invoke(adapter, 'releasePreparedCommitWitness', first));
      if (release.released !== true) throw fail();
      // The genuine default owner must recover the hot journal before any
      // readonly metadata reader is allowed to inspect the stopped database.
      active = identity(await invoke(adapter, 'restartSameBusinessHost', first));
      sameDirectory(first, active);
      const recovered = data(invoke(adapter, 'readCommittedSnapshot', active));
      if (
        recovered.present !== true ||
        recovered.revision !== checkpoint.revision ||
        recovered.calls !== checkpoint.calls ||
        recovered.returnedBytes !== checkpoint.returnedBytes ||
        recovered.rootId !== checkpoint.rootId ||
        recovered.expiresAt !== checkpoint.expiresAt
      )
        throw fail();
    } else {
      const release = data(invoke(adapter, 'releasePreparedCommitWitness', active));
      if (release.released !== true) throw fail();
      const completed = data(await invoke(adapter, 'finishReleasedPublicResponse', active));
      if (completed.publicCompleted !== true) throw fail();
      durable = data(completed.accounting);
      accounting(baseline(checkpoint), durable);
      if (!Number.isSafeInteger(durable.revision) || durable.revision <= checkpoint.revision)
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
      boundary: 'prepared-save-reference-state-commit-pending',
      forcedKill: kill,
      interruptedWithZeroPublicBytes: kill,
      positivePublicCompletion: !kill,
      actualPreparedWritePending: true,
      readAdmissionBlocked: true,
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
module.exports = { runPreparedPublicationCommit };
