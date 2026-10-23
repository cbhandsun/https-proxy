'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exact, snapshotOwnData } = require('../shared/boundary.js');
const { createHostedListener } = require('../shared/hosted-listener.js');
const { runHostedProbes } = require('../shared/hosted-probes.js');
const {
  buildHostedController,
  verifyPhysicalPath,
} = require('../shared/build-hosted-controller.js');
const { createN09BusinessAdapter } = require('../n09-business/business-adapter.js');
const { runCommittedObservedKill } = require('../n09-snapshot/committed-observed-driver.js');
const { runClearAfterAck, runDurableSaveOrRevokeAfterAck } = require('../n09-ipc/driver.js');
const { buildHostedLifecycle, createHostedLifecycleSpawn } = require('./hosted-lifecycle.js');
const { buildN09AckController } = require('../n09-ack/bootstrap-controller');
const fail = () => new Error('n09_hosted_composition_rejected');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
async function closeResources(adapters, listener) {
  let failed = false,
    adaptersClosed = 0,
    listenerClosed = false;
  for (const adapter of adapters) {
    try {
      await adapter.close();
      adaptersClosed++;
    } catch {
      failed = true;
    }
  }
  if (listener) {
    try {
      listenerClosed = (await listener.close()) === true;
      if (!listenerClosed) failed = true;
    } catch {
      failed = true;
    }
  }
  if (failed) throw fail();
  return Object.freeze({ adaptersClosed, listenerClosed });
}
// Called only from the existing original outer HpmRuntimeBoundaryJob, after its
// stdin grant and full literal/lazy closure hash check. No controller replacement.
async function composeHostedN09(input) {
  let listener, active, result, cleanup;
  const adapters = [];
  try {
    const options = exact(input, [
      'candidate',
      'ownedRoot',
      'manifestSha256',
      'controllerPins',
      'lifecyclePins',
      'loadedPins',
      'networkRoot',
      'caSha256',
      'leafSha256',
      'negativeAddress',
    ]);
    verifyPhysicalPath(options.candidate, true);
    verifyPhysicalPath(options.ownedRoot, true);
    if (
      options.networkRoot !== path.join(options.ownedRoot, 'n08-hosted-network') ||
      !hex(options.manifestSha256) ||
      process.env.NODE_OPTIONS ||
      process.env.NODE_PATH ||
      process.execArgv.length !== 0 ||
      fs.realpathSync.native(process.execPath).toLowerCase() !==
        fs.realpathSync
          .native(path.join(options.ownedRoot, 'payload/runtime/node/node.exe'))
          .toLowerCase()
    )
      throw fail();
    const pins = snapshotOwnData(options.loadedPins),
      normalized = new Map();
    if (Object.keys(pins).length < 1 || Object.keys(pins).length > 512) throw fail();
    for (const [file, expected] of Object.entries(pins)) {
      if (
        !path.isAbsolute(file) ||
        /^[\\/]{2}/.test(file) ||
        !hex(expected) ||
        normalized.has(path.resolve(file).toLowerCase())
      )
        throw fail();
      normalized.set(path.resolve(file).toLowerCase(), expected);
    }
    const verify = () => {
      for (const file of Object.keys(require.cache)) {
        verifyPhysicalPath(file, false);
        if (normalized.get(path.resolve(file).toLowerCase()) !== sha(fs.readFileSync(file)))
          throw fail();
      }
    };
    verify();
    const adapter = createN09BusinessAdapter(
      {
        ownedRoot: options.ownedRoot,
        install: path.join(options.ownedRoot, 'payload'),
        manifestSha256: options.manifestSha256,
      },
      {
        spawn: createHostedLifecycleSpawn({
          ownedRoot: options.ownedRoot,
          manifestSha256: options.manifestSha256,
        }),
      }
    );
    adapters.push(adapter);
    active = adapter;
    listener = await createHostedListener({
      networkRoot: options.networkRoot,
      ownedNode: process.execPath,
      negativeAddress: options.negativeAddress,
      onBusinessRequest: (input) => {
        if (!active) throw fail();
        return active.onBusinessRequest(input);
      },
    });
    const state = listener.inspect();
    const proof = await runHostedProbes(
      {
        ownedNode: process.execPath,
        networkRoot: options.networkRoot,
        caSha256: options.caSha256,
        leafSha256: options.leafSha256,
        negativeAddress: state.negativeAddress,
        negativePort: state.negativePort,
      },
      listener
    );
    const controller = buildN09AckController({
      candidate: options.candidate,
      loadedPins: options.loadedPins,
      manifestSha256: options.manifestSha256,
      controller: buildHostedController({
        candidate: options.candidate,
        ownedRoot: options.ownedRoot,
        sourcePins: options.controllerPins,
        caSha256: options.caSha256,
      }),
    });
    const lifecycle = buildHostedLifecycle({
      ownedRoot: options.ownedRoot,
      candidate: options.candidate,
      gateSha256: options.controllerPins['context-recovery-daemon-start-gate.cjs'],
      sourcePins: options.lifecyclePins,
      controllerCopySha256: controller.copyPins['context-recovery-daemon-owned-controller.psm1'],
    });
    const verifyCopies = () => {
      for (const copies of [controller, lifecycle])
        for (const [name, expected] of Object.entries(copies.copyPins)) {
          const file = path.join(copies.outputRoot, name);
          verifyPhysicalPath(file, false);
          if (sha(fs.readFileSync(file)) !== expected) throw fail();
        }
      verify();
    };
    verifyCopies();
    adapter.bindVerifiedNetworkProof(proof);
    const committed = await runCommittedObservedKill(adapter);
    const committedEvidence = adapter.inspectBusinessEvidence();
    if (
      committedEvidence.seeded !== true ||
      committedEvidence.validatedReadCount !== 1 ||
      committedEvidence.publicGenerationCount !== 1 ||
      committedEvidence.clearAckCount !== 0 ||
      committedEvidence.externalToolExecutions !== 1
    )
      throw fail();
    active = undefined;
    // Each driver closes its adapter. A fresh closure owns the next synthetic
    // credential and lifecycle; the same listener stays under the original Job.
    const clearAdapter = createN09BusinessAdapter(
      {
        ownedRoot: options.ownedRoot,
        install: path.join(options.ownedRoot, 'payload'),
        manifestSha256: options.manifestSha256,
      },
      {
        spawn: createHostedLifecycleSpawn({
          ownedRoot: options.ownedRoot,
          manifestSha256: options.manifestSha256,
        }),
      }
    );
    adapters.push(clearAdapter);
    active = clearAdapter;
    verifyCopies();
    clearAdapter.bindVerifiedNetworkProof(proof);
    const clear = await runClearAfterAck(clearAdapter);
    const clearEvidence = clearAdapter.inspectBusinessEvidence();
    if (
      clearEvidence.seeded !== true ||
      clearEvidence.validatedReadCount !== 1 ||
      clearEvidence.publicGenerationCount !== 1 ||
      clearEvidence.clearAckCount !== 1 ||
      clearEvidence.externalToolExecutions !== 1
    )
      throw fail();
    active = undefined;
    verifyCopies();
    const durable = {},
      durableEvidence = {};
    for (const operation of ['save', 'revoke']) {
      const ownedAdapter = createN09BusinessAdapter(
        {
          ownedRoot: options.ownedRoot,
          install: path.join(options.ownedRoot, 'payload'),
          manifestSha256: options.manifestSha256,
        },
        {
          spawn: createHostedLifecycleSpawn({
            ownedRoot: options.ownedRoot,
            manifestSha256: options.manifestSha256,
          }),
        }
      );
      adapters.push(ownedAdapter);
      active = ownedAdapter;
      verifyCopies();
      ownedAdapter.bindVerifiedNetworkProof(proof);
      durable[operation] = await runDurableSaveOrRevokeAfterAck(ownedAdapter, operation);
      const evidence = ownedAdapter.inspectBusinessEvidence();
      if (
        evidence.seeded !== true ||
        evidence.externalToolExecutions !== 1 ||
        evidence.clearAckCount !== 0 ||
        evidence.saveAckCount !== (operation === 'save' ? 1 : 0) ||
        evidence.revokeAckCount !== (operation === 'revoke' ? 1 : 0) ||
        (operation === 'save'
          ? evidence.validatedReadCount < 2 || evidence.publicGenerationCount < 2
          : evidence.validatedReadCount !== 1 || evidence.publicGenerationCount !== 1)
      )
        throw fail();
      durableEvidence[operation] = evidence;
      active = undefined;
      verifyCopies();
    }
    result = {
      committed,
      clear,
      ...durable,
      businessEvidence: { committed: committedEvidence, clear: clearEvidence, ...durableEvidence },
      networkProof: proof,
      originalControllerReused: true,
      tlsValidationDisabled: false,
      remoteModelRequests: 0,
      n09Complete: false,
    };
  } catch {
    throw fail();
  } finally {
    active = undefined;
    cleanup = await closeResources(adapters, listener);
  }
  if (cleanup.adaptersClosed !== 4 || cleanup.listenerClosed !== true) throw fail();
  return Object.freeze({ ...result, cleanup });
}
module.exports = { composeHostedN09, closeResources };
