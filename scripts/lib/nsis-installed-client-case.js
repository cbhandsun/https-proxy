'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { runInstalledCodexCase, createCodexSyntheticSource } = require('./nsis-client-codex');
const { runInstalledClaudeCase } = require('./nsis-client-claude');
const { createCodexSyntheticUpstream } = require('./nsis-client-codex-upstream');
const { createClaudeSyntheticUpstream } = require('./nsis-client-claude-upstream');
const { createInstalledClientSpawn } = require('./nsis-client-owned-transport');
const { requestInstalledClientObservation } = require('./nsis-client-observer.cjs');
const { configureInstalledClient } = require('./nsis-client-configuration');
const { assertEntryRefuses, createSyntheticSourceServer } = require('./nsis-client-loopback');
const fail = () => new Error('installed_client_case_failed');
function zeroRecovery(state) {
  return (
    state.roots === 0 &&
    state.snapshots === 0 &&
    state.enabled === false &&
    state.closed === false &&
    state.factoryCalls >= 1
  );
}
async function runInstalledClientCase(options) {
  const {
    client,
    mode,
    owner,
    adapter,
    ownedRoot,
    install,
    manifestSha256,
    binarySha256,
    powershellExecutable,
    token,
    active,
    onPhase,
  } = options;
  const label = client + '-' + mode;
  const phase = (suffix) => onPhase(label + '-' + suffix);
  const nonce = randomBytes(16).toString('hex');
  const source =
    client === 'codex'
      ? createCodexSyntheticSource(nonce)
      : {
          marker: 'HPM_PRIVATE_' + nonce,
          text:
            'Synthetic original Unicode 中文🙂\r\n' +
            nonce.repeat(180) +
            '\r\nREQUIRED_MARKER=HPM_PRIVATE_' +
            nonce,
        };
  const model = 'hpm-installed-' + client;
  const entryToken = 'hpm-synthetic-' + randomBytes(16).toString('hex');
  const upstreamToken = 'hpm-upstream-' + randomBytes(16).toString('hex');
  const upstream = (
    client === 'codex' ? createCodexSyntheticUpstream : createClaudeSyntheticUpstream
  )({ mode, model, original: source.text, marker: source.marker });
  const caseRoot = path.join(ownedRoot, 'cases', 'client-' + label);
  fs.mkdirSync(caseRoot);
  let sequence = 0,
    sourceServer,
    observed,
    failed = false,
    receipt;
  const observe = async () => {
    if (!(await owner.isAlive()) || !adapter.verifyOwnedIdentity(owner)) throw fail();
    const result = await requestInstalledClientObservation({
      caseRoot: path.dirname(owner.identity.configDir),
      install,
      token,
      pid: owner.identity.pid,
      manifestSha256,
      sequence: ++sequence,
    });
    if (mode === 'default' && !zeroRecovery(result)) throw fail();
    observed = result;
    return result;
  };
  active.current = { client, mode, upstreamToken, upstream, observe };
  try {
    phase('configure');
    await configureInstalledClient(owner, { client, mode, entryToken, upstreamToken });
    phase('auth');
    await assertEntryRefuses(owner, client, model);
    const before = upstream.inspect();
    if (before.failed || (before.requests ?? before.requestCount) !== 0) throw fail();
    await observe();
    if (client === 'claude')
      sourceServer = await createSyntheticSourceServer(source.text, () =>
        upstream.recordSourceCall()
      );
    const spawnOwned = createInstalledClientSpawn({
      ownedRoot,
      caseRoot,
      client,
      manifestSha256,
      binarySha256,
      powershellExecutable,
    });
    const entryUrl = 'http://127.0.0.1:' + owner.identity.entryPort;
    phase('cli');
    const protocol =
      client === 'codex'
        ? await runInstalledCodexCase({
            caseRoot,
            mode,
            entryUrl: entryUrl + '/v1',
            model,
            entryToken,
            sourceTool: { nonce },
            spawnOwned,
            onProgress: ({ phase }) => upstream.setPhase(phase),
          })
        : await runInstalledClaudeCase({
            caseRoot,
            mode,
            entryUrl,
            model,
            entryToken,
            marker: source.marker,
            sourceUrl: sourceServer.url,
            sourceTool: path.join(__dirname, 'nsis-client-source.cjs'),
            cliPath: path.join(ownedRoot, 'clients/claude.exe'),
            nodePath: path.join(install, 'runtime/node/node.exe'),
            spawnOwned,
            onProgress: ({ phase }) => upstream.setPhase(phase),
            inspectWitness: async () => {
              const state = upstream.inspect();
              const sample = await observe();
              return {
                ...state,
                defaultZeroRecovery: mode === 'default' && zeroRecovery(sample),
                fullCoreEntrypointVerified: adapter.verifyOwnedIdentity(owner),
              };
            },
          });
    phase('observe');
    await observe();
    const state = upstream.inspect();
    if (client === 'codex') {
      if (
        protocol.exactFinalAnswer !== true ||
        protocol.compactions !== 3 ||
        !state.completed ||
        state.failed ||
        !state.sourceObserved ||
        state.sourceCalls !== 1 ||
        state.compactions + state.summaries !== 3 ||
        (mode === 'enhanced' && (!state.exactRead || !state.publicEvidence)) ||
        (mode === 'default' && (state.exactRead || state.publicEvidence || state.readPages !== 0))
      )
        throw fail();
    } else if (
      protocol.protocolPassed !== true ||
      !state.complete ||
      !state.allRequestsStreaming ||
      (mode === 'default' && !state.defaultNoPrivateTools) ||
      state.failed ||
      state.sourceCalls !== 1 ||
      state.classifiedCompactions !== 3 ||
      sourceServer.inspect().failed ||
      sourceServer.inspect().calls !== 1 ||
      (mode === 'enhanced' &&
        (!state.exactPrivateRead ||
          !state.independentPublicGeneration ||
          !state.exactAuthorizedEvidenceInPublicRequest))
    )
      throw fail();
    if (mode === 'default' && !zeroRecovery(observed)) throw fail();
    receipt = {
      client,
      mode,
      compactions: 3,
      exactFinalAnswer: true,
      defaultZeroRecovery: mode === 'default',
      privateRead: mode === 'enhanced',
      publicGeneration: mode === 'enhanced',
    };
  } catch {
    failed = true;
  } finally {
    active.current = null;
    if (sourceServer) {
      try {
        if ((await sourceServer.close()) !== true) failed = true;
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw fail();
  return receipt;
}
module.exports = { runInstalledClientCase, zeroRecovery };
