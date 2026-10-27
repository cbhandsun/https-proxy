'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createInstalledWebSocketListener } = require('./nsis-installed-websocket-listener');
const { parseInstalledWebSocketDrainEvidence } = require('./nsis-installed-websocket-drain');
const { runHostedProbes } = require('../context-hosted/shared/hosted-probes');
const {
  INSTALLED_CLIENT_PROTOCOLS,
  buildInstalledClientController,
  createInstalledControllerSpawn,
} = require('./nsis-client-controller');
const { startDaemonOwnedController } = require('./context-recovery-daemon-owned-transport');
const { createDaemonOwnedAdapter } = require('./context-recovery-daemon-owned-adapter');
const { createDaemonManagementHttpClient } = require('./context-recovery-daemon-http-client');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const {
  exerciseInstalledHttpSseWebSocketDrain,
  httpDrainFailurePhase,
} = require('./nsis-installed-http-drain');
const { writeInstalledBusinessReply } = require('./nsis-installed-business-reply');
const { runInstalledClientCase } = require('./nsis-installed-client-case');
const {
  parseInstalledClientMatrixArguments,
  verifyInstalledClientMatrixIdentity,
  createMatrixPhaseWriter,
} = require('./nsis-installed-client-matrix-contract');
const { digestInstalledClient } = require('./nsis-client-binary');
const fail = () => new Error('installed_client_matrix_failed');
function negativeAddress() {
  const values = Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (item) =>
        item &&
        item.family === 'IPv4' &&
        !item.internal &&
        /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address)
    )
    .map((item) => item.address)
    .sort();
  if (!values.length) throw fail();
  return values[0];
}
function matrixCase(input, client, mode) {
  if (
    !input ||
    Object.keys(input).sort().join(',') !==
      'client,compactions,defaultZeroRecovery,exactFinalAnswer,mode,privateRead,publicGeneration,restartRetention' ||
    input.client !== client ||
    input.mode !== mode ||
    input.compactions !== 3 ||
    input.exactFinalAnswer !== true ||
    input.defaultZeroRecovery !== (mode === 'default') ||
    input.privateRead !== (mode === 'enhanced') ||
    input.publicGeneration !== (mode === 'enhanced') ||
    input.restartRetention !== true
  )
    throw fail();
  return { ...input };
}
function createBusinessHandler(active, reject) {
  let pending = 0;
  return {
    async respond(event) {
      pending++;
      try {
        const current = active.current;
        if (!current || !Buffer.isBuffer(event.bytes) || event.bytes.length > 262144) throw fail();
        const codex = current.client === 'codex';
        if (
          codex
            ? !['/v1/responses', '/v1/responses/compact'].includes(event.path) ||
              event.authorization !== 'Bearer ' + current.upstreamToken ||
              event.apiKey !== undefined
            : !['/v1/messages', '/v1/messages?beta=true'].includes(event.path) ||
              event.apiKey !== current.upstreamToken ||
              event.authorization !== undefined
        )
          throw fail();
        if (current.mode === 'default') await current.observe();
        if (active.current !== current) throw fail();
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.bytes));
        const reply = current.upstream.respond({ path: event.path, body });
        if (
          !reply ||
          reply.statusCode !== 200 ||
          !Buffer.isBuffer(reply.wire) ||
          reply.wire.length > 2097152 ||
          !['application/json; charset=utf-8', 'text/event-stream; charset=utf-8'].includes(
            reply.contentType
          ) ||
          event.response.destroyed
        )
          throw fail();
        await writeInstalledBusinessReply(active, current, event.response, reply);
      } catch {
        reject();
        event.response.destroy();
      } finally {
        pending--;
      }
    },
    inspect: () => ({ pending }),
  };
}
const defaults = {
  verify: verifyInstalledClientMatrixIdentity,
  phaseWriter: createMatrixPhaseWriter,
  address: negativeAddress,
  listener: createInstalledWebSocketListener,
  probes: runHostedProbes,
  controller(options) {
    const controller = buildInstalledClientController(options);
    const start = createInstalledControllerSpawn({ ...options, controller });
    return startDaemonOwnedController(
      {
        install: options.install,
        ownedRoot: options.ownedRoot,
        manifestSha256: options.manifestSha256,
        powershellExecutable: options.powershellExecutable,
      },
      start
    );
  },
  adapter(request, channel, token) {
    return createDaemonOwnedAdapter(
      {
        install: request.install,
        ownedRoot: request.ownedRoot,
        initialEntryProtocols: INSTALLED_CLIENT_PROTOCOLS,
      },
      channel,
      {
        now: () => performance.now(),
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        token,
        client: createDaemonManagementHttpClient,
      }
    );
  },
  runCase: runInstalledClientCase,
  drain: exerciseInstalledHttpSseWebSocketDrain,
  verifyBinary: (file, sha, client) => digestInstalledClient(file, client) === sha,
};
// Test dependencies are available only to direct module callers, never argv.
async function runInstalledClientMatrix(args, dependencies = defaults) {
  let listener, channel, adapter, writer, business, request, proof;
  let phase = 'identity',
    failedPhase,
    failed = false,
    naturalExits = 0,
    owner;
  const active = { current: null },
    cases = [],
    websocketDrains = [];
  const reject = () => {
    failed = true;
    failedPhase ??= phase;
  };
  const mark = (next) => {
    phase = next;
    writer(next, false);
  };
  try {
    request = parseInstalledClientMatrixArguments(args);
    const identity = dependencies.verify(request);
    writer = dependencies.phaseWriter(request.ownedRoot);
    mark('identity');
    const casesRoot = path.join(request.ownedRoot, 'cases');
    fs.mkdirSync(casesRoot);
    mark('listener');
    const address = dependencies.address();
    business = createBusinessHandler(active, reject);
    listener = await dependencies.listener({
      networkRoot: request.networkRoot,
      ownedNode: identity.node,
      negativeAddress: address,
      onBusinessRequest: (event) => business.respond(event),
      prepareUpgrade(event) {
        const current = active.current;
        if (current?.client !== 'codex' || typeof current.prepareUpgrade !== 'function')
          throw fail();
        return current.prepareUpgrade(event);
      },
    });
    const view = listener.inspect();
    mark('probes');
    proof = await dependencies.probes(
      {
        ownedNode: identity.node,
        networkRoot: request.networkRoot,
        caSha256: request.caSha256,
        leafSha256: request.leafSha256,
        negativeAddress: address,
        negativePort: view.negativePort,
      },
      listener
    );
    if (
      ['probesPassed', 'tlsVerified', 'nonLoopbackBlocked', 'listenerOwned'].some(
        (key) => proof?.[key] !== true
      )
    )
      throw fail();
    mark('controller');
    channel = dependencies.controller({ ...identity, ...request });
    let token;
    adapter = dependencies.adapter(request, channel, () => token);
    let index = 0;
    for (const client of ['codex', 'claude']) {
      for (const mode of ['default', 'enhanced']) {
        if (
          failed ||
          !dependencies.verifyBinary(
            path.join(request.ownedRoot, 'clients', client + '.exe'),
            request[client + 'Sha256'],
            client
          )
        )
          throw fail();
        token = randomBytes(24).toString('base64url');
        mark(client + '-' + mode + '-configure');
        owner = await adapter.launch({
          label: ['00', '01', '10', '11'][index++],
          initialEnabled: false,
          initialPersistence: false,
        });
        let drainCalls = 0,
          drained = false;
        try {
          const value = await dependencies.runCase({
            client,
            mode,
            owner,
            adapter,
            ownedRoot: request.ownedRoot,
            install: request.install,
            manifestSha256: request.manifestSha256,
            binarySha256: request[client + 'Sha256'],
            powershellExecutable: identity.powershellExecutable,
            token,
            active,
            onPhase: mark,
            onReadyToStop: async (input, observe) => {
              if (++drainCalls !== 1 || failed || !adapter.verifyOwnedIdentity(owner)) throw fail();
              const options = dataSnapshot(input, 'installed_client_matrix_failed');
              if (options.client !== client || options.mode !== mode) throw fail();
              mark(client + '-' + mode + '-stop');
              let exited;
              try {
                exited = dataSnapshot(
                  await dependencies.drain(options, { owner, adapter, active, observe }),
                  'installed_client_matrix_failed'
                );
              } catch (error) {
                const failure = httpDrainFailurePhase(error);
                if (failure) {
                  const stopPhase = client + '-' + mode + '-stop';
                  mark(client + '-' + mode + '-http-drain-' + failure);
                  // The business handler can fail first while this drain is
                  // active. Refine only that same coarse phase; never replace
                  // an earlier failure from a different operation or cleanup.
                  if (failedPhase === stopPhase) failedPhase = phase;
                }
                throw fail();
              }
              if (
                Object.keys(exited).sort().join(',') !==
                  'cleanupSemantics,exitCode,httpTransportDrainQualified,sseTransportDrainQualified,treeEmpty' +
                    (client === 'codex' ? ',websocketDrain,websocketDrainQualified' : '') ||
                exited.treeEmpty !== true ||
                exited.cleanupSemantics !== 'natural_exit' ||
                exited.exitCode !== 0 ||
                exited.httpTransportDrainQualified !== true ||
                exited.sseTransportDrainQualified !== true
              )
                throw fail();
              if (client === 'codex') {
                if (exited.websocketDrainQualified !== true) throw fail();
                websocketDrains.push({
                  client,
                  mode,
                  ...parseInstalledWebSocketDrainEvidence(exited.websocketDrain),
                });
              }
              naturalExits++;
              drained = true;
            },
          });
          if (
            failed ||
            active.current !== null ||
            business.inspect().pending !== 0 ||
            drainCalls !== 1 ||
            !drained
          )
            throw fail();
          cases.push(matrixCase(value, client, mode));
        } catch {
          reject();
        } finally {
          try {
            mark(client + '-' + mode + '-stop');
          } catch {
            reject();
          }
          const stopping = owner;
          owner = null;
          try {
            if (!drained && (await stopping.stop()) !== true) reject();
          } catch {
            reject();
          }
        }
      }
    }
  } catch {
    reject();
  } finally {
    try {
      if (writer) mark('cleanup');
    } catch {
      reject();
    }
    if (owner) {
      try {
        if ((await owner.stop()) !== true) reject();
      } catch {
        reject();
      }
    }
    try {
      if (adapter ? (await adapter.close()) !== true : channel && (await channel.close()) !== true)
        reject();
    } catch {
      reject();
    }
    try {
      if (listener && (await listener.close()) !== true) reject();
    } catch {
      reject();
    }
    if (business && business.inspect().pending !== 0) reject();
    try {
      if (writer) writer(failed ? failedPhase || 'cleanup' : 'complete', failed);
    } catch {
      reject();
    }
  }
  if (failed || cases.length !== 4 || naturalExits !== 4 || websocketDrains.length !== 2)
    throw fail();
  return {
    schemaVersion: 7,
    scope: 'installed_native_cli_four_cases',
    passed: true,
    syntheticClientQualified: true,
    realProviderQualified: false,
    retention24hQualified: false,
    realModelRequests: 0,
    ...proof,
    ownedTreeEmpty: true,
    daemonNaturalExitQualified: true,
    httpTransportDrainQualified: true,
    sseTransportDrainQualified: true,
    websocketDrainQualified: true,
    websocketDrains,
    syntheticSocketsClosed: true,
    cases,
  };
}
module.exports = { runInstalledClientMatrix, createBusinessHandler, matrixCase };
