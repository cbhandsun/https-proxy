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

// Existing-ACK-dependent path, kept distinct from clear and module reopen.
// No current real daemon adapter supplies this capability; fail before seeding.
async function runDurableSaveOrRevokeAfterAck(adapter, operation) {
  if (!['save', 'revoke'].includes(operation)) throw fail();
  let capability;
  try {
    capability = await invoke(adapter, 'existingHostDurableAckCapability', operation);
  } catch {
    throw new Error('n09_host_durable_ack_unavailable');
  }
  if (capability !== true) throw new Error('n09_host_durable_ack_unavailable');
  throw new Error('n09_save_revoke_host_wiring_not_implemented');
}
module.exports = {
  createClearClient,
  runClearAfterAck,
  runDurableSaveOrRevokeAfterAck,
  accounting,
};
