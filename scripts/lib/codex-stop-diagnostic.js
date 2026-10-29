'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const {
  parseInstalledClientMatrixArguments,
  verifyInstalledClientMatrixIdentity,
  createMatrixPhaseWriter,
} = require('./nsis-installed-client-matrix-contract');
const { createInstalledClientListener } = require('../context-hosted/shared/hosted-listener');
const { runHostedProbes } = require('../context-hosted/shared/hosted-probes');
const {
  buildInstalledClientController,
  createInstalledControllerSpawn,
  INSTALLED_CLIENT_PROTOCOLS,
} = require('./nsis-client-controller');
const { startDaemonOwnedController } = require('./context-recovery-daemon-owned-transport');
const { createDaemonOwnedAdapter } = require('./context-recovery-daemon-owned-adapter');
const { createDaemonManagementHttpClient } = require('./context-recovery-daemon-http-client');
const { runInstalledClientCase } = require('./nsis-installed-client-case');
const { writeInstalledBusinessReply } = require('./nsis-installed-business-reply');
const { ownedStopFailure, OWNED_STOP_PHASES } = require('./nsis-client-owned-failure');
const { diagnosticPolicy } = require('./staged-client-diagnostic-policy');
const fail = () => new Error('codex_stop_diagnostic_failed');
function negativeAddress() {
  const value = Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .find(
      (item) =>
        item.family === 'IPv4' &&
        !item.internal &&
        /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address)
    );
  if (!value) throw fail();
  return value.address;
}
function businessHandler(active, reject, client = 'codex') {
  const policy = diagnosticPolicy(client);
  let pending = 0;
  return {
    async respond(event) {
      pending++;
      try {
        const current = active.current;
        if (
          !current ||
          current.client !== client ||
          current.mode !== 'enhanced' ||
          !Buffer.isBuffer(event.bytes) ||
          event.bytes.length > 262144 ||
          !policy.paths.includes(event.path) ||
          (client === 'codex'
            ? event.authorization !== 'Bearer ' + current.upstreamToken ||
              event.apiKey !== undefined
            : event.apiKey !== current.upstreamToken || event.authorization !== undefined)
        )
          throw fail();
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.bytes));
        const reply = current.upstream.respond({ path: event.path, body });
        if (
          active.current !== current ||
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
    pending: () => pending,
  };
}
const defaults = {
  verify: verifyInstalledClientMatrixIdentity,
  writer: createMatrixPhaseWriter,
  address: negativeAddress,
  listener: createInstalledClientListener,
  probes: runHostedProbes,
  controller(input) {
    const controller = buildInstalledClientController(input);
    return startDaemonOwnedController(
      {
        install: input.install,
        ownedRoot: input.ownedRoot,
        manifestSha256: input.manifestSha256,
        powershellExecutable: input.powershellExecutable,
      },
      createInstalledControllerSpawn({ ...input, controller })
    );
  },
  adapter(input, channel, token) {
    return createDaemonOwnedAdapter(
      {
        install: input.install,
        ownedRoot: input.ownedRoot,
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
};
async function runStagedClientDiagnostic(args, client, dependencies = defaults) {
  const policy = diagnosticPolicy(client);
  let owner, channel, adapter, listener, writer, business, proof;
  let phase = 'identity',
    failedPhase,
    failureCode = null,
    failed = false;
  let complete = false,
    ownedTreeEmpty = true,
    socketsClosed = true;
  const active = { current: null };
  const reject = () => {
    failed = true;
    failedPhase ??= phase;
  };
  const mark = (next) => {
    phase = next;
    writer(next, false);
  };
  try {
    const request = parseInstalledClientMatrixArguments(args);
    const identity = dependencies.verify(request);
    writer = dependencies.writer(request.ownedRoot);
    fs.mkdirSync(path.join(request.ownedRoot, 'cases'));
    mark('listener');
    const address = dependencies.address();
    business = businessHandler(active, reject, client);
    socketsClosed = false;
    listener = await dependencies.listener({
      networkRoot: request.networkRoot,
      ownedNode: identity.node,
      negativeAddress: address,
      onBusinessRequest: business.respond,
    });
    mark('probes');
    proof = await dependencies.probes(
      {
        ownedNode: identity.node,
        networkRoot: request.networkRoot,
        caSha256: request.caSha256,
        leafSha256: request.leafSha256,
        negativeAddress: address,
        negativePort: listener.inspect().negativePort,
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
    ownedTreeEmpty = false;
    channel = dependencies.controller({ ...identity, ...request });
    const token = randomBytes(24).toString('base64url');
    adapter = dependencies.adapter(request, channel, () => token);
    // The original controller starts at label 00; the unchanged case helper then
    // explicitly configures enhanced persistence. No preceding default CLI is run.
    owner = await adapter.launch({ label: '00', initialEnabled: false, initialPersistence: false });
    const result = await dependencies.runCase({
      client,
      mode: 'enhanced',
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
      onReadyToStop: async () => {},
    });
    if (
      failed ||
      active.current !== null ||
      business.pending() !== 0 ||
      result?.compactions !== 3 ||
      result.exactFinalAnswer !== true ||
      result.privateRead !== true ||
      result.publicGeneration !== true ||
      result.restartRetention !== true
    )
      throw fail();
    complete = true;
  } catch (error) {
    const code = ownedStopFailure(error);
    if (
      client === 'codex' &&
      code &&
      phase === 'codex-enhanced-cli-restart-stop' &&
      (!failedPhase || failedPhase === phase)
    ) {
      const suffix = 'restart-stop-' + code.slice('nsis_owned_stop_'.length).replaceAll('_', '-');
      if (OWNED_STOP_PHASES.includes(suffix)) {
        failureCode = code;
        try {
          const coarse = phase;
          mark('codex-enhanced-cli-' + suffix);
          if (failedPhase === coarse) failedPhase = phase;
        } catch {
          reject();
        }
      }
    }
    reject();
  } finally {
    if (!failed && writer) {
      try {
        mark('cleanup');
      } catch {
        reject();
      }
    }
    if (owner) {
      try {
        if ((await owner.stop()) !== true) reject();
      } catch {
        reject();
      }
    }
    if (adapter || channel) {
      try {
        ownedTreeEmpty = (await (adapter ? adapter.close() : channel.close())) === true;
        if (!ownedTreeEmpty) reject();
      } catch {
        ownedTreeEmpty = false;
        reject();
      }
    }
    if (listener) {
      try {
        socketsClosed = (await listener.close()) === true;
        if (!socketsClosed) reject();
      } catch {
        socketsClosed = false;
        reject();
      }
    }
    if (business && business.pending() !== 0) reject();
    if (writer) {
      try {
        writer(failed ? failedPhase : 'complete', failed);
      } catch {
        reject();
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    scope: policy.scope,
    diagnosticPassed: complete && !failed,
    failedPhase: failed ? failedPhase : null,
    failureCode,
    ownedTreeEmpty,
    syntheticSocketsClosed: socketsClosed,
    installedQualified: false,
    realProvider: false,
    retention24hQualified: false,
    modelRequests: 0,
    probesPassed: proof?.probesPassed === true,
    tlsVerified: proof?.tlsVerified === true,
    nonLoopbackBlocked: proof?.nonLoopbackBlocked === true,
    listenerOwned: proof?.listenerOwned === true,
  });
}
function runCodexStopDiagnostic(args, dependencies) {
  return runStagedClientDiagnostic(args, 'codex', dependencies);
}
module.exports = { runCodexStopDiagnostic, runStagedClientDiagnostic, businessHandler };
