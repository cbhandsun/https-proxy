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
async function runN08Driver(input) {
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
          checkAck(
            await call('beginRecovery', owner),
            owner,
            barrier,
            mutation,
            'recovery-started'
          );
          checkAck(
            await call('waitUpstreamHold', owner),
            owner,
            barrier,
            mutation,
            'upstream-response-held'
          );
          checkAck(
            await call('applyMutation', owner),
            owner,
            barrier,
            mutation,
            'mutation-applied'
          );
          checkAdmissionEvidence(await call('probeAdmissions', owner));
          checkAck(
            await call('releaseUpstreamHold', owner),
            owner,
            barrier,
            mutation,
            'response-released'
          );
          checkWithdrawal(await call('observeWithdrawal', owner), owner);
        } catch {
          failed = true;
        } finally {
          if (owner) {
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
