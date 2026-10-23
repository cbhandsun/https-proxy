'use strict';

const { randomBytes } = require('node:crypto');
const { types } = require('node:util');
const { exact, parseOwner, ack } = require('./boundary.js');
const { createBusinessClient } = require('./business-client.js');
const { isVerifiedNetworkProof } = require('./hosted-probes.js');
const fail = () => new Error('n08_owned_adapter_rejected');

// Composition support, not a Core fixture: createSession MUST compose the
// original startDaemonOwnedController/createDaemonOwnedAdapter from pinned bytes.
// Scenario capabilities only drive real management/entry HTTP + synthetic
// upstream ownership. They may not inject Core, providers, clocks or roots.
function createOwnedN08Adapter(input, observer) {
  const onPhase = require('../n08/phase-observer.js').createN08PhaseObserver(observer);
  const options = exact(input, ['manifestSha256', 'createSession', 'scenario', 'networkProof']);
  if (
    !/^[a-f0-9]{64}$/.test(options.manifestSha256) ||
    typeof options.createSession !== 'function' ||
    types.isProxy(options.createSession)
  )
    throw fail();
  const proof = exact(options.networkProof, [
    'probesPassed',
    'tlsVerified',
    'nonLoopbackBlocked',
    'listenerOwned',
  ]);
  if (
    !isVerifiedNetworkProof(options.networkProof) ||
    Object.values(proof).some((value) => value !== true)
  )
    throw fail();
  const scenario = exact(options.scenario, [
    'configureAndSeed',
    'beginRecovery',
    'waitUpstreamHold',
    'applyMutation',
    'probeAdmissions',
    'releaseUpstreamHold',
    'observeWithdrawal',
    'cancelUpstream',
  ]);
  if (Object.values(scenario).some((value) => typeof value !== 'function' || types.isProxy(value)))
    throw fail();
  const sessions = new Map();
  const active = new Map();
  const context = (identity) => {
    const owner = parseOwner(identity);
    const value = active.get(owner.nonce);
    if (
      !value ||
      value.identity.pid !== owner.pid ||
      value.identity.manifestSha256 !== owner.manifestSha256
    )
      throw fail();
    return value;
  };
  const adapter = {
    async startCase(inputCase) {
      const caseOptions = exact(inputCase, ['session', 'label', 'barrier', 'mutation']);
      if (![0, 1].includes(caseOptions.session) || !['00', '01', '10'].includes(caseOptions.label))
        throw fail();
      if (!sessions.has(caseOptions.session)) {
        const session = await options.createSession(caseOptions.session);
        sessions.set(caseOptions.session, exact(session, ['launch', 'close']));
      }
      const session = sessions.get(caseOptions.session);
      onPhase(143);
      const owner = await session.launch({
        label: caseOptions.label,
        initialEnabled: false,
        initialPersistence: false,
      });
      const identity = parseOwner({
        pid: owner.identity.pid,
        manifestSha256: options.manifestSha256,
        nonce: randomBytes(16).toString('hex'),
      });
      // Retain immediately: failed seeding is still owned by session.close().
      const value = { identity, owner, caseOptions, client: undefined, scenarioState: undefined };
      active.set(identity.nonce, value);
      onPhase(144);
      const seeded = exact(await scenario.configureAndSeed(value), [
        'entryKey',
        'templates',
        'state',
      ]);
      value.client = createBusinessClient({
        entryPort: owner.identity.entryPort,
        entryKey: seeded.entryKey,
        templates: seeded.templates,
      });
      value.scenarioState = seeded.state;
      return identity;
    },
    async beginRecovery(identity) {
      const value = context(identity);
      await scenario.beginRecovery(value);
      return ack(
        identity,
        value.caseOptions.barrier,
        value.caseOptions.mutation,
        'recovery-started'
      );
    },
    waitUpstreamHold: (identity) => scenario.waitUpstreamHold(context(identity)),
    applyMutation: (identity) => scenario.applyMutation(context(identity)),
    probeAdmissions: (identity) => scenario.probeAdmissions(context(identity)),
    releaseUpstreamHold: (identity) => scenario.releaseUpstreamHold(context(identity)),
    async observeWithdrawal(identity) {
      const value = context(identity);
      if ((await value.owner.isAlive()) !== true) throw fail();
      const evidence = await scenario.observeWithdrawal(value);
      return { ...evidence, ownerStatus: { ...identity, alive: true } };
    },
    async stop(identity) {
      const value = context(identity);
      let cancelled;
      let stopped;
      try {
        cancelled = (await scenario.cancelUpstream(value)) === true;
      } finally {
        stopped = (await value.owner.stop()) === true;
        active.delete(identity.nonce);
      }
      if (!cancelled || !stopped) throw fail();
      return ack(identity, value.caseOptions.barrier, value.caseOptions.mutation, 'tree-empty');
    },
    async closeSession(index) {
      let clean = true;
      for (const [nonce, value] of active)
        if (value.caseOptions.session === index) {
          try {
            if ((await scenario.cancelUpstream(value)) !== true) clean = false;
          } catch {
            clean = false;
          }
          active.delete(nonce);
        }
      const session = sessions.get(index);
      if (session) {
        try {
          if ((await session.close()) !== true) clean = false;
        } catch {
          clean = false;
        }
      }
      sessions.delete(index);
      return clean;
    },
  };
  return Object.freeze(adapter);
}
module.exports = { createOwnedN08Adapter };
