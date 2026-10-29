'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  transitionCommitClosedReceipt,
} = require('../../scripts/context-hosted/n09/transition-commit-result');
const safe = { message: 'n09_transition_commit_result_rejected' };
function fixture(name) {
  const transition = name === 'finished' ? 'transport-finished' : name;
  const cancellation = ['withdrawn', 'uncertain'].includes(name),
    finished = name === 'finished';
  const results = {},
    evidence = {};
  for (const kill of [true, false]) {
    const key = name + 'Commit' + (kill ? 'Kill' : 'Release');
    results[key] = {
      evidenceLevel: 'adapter-orchestration-only',
      boundary: transition + '-save-reference-state-commit-pending',
      forcedKill: kill,
      actualTargetWritePending: true,
      readAdmissionBlocked: true,
      predecessorAckObserved: true,
      preparedPredecessorAckObserved: true,
      sendingPredecessorAckObserved: finished || name === 'uncertain',
      publicTransportCompletedBeforeBoundary: finished,
      cancellationBeforeBoundary: cancellation,
      clientTransportClosedBeforeBoundary: cancellation,
      interruptedWithZeroPublicBytes: kill && !finished && !cancellation,
      positivePublicCompletion: !kill && !cancellation,
      cleanupCompletionObserved: !kill && cancellation,
      publicationCompletionObserved: !kill && !cancellation,
      opaqueTargetAckNotDeliveredAtKill: kill,
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
    ...results,
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
for (const name of ['sending', 'finished', 'withdrawn', 'uncertain']) {
  test(name + ' COMMIT receipt requires the exact two controls and stays incomplete', () => {
    const receipt = transitionCommitClosedReceipt(fixture(name), name + '-commit');
    assert.equal(receipt.phase, 'n09_' + name + '_commit_scenario_closed');
    assert.equal(receipt.cases, 2);
    assert.equal(receipt.n09Complete, false);
    assert.equal(Object.isFrozen(receipt), true);
    for (const other of ['sending', 'finished', 'withdrawn', 'uncertain'].filter(
      (value) => value !== name
    ))
      assert.throws(() => transitionCommitClosedReceipt(fixture(name), other + '-commit'), safe);
  });
  test(
    name +
      ' COMMIT receipt refuses every mutated or missing invariant, extra proof fields and cleanup failures',
    () => {
      for (const key of [name + 'CommitKill', name + 'CommitRelease']) {
        for (const [field, value] of Object.entries(fixture(name)[key])) {
          const row = fixture(name);
          row[key][field] = typeof value === 'boolean' ? !value : 'wrong';
          assert.throws(() => transitionCommitClosedReceipt(row, name + '-commit'), safe, field);
          delete row[key][field];
          assert.throws(() => transitionCommitClosedReceipt(row, name + '-commit'), safe, field);
        }
        const extra = fixture(name);
        extra[key].unrecognized = true;
        assert.throws(() => transitionCommitClosedReceipt(extra, name + '-commit'), safe);
        for (const field of Object.keys(fixture(name).businessEvidence[key])) {
          const row = fixture(name);
          row.businessEvidence[key][field] = -1;
          assert.throws(() => transitionCommitClosedReceipt(row, name + '-commit'), safe, field);
        }
      }
      for (const key of ['networkProof', 'cleanup']) {
        for (const field of Object.keys(fixture(name)[key])) {
          const row = fixture(name);
          row[key][field] = 0;
          assert.throws(() => transitionCommitClosedReceipt(row, name + '-commit'), safe, field);
        }
      }
      for (const patch of [
        { remoteModelRequests: 1 },
        { originalControllerReused: false },
        { tlsValidationDisabled: true },
        { n09Complete: true },
        { extra: true },
      ])
        assert.throws(
          () => transitionCommitClosedReceipt({ ...fixture(name), ...patch }, name + '-commit'),
          safe
        );
    }
  );
}
test('COMMIT receipt rejects empty, malformed, extreme and executable inputs without invoking hooks', () => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw Error('private');
  };
  const hostile = new Proxy({}, { get: trap, ownKeys: trap });
  for (const input of [undefined, null, '', 1, [], hostile])
    assert.throws(() => transitionCommitClosedReceipt(input, 'sending-commit'), safe);
  for (const group of [
    undefined,
    null,
    '',
    'original',
    'sending-ack',
    'UNCERTAIN-COMMIT',
    'sending-commit\n',
    '__proto__',
    'x'.repeat(100000),
    hostile,
  ])
    assert.throws(() => transitionCommitClosedReceipt(fixture('sending'), group), safe);
  const row = fixture('uncertain');
  Object.defineProperty(row.uncertainCommitKill, 'boundary', { get: trap });
  assert.throws(() => transitionCommitClosedReceipt(row, 'uncertain-commit'), safe);
  assert.equal(hooks, 0);
});
