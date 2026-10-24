'use strict';
const { createClearClient } = require('./clear-client.js');
const path = require('node:path');
const { types } = require('node:util');
const fail = () => new Error('n09_ack_kill_failed');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function data(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value')) throw fail();
    result[key] = field.value;
  }
  return result;
}
function directory(value) {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    path.isAbsolute(value) &&
    !/^[\\/]{2}/.test(value) &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) &&
    !value.split(/[\\/]/).some((part) => part === '.' || part === '..')
  );
}
const invoke = (object, name, ...args) => {
  if (!object || typeof object !== 'object' || types.isProxy(object)) throw fail();
  const slot = object && Object.getOwnPropertyDescriptor(object, name);
  if (typeof slot?.value !== 'function' || types.isProxy(slot.value)) throw fail();
  return Reflect.apply(slot.value, undefined, args);
};
function identity(value) {
  value = data(value);
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !digest(value.manifestSha256) ||
    !directory(value.configDir) ||
    !directory(value.runtimeDir) ||
    value.configDir === value.runtimeDir ||
    value.isolatedLoopbackSynthetic !== true ||
    value.actualBusinessHost !== true
  )
    throw fail();
  return Object.freeze({
    pid: value.pid,
    manifestSha256: value.manifestSha256,
    configDir: value.configDir,
    runtimeDir: value.runtimeDir,
  });
}
function baseline(value) {
  value = data(value);
  if (
    !value ||
    !digest(value.originalSha256) ||
    !digest(value.authorizationSha256) ||
    typeof value.rootId !== 'string' ||
    !/^hbs_[a-f0-9]{32}$/.test(value.rootId) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0 ||
    !Number.isSafeInteger(value.calls) ||
    value.calls < 0 ||
    !Number.isSafeInteger(value.returnedBytes) ||
    value.returnedBytes < 0
  )
    throw fail();
  return Object.freeze({
    originalSha256: value.originalSha256,
    authorizationSha256: value.authorizationSha256,
    rootId: value.rootId,
    expiresAt: value.expiresAt,
    calls: value.calls,
    returnedBytes: value.returnedBytes,
  });
}
function sameDirectory(before, after) {
  if (
    before.pid === after.pid ||
    before.manifestSha256 !== after.manifestSha256 ||
    before.configDir !== after.configDir ||
    before.runtimeDir !== after.runtimeDir
  )
    throw fail();
}
function accounting(before, after) {
  after = data(after);
  if (
    !after ||
    after.originalSha256 !== before.originalSha256 ||
    after.authorizationSha256 !== before.authorizationSha256 ||
    after.rootId !== before.rootId ||
    after.expiresAt !== before.expiresAt ||
    !Number.isSafeInteger(after.calls) ||
    after.calls < before.calls ||
    !Number.isSafeInteger(after.returnedBytes) ||
    after.returnedBytes < before.returnedBytes
  )
    throw fail();
}
async function forceKill(adapter, owner) {
  const ack = data(await invoke(adapter, 'killOwnedJob', owner));
  if (
    !ack ||
    ack.pid !== owner.pid ||
    ack.treeEmpty !== true ||
    ack.shutdownInvoked !== false ||
    ack.semantics !== 'forced_cleanup'
  )
    throw fail();
}

// Driver shared by pure fixtures and the fixed hosted composition. Qualification
// flags remain bounded here; only the hosted composition performs real I/O.
async function runClearAfterAck(adapter) {
  let active;
  let failed;
  let result;
  try {
    active = identity(await invoke(adapter, 'startFreshBusinessHost'));
    const original = baseline(await invoke(adapter, 'seedThroughBusinessHttp', active));
    const before = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (before?.exactRead !== true) throw fail();
    accounting(original, before.accounting);
    const clear = invoke(adapter, 'getClearCapability', active);
    if (typeof clear !== 'function') throw fail();
    const ack = data(await Reflect.apply(clear, undefined, []));
    if (ack?.kind !== 'host-clear-completed' || ack.durableBoundary !== 'await-clearAsync')
      throw fail();
    const old = active;
    await forceKill(adapter, old);
    active = undefined;
    active = identity(await invoke(adapter, 'restartSameBusinessHost', old));
    sameDirectory(old, active);
    const denied = data(await invoke(adapter, 'readOldReceiptThroughBusinessHttp', active));
    if (
      denied?.oldReceiptDenied !== true ||
      denied.originalExposed !== false ||
      denied.externalToolReplays !== 0
    )
      throw fail();
    // 00/01/10/11 must not resurrect the old capability; ordinary HTTP may work.
    for (const combination of ['00', '01', '10', '11']) {
      await invoke(adapter, 'setCombinationThroughManagement', active, combination);
      const check = data(await invoke(adapter, 'readOldReceiptThroughBusinessHttp', active));
      if (
        check?.oldReceiptDenied !== true ||
        check.originalExposed !== false ||
        check.externalToolReplays !== 0
      )
        throw fail();
    }
    result = Object.freeze({
      scope: 'adapter_orchestration_clear_ack_then_forced_kill',
      evidenceLevel: 'adapter-orchestration-only',
      liveDaemonProved: false,
      hostClearBoundaryObserved: false,
      adapterClearBoundaryObserved: true,
      sameDirectoryNewPid: true,
      oldReceiptDeniedAfterToggle: true,
      n09Complete: false,
      saveAckKillQualified: false,
      revokeAckKillQualified: false,
      commitInProgressQualified: false,
      publicationInProgressQualified: false,
      installationQualified: false,
      backupRollbackQualified: false,
    });
  } catch {
    failed = fail();
  } finally {
    if (active) {
      try {
        await forceKill(adapter, active);
      } catch {
        failed = fail();
      }
    }
    // Independent finally path is required even when start/attest returned an
    // invalid identity, stop threw, or restart failed before returning a handle.
    try {
      await invoke(adapter, 'close');
    } catch {
      failed = fail();
    }
  }
  if (failed) throw failed;
  return result;
}

// Existing-ACK-dependent orchestration, distinct from committed-file observation.
// The hosted business adapter supplies a passive callable capability. A boolean
// advertisement still fails before seeding; pure adapters grant no live proof.
async function runDurableSaveOrRevokeAfterAck(adapter, operation) {
  if (!['save', 'revoke'].includes(operation)) throw fail();
  let capability;
  try {
    // Capability acquisition is passive and synchronous. Awaiting an unknown
    // return value would read an untrusted then getter before Proxy admission.
    capability = invoke(adapter, 'existingHostDurableAckCapability', operation);
  } catch {
    throw new Error('n09_host_durable_ack_unavailable');
  }
  if (capability === true) throw new Error('n09_save_revoke_host_wiring_not_implemented');
  if (typeof capability !== 'function' || types.isProxy(capability))
    throw new Error('n09_host_durable_ack_unavailable');
  let active, result;
  let failed = false;
  try {
    active = identity(await invoke(adapter, 'startFreshBusinessHost'));
    const original = baseline(await invoke(adapter, 'seedThroughBusinessHttp', active));
    const before = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (before.exactRead !== true || before.externalToolReplays !== 0) throw fail();
    accounting(original, before.accounting);
    const consumed = baseline(before.accounting);
    const ack = data(await Reflect.apply(capability, undefined, [active]));
    if (
      Object.keys(ack).sort().join(',') !== 'accounting,durableBoundary,kind,pid' ||
      ack.kind !== 'host-' + operation + '-completed' ||
      ack.durableBoundary !==
        (operation === 'save' ? 'await-reference-save' : 'await-revokeAsync') ||
      ack.pid !== active.pid
    )
      throw fail();
    accounting(consumed, ack.accounting);
    const acknowledged = baseline(ack.accounting);
    const old = active;
    // No further adapter I/O intervenes between ACK validation and forced kill.
    await forceKill(adapter, old);
    active = undefined;
    let stopped;
    if (operation === 'save') {
      // The killed process may have durably settled its read reservation before
      // termination. Observe only after kill; restart must preserve that exact
      // durable baseline rather than treating a reservation as consumed bytes.
      stopped = data(invoke(adapter, 'readCommittedSnapshotAfterKill', old));
      const ackRevision = ack.accounting.revision;
      if (
        stopped.present !== true ||
        stopped.evidenceLevel !== 'committed-metadata-only' ||
        stopped.hostDurableAck !== false ||
        !Number.isSafeInteger(ackRevision) ||
        ackRevision < 1 ||
        !Number.isSafeInteger(stopped.revision) ||
        stopped.revision < ackRevision
      )
        throw fail();
      accounting(consumed, { ...consumed, ...stopped });
      if (stopped.calls < acknowledged.calls) throw fail();
      // One durable settlement can refund at most one 16 KiB reservation.
      // A revision equal to the signed ACK cannot contain any counter change.
      const revisionGap = stopped.revision - ackRevision;
      if (
        stopped.returnedBytes < Math.max(0, acknowledged.returnedBytes - revisionGap * 16384) ||
        (revisionGap === 0 &&
          (stopped.calls !== acknowledged.calls ||
            stopped.returnedBytes !== acknowledged.returnedBytes))
      )
        throw fail();
    }
    active = identity(await invoke(adapter, 'restartSameBusinessHost', old));
    sameDirectory(old, active);
    if (operation === 'save') {
      const read = data(await invoke(adapter, 'readThroughBusinessHttp', active));
      if (read.exactRead !== true || read.externalToolReplays !== 0) throw fail();
      accounting({ ...acknowledged, returnedBytes: stopped.returnedBytes }, read.accounting);
      if (
        read.accounting.calls < stopped.calls ||
        !Number.isSafeInteger(read.accounting.revision) ||
        read.accounting.revision < stopped.revision
      )
        throw fail();
    } else {
      const denied = async () => {
        const value = data(await invoke(adapter, 'readOldReceiptThroughBusinessHttp', active));
        if (
          value.oldReceiptDenied !== true ||
          value.originalExposed !== false ||
          value.externalToolReplays !== 0
        )
          throw fail();
      };
      await denied();
      for (const combination of ['00', '01', '10', '11']) {
        await invoke(adapter, 'setCombinationThroughManagement', active, combination);
        await denied();
      }
    }
    result = Object.freeze({
      operation,
      evidenceLevel: 'adapter-orchestration-only',
      adapterDurableAckObserved: true,
      liveDaemonProved: false,
      hostDurableAckObserved: false,
      sameDirectoryNewPid: true,
      saveAckKillQualified: false,
      revokeAckKillQualified: false,
      commitInProgressQualified: false,
      publicationInProgressQualified: false,
      backupRollbackQualified: false,
      installationQualified: false,
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
function stoppedAccounting(original, before, checkpoint) {
  if (
    checkpoint.present !== true ||
    checkpoint.evidenceLevel !== 'committed-metadata-only' ||
    checkpoint.hostDurableAck !== false ||
    !Number.isSafeInteger(checkpoint.revision) ||
    !Number.isSafeInteger(before.revision) ||
    checkpoint.revision < before.revision ||
    checkpoint.calls < before.calls
  )
    throw fail();
  accounting(original, { ...original, ...checkpoint });
  const revisionGap = checkpoint.revision - before.revision;
  if (
    checkpoint.returnedBytes < Math.max(0, before.returnedBytes - revisionGap * 16384) ||
    (revisionGap === 0 &&
      (checkpoint.calls !== before.calls || checkpoint.returnedBytes !== before.returnedBytes))
  )
    throw fail();
  return baseline({ ...before, ...checkpoint });
}

// The normal same-directory restart is a positive control before revocation.
// Restore only after the actual revoke ACK and verified forced termination;
// the last restart must remain live while explicitly refusing stored recovery.
async function runBackupRollbackAfterRevoke(adapter) {
  let active,
    result,
    failed = false;
  try {
    const revoke = invoke(adapter, 'existingHostDurableAckCapability', 'revoke');
    if (typeof revoke !== 'function' || types.isProxy(revoke)) throw fail();
    active = identity(await invoke(adapter, 'startFreshBusinessHost'));
    const original = baseline(await invoke(adapter, 'seedThroughBusinessHttp', active));
    const before = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (before.exactRead !== true || before.externalToolReplays !== 0) throw fail();
    accounting(original, before.accounting);
    const first = active;
    await forceKill(adapter, first);
    active = undefined;
    const checkpoint = data(invoke(adapter, 'readCommittedSnapshotAfterKill', first));
    const backedAccounting = stoppedAccounting(original, before.accounting, checkpoint);
    const captured = data(invoke(adapter, 'captureStoppedBackup', first));
    if (captured.encryptedFilesCaptured !== 2 || captured.independentAnchorCaptured !== false)
      throw fail();
    active = identity(await invoke(adapter, 'restartSameBusinessHost', first));
    sameDirectory(first, active);
    const control = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (control.exactRead !== true || control.externalToolReplays !== 0) throw fail();
    accounting(backedAccounting, control.accounting);
    const receipt = data(await Reflect.apply(revoke, undefined, [active]));
    if (
      Object.keys(receipt).sort().join(',') !== 'accounting,durableBoundary,kind,pid' ||
      receipt.kind !== 'host-revoke-completed' ||
      receipt.durableBoundary !== 'await-revokeAsync' ||
      receipt.pid !== active.pid
    )
      throw fail();
    accounting(baseline(control.accounting), receipt.accounting);
    const revoked = active;
    // No backup, management or observer I/O between revoke ACK and kill.
    await forceKill(adapter, revoked);
    active = undefined;
    const restored = data(invoke(adapter, 'restoreStoppedBackup', revoked));
    if (restored.encryptedFilesRestored !== 2 || restored.independentAnchorRestored !== false)
      throw fail();
    active = identity(await invoke(adapter, 'restartWithRejectedStorage', revoked));
    sameDirectory(revoked, active);
    if (active.pid === first.pid) throw fail();
    const denied = data(await invoke(adapter, 'readRejectedStorageThroughBusinessHttp', active));
    if (
      denied.requestDenied !== true ||
      denied.originalExposed !== false ||
      denied.upstreamRequests !== 0 ||
      denied.externalToolReplays !== 0
    )
      throw fail();
    result = Object.freeze({
      evidenceLevel: 'adapter-orchestration-only',
      adapterBackupRollbackObserved: true,
      adapterRevokeBoundaryObserved: true,
      sameDirectoryNewPid: true,
      positiveReadBeforeRevoke: true,
      restoredStorageRejected: true,
      independentAnchorRestored: false,
      liveDaemonProved: false,
      installationQualified: false,
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

// Kill while the independent public generation response is held upstream. This
// is not a COMMIT barrier; the client must receive zero bytes and no successful
// completion, then a new daemon must recover the original with durable budgets.
async function runUnpublishedResponseKill(adapter) {
  let active,
    result,
    failed = false;
  try {
    active = identity(await invoke(adapter, 'startFreshBusinessHost'));
    const original = baseline(await invoke(adapter, 'seedThroughBusinessHttp', active));
    const before = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (before.exactRead !== true || before.externalToolReplays !== 0) throw fail();
    accounting(original, before.accounting);
    const held = data(await invoke(adapter, 'beginPublicResponseHold', active));
    if (
      held.pid !== active.pid ||
      held.publicResponseHeld !== true ||
      held.publicBytes !== 0 ||
      held.exactRead !== true ||
      held.externalToolReplays !== 0
    )
      throw fail();
    const first = active;
    await forceKill(adapter, first);
    active = undefined;
    const interrupted = data(await invoke(adapter, 'finishInterruptedPublicResponse', first));
    if (interrupted.interrupted !== true || interrupted.publicBytes !== 0) throw fail();
    const checkpoint = data(invoke(adapter, 'readCommittedSnapshotAfterKill', first));
    const durable = stoppedAccounting(original, before.accounting, checkpoint);
    active = identity(await invoke(adapter, 'restartSameBusinessHost', first));
    sameDirectory(first, active);
    const after = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    if (after.exactRead !== true || after.externalToolReplays !== 0) throw fail();
    accounting(durable, after.accounting);
    const afterAccounting = data(after.accounting);
    if (
      !Number.isSafeInteger(afterAccounting.revision) ||
      afterAccounting.revision < checkpoint.revision
    )
      throw fail();
    result = Object.freeze({
      evidenceLevel: 'adapter-orchestration-only',
      boundary: 'upstream-public-final-held',
      interruptedWithZeroPublicBytes: true,
      sameDirectoryNewPid: true,
      originalReadAfterRestart: true,
      commitInProgressQualified: false,
      publicationCommitQualified: false,
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
module.exports = {
  createClearClient,
  runClearAfterAck,
  runDurableSaveOrRevokeAfterAck,
  runBackupRollbackAfterRevoke,
  runUnpublishedResponseKill,
  accounting,
};
