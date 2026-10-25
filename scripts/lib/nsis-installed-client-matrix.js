'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createInstalledClientListener } = require('../context-hosted/shared/hosted-listener');
const { runHostedProbes } = require('../context-hosted/shared/hosted-probes');
const {
  INSTALLED_CLIENT_PROTOCOLS,
  buildInstalledClientController,
  createInstalledControllerSpawn,
} = require('./nsis-client-controller');
const { startDaemonOwnedController } = require('./context-recovery-daemon-owned-transport');
const { createDaemonOwnedAdapter } = require('./context-recovery-daemon-owned-adapter');
const { createDaemonManagementHttpClient } = require('./context-recovery-daemon-http-client');
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
        event.response.writeHead(200, { 'content-type': reply.contentType, connection: 'close' });
        event.response.end(reply.wire);
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
  listener: createInstalledClientListener,
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
  verifyBinary: (file, sha, client) => digestInstalledClient(file, client) === sha,
};
// Test dependencies are available only to direct module callers, never argv.
async function runInstalledClientMatrix(args, dependencies = defaults) {
  let listener, channel, adapter, writer, business, request, proof;
  let phase = 'identity',
    failedPhase,
    failed = false,
    owner;
  const active = { current: null },
    cases = [];
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
          });
          if (
            failed ||
            active.current !== null ||
            business.inspect().pending !== 0 ||
            !adapter.verifyOwnedIdentity(owner)
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
            if ((await stopping.stop()) !== true) reject();
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
  if (failed || cases.length !== 4) throw fail();
  return {
    schemaVersion: 3,
    scope: 'installed_native_cli_four_cases',
    passed: true,
    syntheticClientQualified: true,
    realProviderQualified: false,
    retention24hQualified: false,
    realModelRequests: 0,
    ...proof,
    ownedTreeEmpty: true,
    syntheticSocketsClosed: true,
    cases,
  };
}
module.exports = { runInstalledClientMatrix, createBusinessHandler, matrixCase };
