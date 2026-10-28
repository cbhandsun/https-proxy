'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sendingAckClosedReceipt,
  finishedAckClosedReceipt,
} = require('../../scripts/context-hosted/n09/sending-ack-result');
function fixture() {
  const result = (kill) => ({
    evidenceLevel: 'adapter-orchestration-only',
    boundary: 'sending-durable-store-before-host-ack',
    forcedKill: kill,
    interruptedWithZeroPublicBytes: kill,
    positivePublicCompletion: !kill,
    actualDurableStoreObserved: true,
    preAckBoundaryObserved: true,
    preparedPredecessorAckObserved: true,
    opaqueAckNotDeliveredAtKill: kill,
    sameDirectoryNewPid: true,
    originalReadAfterRestart: true,
    originalExpiryPreserved: true,
    n09Complete: false,
  });
  const evidence = () => ({
    seeded: true,
    validatedReadCount: 3,
    publicGenerationCount: 3,
    externalToolExecutions: 1,
    clearAckCount: 0,
    saveAckCount: 0,
    revokeAckCount: 0,
  });
  return {
    sendingAckKill: result(true),
    sendingAckRelease: result(false),
    businessEvidence: { sendingAckKill: evidence(), sendingAckRelease: evidence() },
    networkProof: {
      probesPassed: true,
      tlsVerified: true,
      nonLoopbackBlocked: true,
      listenerOwned: true,
    },
    originalControllerReused: true,
    tlsValidationDisabled: false,
    remoteModelRequests: 0,
    n09Complete: false,
    cleanup: { adaptersClosed: 2, listenerClosed: true },
  };
}
const safe = { message: 'n09_sending_ack_result_rejected' };
test('sending receipt is restricted to the two original-Job controls and remains incomplete', () => {
  const receipt = sendingAckClosedReceipt(fixture());
  assert.equal(receipt.cases, 2);
  assert.equal(receipt.phase, 'n09_sending_ack_scenario_closed');
  assert.equal(receipt.n09Complete, false);
  assert.equal(Object.isFrozen(receipt), true);
});
test('sending receipt rejects wrong case, replay, expiry, budget/publication evidence and incomplete cleanup', () => {
  for (const [name, patches] of [
    [
      'sendingAckKill',
      [
        { boundary: 'prepared-durable-store-before-host-ack' },
        { preparedPredecessorAckObserved: false },
        { opaqueAckNotDeliveredAtKill: false },
        { originalExpiryPreserved: false },
        { sameDirectoryNewPid: false },
      ],
    ],
    [
      'sendingAckRelease',
      [
        { positivePublicCompletion: false },
        { originalReadAfterRestart: false },
        { n09Complete: true },
      ],
    ],
    ['cleanup', [{ adaptersClosed: 1 }, { adaptersClosed: 10 }, { listenerClosed: false }]],
    ['networkProof', [{ tlsVerified: false }, { nonLoopbackBlocked: false }]],
  ])
    for (const patch of patches) {
      const value = fixture();
      Object.assign(value[name], patch);
      assert.throws(() => sendingAckClosedReceipt(value), safe);
    }
  for (const patch of [
    { validatedReadCount: 2 },
    { externalToolExecutions: 2 },
    { saveAckCount: 1 },
    { seeded: false },
  ]) {
    const value = fixture();
    Object.assign(value.businessEvidence.sendingAckKill, patch);
    assert.throws(() => sendingAckClosedReceipt(value), safe);
  }
  for (const value of [
    null,
    {},
    { ...fixture(), remoteModelRequests: 1 },
    { ...fixture(), extra: true },
  ])
    assert.throws(() => sendingAckClosedReceipt(value), safe);
});
test('sending receipt validation never executes getters or proxies', () => {
  let touched = 0;
  const value = fixture();
  Object.defineProperty(value.sendingAckKill, 'boundary', {
    enumerable: true,
    get() {
      touched++;
      throw Error('private');
    },
  });
  assert.throws(() => sendingAckClosedReceipt(value), safe);
  assert.throws(
    () =>
      sendingAckClosedReceipt(
        new Proxy(fixture(), {
          ownKeys() {
            touched++;
          },
        })
      ),
    safe
  );
  assert.equal(touched, 0);
});

test('finished receipt requires both predecessor ACKs and complete wire without claiming zero-byte interruption', () => {
  const source = fixture();
  const convert = (value, kill) => ({
    ...value,
    boundary: 'transport-finished-durable-store-before-host-ack',
    interruptedWithZeroPublicBytes: false,
    sendingPredecessorAckObserved: true,
    publicTransportCompletedBeforeBoundary: true,
    publicationCompletionObserved: !kill,
  });
  const value = {
    ...source,
    finishedAckKill: convert(source.sendingAckKill, true),
    finishedAckRelease: convert(source.sendingAckRelease, false),
    businessEvidence: {
      finishedAckKill: source.businessEvidence.sendingAckKill,
      finishedAckRelease: source.businessEvidence.sendingAckRelease,
    },
  };
  delete value.sendingAckKill;
  delete value.sendingAckRelease;
  assert.equal(finishedAckClosedReceipt(value).phase, 'n09_finished_ack_scenario_closed');
  assert.throws(() => sendingAckClosedReceipt(value), safe);
  assert.throws(() => finishedAckClosedReceipt(fixture()), safe);
  for (const patch of [
    { sendingPredecessorAckObserved: false },
    { publicTransportCompletedBeforeBoundary: false },
    { interruptedWithZeroPublicBytes: true },
    { publicationCompletionObserved: true },
  ])
    assert.throws(
      () =>
        finishedAckClosedReceipt({
          ...value,
          finishedAckKill: { ...value.finishedAckKill, ...patch },
        }),
      safe
    );
});
