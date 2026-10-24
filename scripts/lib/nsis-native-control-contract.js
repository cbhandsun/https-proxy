'use strict';
const { types, isDeepStrictEqual } = require('node:util');
const { compareReceipts } = require('./nsis-encrypted-contract');
const fail = () => new Error('native_control_probe_failed');
function equalReceipts(first, second) {
  try {
    compareReceipts(first, second);
  } catch {
    throw fail();
  }
}
function exact(input, names) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).sort().join(',') !== [...names].sort().join(',')
  )
    throw fail();
  const result = {};
  for (const name of names) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    result[name] = slot.value;
  }
  return result;
}
function controlReceipt(input, command) {
  const value = exact(input, ['schemaVersion', 'command', 'ok', 'gracefulDrain']);
  if (
    !['start', 'stop'].includes(command) ||
    value.schemaVersion !== 1 ||
    value.command !== command ||
    value.ok !== true ||
    value.gracefulDrain !== (command === 'stop')
  )
    throw fail();
  return value;
}
function workerReceipt(input, installation) {
  const value = exact(input, [
    'backend',
    'manifestSha256',
    'sourceCount',
    'receipt',
    'observation',
  ]);
  const observed = exact(value.observation, [
    'workerStarted',
    'nativeKeyCompleted',
    'databaseOpened',
    'engineReady',
    'ready',
    'refused',
    'anchorOpened',
    'anchorPersisted',
  ]);
  if (
    value.backend !== 'default-worker' ||
    value.manifestSha256 !== installation.manifestSha256 ||
    value.sourceCount !== installation.sourceCount ||
    Object.entries(observed).some(([key, v]) => v !== (key !== 'refused'))
  )
    throw fail();
  const receipt = exact(value.receipt, [
    'budgetSha256',
    'callCount',
    'expiresAt',
    'keySha256',
    'originalSha256',
    'rootId',
    'sourceId',
  ]);
  equalReceipts(receipt, receipt);
  return receipt;
}
function storeWitness(input, receipt) {
  const value = exact(input, [
    'schemaVersion',
    'hasBlobs',
    'blobs',
    'revision',
    'createdAt',
    'expiresAt',
  ]);
  if (
    Object.values(value).some((v) => !Number.isSafeInteger(v) || v < 0) ||
    value.schemaVersion !== 3 ||
    value.hasBlobs !== 1 ||
    value.revision !== 1 ||
    value.createdAt >= value.expiresAt ||
    value.expiresAt !== receipt.expiresAt
  )
    throw fail();
  return value;
}
async function exerciseNativeControl(
  { fixture, control, ready, inspect, verify, phase },
  installation
) {
  phase('seed');
  verify();
  const seed = workerReceipt(fixture('seed'), installation),
    original = storeWitness(inspect(), seed);
  let prior;
  for (let round = 1; round <= 2; round++) {
    verify();
    phase(`start-${round}`);
    controlReceipt(control('start'), 'start');
    phase(`ready-${round}`);
    const identity = exact(await ready(), ['pid', 'instanceId']);
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid < 1 ||
      identity.pid > 0xffffffff ||
      typeof identity.instanceId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(identity.instanceId) ||
      (prior && identity.instanceId === prior.instanceId)
    )
      throw fail();
    // Windows may legitimately reuse an exited PID; a fresh instance nonce is required.
    prior = identity;
    phase(`stop-${round}`);
    controlReceipt(control('stop'), 'stop');
    phase(`read-${round}`);
    equalReceipts(seed, workerReceipt(fixture('read'), installation));
    const current = storeWitness(inspect(), seed);
    if (!isDeepStrictEqual(current, original)) throw fail();
    verify();
  }
  phase('complete');
  return {
    schemaVersion: 1,
    scope: 'installed_native_idle_stop_storage_reopen',
    passed: true,
    normalStops: 2,
    originalExpiryPreserved: true,
    storageReopenVerified: true,
    idleGracefulStopVerified: true,
    restartRetention: false,
    clientQualified: false,
    retention24hQualified: false,
    modelRequests: 0,
  };
}
module.exports = { exact, controlReceipt, workerReceipt, storeWitness, exerciseNativeControl };
