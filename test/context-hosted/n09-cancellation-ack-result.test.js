'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cancellationAckClosedReceipt,
} = require('../../scripts/context-hosted/n09/cancellation-ack-result');
const safe = { message: 'n09_cancellation_ack_result_rejected' };
function fixture(transition) {
  const name = transition + 'Ack';
  const cases = {},
    evidence = {};
  for (const kill of [true, false]) {
    const key = name + (kill ? 'Kill' : 'Release');
    cases[key] = {
      evidenceLevel: 'adapter-orchestration-only',
      boundary: transition + '-durable-store-before-host-ack',
      forcedKill: kill,
      interruptedWithZeroPublicBytes: false,
      positivePublicCompletion: false,
      actualDurableStoreObserved: true,
      preAckBoundaryObserved: true,
      preparedPredecessorAckObserved: true,
      sendingPredecessorAckObserved: transition === 'uncertain',
      publicTransportCompletedBeforeBoundary: false,
      publicationCompletionObserved: false,
      cancellationBeforeTerminalAckObserved: true,
      clientTransportClosedBeforeBoundary: true,
      publicationCleanupObserved: !kill,
      opaqueAckNotDeliveredAtKill: kill,
      sameDirectoryNewPid: true,
      originalReadAfterRestart: true,
      originalExpiryPreserved: true,
      n09Complete: false,
    };
    evidence[key] = {
      seeded: true,
      validatedReadCount: 3,
      publicGenerationCount: 3,
      externalToolExecutions: 1,
      clearAckCount: 0,
      saveAckCount: 0,
      revokeAckCount: 0,
    };
  }
  return {
    ...cases,
    businessEvidence: evidence,
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
for (const transition of ['withdrawn', 'uncertain']) {
  const group = transition + '-ack';
  test(
    group + ' closed receipt requires both real orchestration controls and stays incomplete',
    () => {
      const receipt = cancellationAckClosedReceipt(fixture(transition), group);
      assert.equal(receipt.phase, 'n09_' + transition + '_ack_scenario_closed');
      assert.equal(receipt.cases, 2);
      assert.equal(receipt.n09Complete, false);
      assert.equal(Object.isFrozen(receipt), true);
      assert.throws(
        () =>
          cancellationAckClosedReceipt(
            fixture(transition),
            transition === 'withdrawn' ? 'uncertain-ack' : 'withdrawn-ack'
          ),
        safe
      );
    }
  );
  test(
    group + ' refuses every corrupted case invariant, missing evidence, network and cleanup',
    () => {
      for (const key of [transition + 'AckKill', transition + 'AckRelease']) {
        const expected = fixture(transition)[key];
        for (const [field, value] of Object.entries(expected)) {
          const row = fixture(transition);
          row[key][field] = typeof value === 'boolean' ? !value : 'wrong';
          assert.throws(() => cancellationAckClosedReceipt(row, group), safe, field);
          delete row[key][field];
          assert.throws(() => cancellationAckClosedReceipt(row, group), safe, field);
        }
        for (const field of Object.keys(fixture(transition).businessEvidence[key])) {
          const row = fixture(transition);
          row.businessEvidence[key][field] = -1;
          assert.throws(() => cancellationAckClosedReceipt(row, group), safe, field);
        }
      }
      for (const key of ['networkProof', 'cleanup']) {
        for (const field of Object.keys(fixture(transition)[key])) {
          const row = fixture(transition);
          row[key][field] = 0;
          assert.throws(() => cancellationAckClosedReceipt(row, group), safe, field);
        }
      }
      for (const patch of [
        { remoteModelRequests: 1 },
        { tlsValidationDisabled: true },
        { originalControllerReused: false },
        { n09Complete: true },
        { extra: true },
      ]) {
        assert.throws(
          () => cancellationAckClosedReceipt({ ...fixture(transition), ...patch }, group),
          safe
        );
      }
    }
  );
}
test('empty, malformed, extreme and executable boundary inputs cannot gain cancellation scope', () => {
  let touched = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        touched++;
        throw Error('private');
      },
      ownKeys() {
        touched++;
        throw Error('private');
      },
    }
  );
  for (const value of [undefined, null, [], '', 1, hostile])
    assert.throws(() => cancellationAckClosedReceipt(value, 'withdrawn-ack'), safe);
  for (const group of [
    undefined,
    null,
    '',
    'sending-ack',
    'WITHDRAWN-ACK',
    '__proto__',
    'x'.repeat(100000),
    hostile,
  ])
    assert.throws(() => cancellationAckClosedReceipt(fixture('withdrawn'), group), safe);
  const row = fixture('uncertain');
  Object.defineProperty(row.uncertainAckKill, 'boundary', {
    get() {
      touched++;
      return 'private';
    },
  });
  assert.throws(() => cancellationAckClosedReceipt(row, 'uncertain-ack'), safe);
  assert.equal(touched, 0);
});
