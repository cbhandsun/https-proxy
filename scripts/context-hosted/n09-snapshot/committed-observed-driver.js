'use strict';

const path = require('node:path');
const { types } = require('node:util');
const fail = () => new Error('n09_committed_observed_kill_failed');
function data(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    result[key] = slot.value;
  }
  return result;
}
function invoke(adapter, name, ...args) {
  if (!adapter || typeof adapter !== 'object' || types.isProxy(adapter)) throw fail();
  const slot = Object.getOwnPropertyDescriptor(adapter, name);
  if (typeof slot?.value !== 'function' || types.isProxy(slot.value)) throw fail();
  return Reflect.apply(slot.value, undefined, args);
}
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function identity(input) {
  const value = data(input);
  if (
    !count(value.pid) ||
    value.pid === 0 ||
    !digest(value.manifestSha256) ||
    value.isolatedLoopbackSynthetic !== true ||
    value.actualBusinessHost !== true
  )
    throw fail();
  for (const name of ['configDir', 'runtimeDir']) {
    const dir = value[name];
    if (
      typeof dir !== 'string' ||
      dir.length > 4096 ||
      !path.isAbsolute(dir) ||
      /^[\\/]{2}/.test(dir) ||
      [...dir].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      dir.split(/[\\/]/).some((part) => part === '..' || part === '.')
    )
      throw fail();
  }
  if (value.configDir === value.runtimeDir) throw fail();
  return Object.freeze({
    pid: value.pid,
    configDir: value.configDir,
    runtimeDir: value.runtimeDir,
    manifestSha256: value.manifestSha256,
  });
}
function baseline(input) {
  const value = data(input);
  if (
    !digest(value.originalSha256) ||
    !digest(value.authorizationSha256) ||
    typeof value.rootId !== 'string' ||
    !/^hbs_[a-f0-9]{32}$/.test(value.rootId) ||
    !count(value.expiresAt) ||
    value.expiresAt === 0 ||
    !count(value.calls) ||
    !count(value.returnedBytes)
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
function snapshot(input, expected, revision = 1) {
  const value = data(input);
  if (
    value.present !== true ||
    value.evidenceLevel !== 'committed-metadata-only' ||
    value.hostDurableAck !== false ||
    value.rootId !== expected.rootId ||
    value.expiresAt !== expected.expiresAt ||
    !count(value.revision) ||
    value.revision < revision ||
    !count(value.calls) ||
    value.calls < expected.calls ||
    !count(value.returnedBytes) ||
    value.returnedBytes < expected.returnedBytes
  )
    throw fail();
  return Object.freeze({
    rootId: value.rootId,
    expiresAt: value.expiresAt,
    revision: value.revision,
    calls: value.calls,
    returnedBytes: value.returnedBytes,
  });
}
async function kill(adapter, owner) {
  const value = data(await invoke(adapter, 'killOwnedJob', owner));
  if (
    value.pid !== owner.pid ||
    value.treeEmpty !== true ||
    value.shutdownInvoked !== false ||
    value.semantics !== 'forced_cleanup'
  )
    throw fail();
}

// Pure orchestration. Real adapters separately attest actual host observation.
// This sequence is not runDurableSaveOrRevokeAfterAck and never calls that API.
async function runCommittedObservedKill(adapter, onPhase = () => {}) {
  let active,
    failed = false,
    result;
  try {
    if (typeof onPhase !== 'function' || types.isProxy(onPhase)) throw fail();
    onPhase(101);
    active = identity(await invoke(adapter, 'startFreshBusinessHost'));
    onPhase(102);
    const original = baseline(await invoke(adapter, 'seedThroughBusinessHttp', active));
    onPhase(103);
    const before = snapshot(await invoke(adapter, 'readCommittedSnapshot', active), original);
    const old = active;
    onPhase(104);
    await kill(adapter, old);
    active = undefined;
    onPhase(105);
    active = identity(await invoke(adapter, 'restartSameBusinessHost', old));
    if (
      old.pid === active.pid ||
      old.configDir !== active.configDir ||
      old.runtimeDir !== active.runtimeDir ||
      old.manifestSha256 !== active.manifestSha256
    )
      throw fail();
    onPhase(106);
    const restarted = snapshot(
      await invoke(adapter, 'readCommittedSnapshot', active),
      before,
      before.revision
    );
    onPhase(107);
    const read = data(await invoke(adapter, 'readThroughBusinessHttp', active));
    onPhase(108);
    if (read.exactRead !== true || read.externalToolReplays !== 0) throw fail();
    const afterRead = baseline(read.accounting);
    if (
      afterRead.originalSha256 !== original.originalSha256 ||
      afterRead.authorizationSha256 !== original.authorizationSha256 ||
      afterRead.rootId !== original.rootId ||
      afterRead.expiresAt !== original.expiresAt ||
      afterRead.calls < restarted.calls ||
      afterRead.returnedBytes < restarted.returnedBytes
    )
      throw fail();
    result = Object.freeze({
      sequence: 'committed-observed-kill',
      evidenceLevel: 'adapter-orchestration-only',
      liveDaemonProved: false,
      adapterCommittedObservation: true,
      hostDurableAckObserved: false,
      sameDirectoryNewPid: true,
      adapterExactReadAfterRestart: true,
      saveAckKillQualified: false,
      revokeAckKillQualified: false,
      commitInProgressQualified: false,
      publicationInProgressQualified: false,
      installationQualified: false,
      n09Complete: false,
    });
  } catch {
    failed = true;
  } finally {
    if (active) {
      try {
        await kill(adapter, active);
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
module.exports = { runCommittedObservedKill };
