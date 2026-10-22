'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { types } = require('node:util');
const { exact, snapshotOwnData } = require('../shared/boundary.js');
const { createHostedListener } = require('../shared/hosted-listener.js');
const { runHostedProbes } = require('../shared/hosted-probes.js');
const {
  buildHostedController,
  verifyPhysicalPath,
} = require('../shared/build-hosted-controller.js');
const { createHostedControllerSpawn } = require('../shared/hosted-spawn.js');
const { createOwnedN08Adapter } = require('../shared/owned-adapter.js');
const { runN08Driver } = require('./observed-driver.js');
const { closeOwnedResources } = require('./cleanup.js');
const fail = () => new Error('n08_hosted_composition_rejected');

// Trusted caller is the reviewed hosted harness, itself assigned to the existing
// HpmRuntimeBoundaryJob before its stdin grant. No Core imports or injected roots.
async function composeHostedN08(input) {
  const options = exact(input, [
    'candidate',
    'ownedRoot',
    'manifestSha256',
    'powershellExecutable',
    'sourcePins',
    'controllerPins',
    'loadedPins',
    'networkRoot',
    'caSha256',
    'leafSha256',
    'negativeAddress',
    'scenario',
  ]);
  let listener, adapter, output;
  let cleanupEvidence;
  const sessions = new Map();
  try {
    if (
      !path.isAbsolute(options.candidate) ||
      !path.isAbsolute(options.ownedRoot) ||
      options.networkRoot !== path.join(options.ownedRoot, 'n08-hosted-network') ||
      !/^[a-f0-9]{64}$/.test(options.manifestSha256) ||
      process.env.NODE_OPTIONS ||
      process.env.NODE_PATH ||
      process.execArgv.length !== 0 ||
      fs.realpathSync.native(process.execPath).toLowerCase() !==
        fs.realpathSync
          .native(path.join(options.ownedRoot, 'payload/runtime/node/node.exe'))
          .toLowerCase()
    )
      throw fail();
    const sourcePins = exact(options.sourcePins, [
      'scripts/lib/context-recovery-daemon-owned-transport.js',
      'scripts/lib/context-recovery-daemon-owned-adapter.js',
    ]);
    const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
    verifyPhysicalPath(options.candidate, true);
    verifyPhysicalPath(options.ownedRoot, true);
    const loadedPins = snapshotOwnData(options.loadedPins);
    if (Object.keys(loadedPins).length < 1 || Object.keys(loadedPins).length > 512) throw fail();
    const normalizedPins = new Map();
    for (const [file, expected] of Object.entries(loadedPins)) {
      if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file) || !/^[a-f0-9]{64}$/.test(expected))
        throw fail();
      const key = path.resolve(file).toLowerCase();
      if (normalizedPins.has(key)) throw fail();
      normalizedPins.set(key, expected);
    }
    function checkLoadedClosure() {
      for (const file of Object.keys(require.cache)) {
        const expected = normalizedPins.get(path.resolve(file).toLowerCase());
        verifyPhysicalPath(file, false);
        if (!expected || hash(fs.readFileSync(file)) !== expected) throw fail();
      }
    }
    checkLoadedClosure();
    for (const [name, expected] of Object.entries(sourcePins)) {
      verifyPhysicalPath(path.join(options.candidate, name), false);
      if (
        !/^[a-f0-9]{64}$/.test(expected) ||
        hash(fs.readFileSync(path.join(options.candidate, name))) !== expected
      )
        throw fail();
    }
    const scenario = exact(options.scenario, [
      'onBusinessRequest',
      'configureAndSeed',
      'beginRecovery',
      'waitUpstreamHold',
      'applyMutation',
      'probeAdmissions',
      'releaseUpstreamHold',
      'observeWithdrawal',
      'cancelUpstream',
    ]);
    if (
      Object.values(scenario).some((value) => typeof value !== 'function' || types.isProxy(value))
    )
      throw fail();
    listener = await createHostedListener({
      networkRoot: options.networkRoot,
      ownedNode: process.execPath,
      negativeAddress: options.negativeAddress,
      onBusinessRequest: scenario.onBusinessRequest,
    });
    const listenerState = listener.inspect();
    const proof = await runHostedProbes(
      {
        ownedNode: path.join(options.ownedRoot, 'payload/runtime/node/node.exe'),
        networkRoot: options.networkRoot,
        caSha256: options.caSha256,
        leafSha256: options.leafSha256,
        negativeAddress: listenerState.negativeAddress,
        negativePort: listenerState.negativePort,
      },
      listener
    );
    // No daemon process is created before real TLS and negative-egress probes.
    const copies = buildHostedController({
      candidate: options.candidate,
      ownedRoot: options.ownedRoot,
      sourcePins: options.controllerPins,
      caSha256: options.caSha256,
    });
    const { startDaemonOwnedController } = require(
      path.join(options.candidate, 'scripts/lib/context-recovery-daemon-owned-transport.js')
    );
    const { createDaemonOwnedAdapter } = require(
      path.join(options.candidate, 'scripts/lib/context-recovery-daemon-owned-adapter.js')
    );
    checkLoadedClosure();
    const createSession = async (index) => {
      if (sessions.has(index)) throw fail();
      checkLoadedClosure();
      for (const [name, expected] of Object.entries(copies.copyPins)) {
        verifyPhysicalPath(path.join(copies.outputRoot, name), false);
        if (hash(fs.readFileSync(path.join(copies.outputRoot, name))) !== expected) throw fail();
      }
      const channel = startDaemonOwnedController(
        {
          ownedRoot: options.ownedRoot,
          install: path.join(options.ownedRoot, 'payload'),
          manifestSha256: options.manifestSha256,
          powershellExecutable: options.powershellExecutable,
        },
        createHostedControllerSpawn({
          candidate: options.candidate,
          ownedRoot: options.ownedRoot,
          manifestSha256: options.manifestSha256,
          powershellExecutable: options.powershellExecutable,
        })
      );
      // Retain channel immediately; composition failure must still close its Job.
      const retained = { channel, owned: undefined };
      sessions.set(index, retained);
      try {
        retained.owned = createDaemonOwnedAdapter(
          { ownedRoot: options.ownedRoot, install: path.join(options.ownedRoot, 'payload') },
          channel
        );
        return { launch: retained.owned.launch, close: retained.owned.close };
      } catch {
        await channel.close();
        throw fail();
      }
    };
    const scenarioMethods = Object.fromEntries(
      Object.entries(scenario).filter(([name]) => name !== 'onBusinessRequest')
    );
    adapter = createOwnedN08Adapter({
      manifestSha256: options.manifestSha256,
      createSession,
      scenario: scenarioMethods,
      networkProof: proof,
    });
    const result = await runN08Driver(adapter);
    checkLoadedClosure();
    output = Object.freeze({
      ...result,
      networkProof: proof,
      originalControllerReused: true,
      controllerCopiesPinned: true,
      tlsValidationDisabled: false,
      remoteModelRequests: 0,
    });
  } catch {
    throw fail();
  } finally {
    cleanupEvidence = await closeOwnedResources(sessions, adapter, listener);
  }
  return Object.freeze({ ...output, cleanupEvidence });
}
module.exports = { composeHostedN08 };
