'use strict';

const {
  BARRIERS,
  MUTATIONS,
  exact,
  parseOwner,
  checkAck,
  checkAdmissionEvidence,
  checkWithdrawal,
} = require('./observed-boundary.js');
const METHODS = Object.freeze([
  'startCase',
  'beginRecovery',
  'waitUpstreamHold',
  'applyMutation',
  'probeAdmissions',
  'releaseUpstreamHold',
  'observeWithdrawal',
  'stop',
  'closeSession',
]);
const fail = () => new Error('n08_driver_rejected');
const { createN08PhaseObserver } = require('./phase-observer.js');
async function runN08Driver(input, observer) {
  const onPhase = createN08PhaseObserver(observer);
  let adapter;
  try {
    adapter = exact(input, METHODS);
    if (METHODS.some((name) => typeof adapter[name] !== 'function')) throw fail();
  } catch {
    throw fail();
  }
  const call = (name, ...args) => Reflect.apply(adapter[name], undefined, args);
  const nonces = new Set();
  const cases = [];
  for (let session = 0; session < BARRIERS.length; session++) {
    const barrier = BARRIERS[session];
    let sessionFailed = false;
    try {
      for (let index = 0; index < MUTATIONS.length; index++) {
        const mutation = MUTATIONS[index];
        let owner;
        let failed = false;
        try {
          owner = parseOwner(
            await call(
              'startCase',
              Object.freeze({ session, label: ['00', '01', '10'][index], barrier, mutation })
            )
          );
          if (nonces.has(owner.nonce)) throw fail();
          nonces.add(owner.nonce);
          onPhase(153);
          checkAck(
            await call('beginRecovery', owner),
            owner,
            barrier,
            mutation,
            'recovery-started'
          );
          onPhase(154);
          checkAck(
            await call('waitUpstreamHold', owner),
            owner,
            barrier,
            mutation,
            'upstream-response-held'
          );
          onPhase(155);
          checkAck(
            await call('applyMutation', owner),
            owner,
            barrier,
            mutation,
            'mutation-applied'
          );
          onPhase(156);
          checkAdmissionEvidence(await call('probeAdmissions', owner));
          onPhase(157);
          checkAck(
            await call('releaseUpstreamHold', owner),
            owner,
            barrier,
            mutation,
            'response-released'
          );
          onPhase(158);
          checkWithdrawal(await call('observeWithdrawal', owner), owner);
        } catch {
          failed = true;
        } finally {
          if (owner) {
            if (!failed) {
              try {
                onPhase(159);
              } catch {
                failed = true;
              }
            }
            try {
              checkAck(await call('stop', owner), owner, barrier, mutation, 'tree-empty');
            } catch {
              failed = true;
            }
          }
        }
        if (failed) throw fail();
        cases.push(
          Object.freeze({
            session,
            label: ['00', '01', '10'][index],
            barrier,
            mutation,
            evidenceBoundaryPassed: true,
          })
        );
      }
    } catch {
      sessionFailed = true;
    } finally {
      if (!sessionFailed) {
        try {
          onPhase(160);
        } catch {
          sessionFailed = true;
        }
      }
      try {
        if ((await call('closeSession', session)) !== true) sessionFailed = true;
      } catch {
        sessionFailed = true;
      }
    }
    if (sessionFailed) throw fail();
  }
  return Object.freeze({
    scope: 'n08_unwired_driver_boundary',
    evidenceLevel: 'adapter-orchestration-only',
    cases: Object.freeze(cases),
    n08Qualified: false,
    n09Qualified: false,
    liveDaemonProved: false,
  });
}
module.exports = { runN08Driver };
