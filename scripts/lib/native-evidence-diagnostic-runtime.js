'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { hashFile } = require('./native-evidence-v2-preflight');
const { createNativeBenchmarkRequestBudget } = require('./native-benchmark-request-budget');
const { createNativeLoopbackRpc } = require('./native-loopback-rpc');
const {
  nativeEvidenceV2Thread,
  createNativeEvidenceV2Client,
} = require('./native-evidence-v2-client');
const { createNativeEvidenceV2Gateway } = require('./native-evidence-v2-gateway');
const {
  startIsolatedEvidenceProxy,
  stopNativeEvidenceChild,
  nativeEvidenceV2Routes,
} = require('./native-evidence-v2-runtime');
const {
  verifyNativeEvidenceDiagnosticPlan,
  createNativeEvidenceDiagnosticWorkload,
} = require('./native-evidence-diagnostic-plan');
const { withNativeEvidenceGuidance } = require('./native-evidence-guidance-workload');

const BASE_ENV = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT'];
const safeCode = (problem) =>
  typeof problem?.code === 'string' && /^native_[a-z0-9_]{1,80}$/.test(problem.code)
    ? problem.code
    : 'native_diagnostic_runtime_failed';

async function runNativeEvidenceDiagnostic(root, progress = () => {}, run = 'run1') {
  // A new one-shot diagnostic never relaxes or reuses paid pair authority.
  const plan = verifyNativeEvidenceDiagnosticPlan(root, run);
  const report = {
    schema: 'hpm.context.native-evidence-diagnostic',
    version: 1,
    diagnosticRun: run,
    model: 'gpt-5.6-sol',
    requestLimit: 6,
    automaticRetries: 0,
    phase: 'preflight',
    failureCode: null,
    diagnosticCompleted: false,
    fixturePreseededOriginals: true,
    originalCaptureIntegrationVerified: false,
    nativeSemanticAcceptanceVerified: false,
    priorPairVerdictChanged: false,
    installedClientConfigurationWritten: false,
    installedClientAuthReadByHarness: false,
    installedClientRolloutsRead: false,
    providerCredentialsCreatedOrCopied: false,
    productionRestarted: false,
    currentSessionSwitched: false,
    nativeEphemeralThreads: 0,
    realNativeClient: false,
    realProviderRequests: false,
    automaticThreshold: 4096,
    automaticThresholdScope: 'body_after_prefix',
    nativeCompactionCycles: 0,
    nativeCheckpointReused: false,
    nativeCheckpointItemEqual: false,
    checkpointChangedFieldNames: [],
    compactionChainReuseChecks: [],
    transport: [],
    turns: [],
    unsafeToolRequests: 0,
    toolFailureCount: 0,
    completedDynamicReadItems: 0,
    authorizationSha256: plan.authorizationSha256,
  };
  fs.writeFileSync(
    plan.attemptPath,
    JSON.stringify({
      schema: 'hpm.context.native-evidence-diagnostic-attempt',
      requestLimit: 6,
      authorizationSha256: plan.authorizationSha256,
      automaticRetries: 0,
    }),
    { flag: 'wx' }
  );
  const baseWorkload = createNativeEvidenceDiagnosticWorkload();
  const workload = run === 'run3' ? withNativeEvidenceGuidance(baseWorkload) : baseWorkload;
  if (run === 'run3') report.candidateWorkload = workload.descriptor;
  const budget = createNativeBenchmarkRequestBudget({
    priorRequests: plan.priorRequests,
    cumulativeLimit: plan.cumulativeLimit,
  });
  const prefix = 'hpm-v2-' + randomBytes(6).toString('hex');
  const ingressKey = randomBytes(24).toString('hex');
  const testKey = randomBytes(24).toString('hex');
  const selectEnv = () =>
    Object.fromEntries(
      BASE_ENV.filter((key) => process.env[key]).map((key) => [key, process.env[key]])
    );
  let proxy, gateway, child, rpc, directory;
  let closing = false;
  const phase = (name) => {
    report.phase = name;
    progress({ phase: name });
  };
  const noteFailure = (code) => {
    if (closing) return;
    report.failureCode ??= code;
    rpc?.close();
  };
  // Retained readers only: fixture seeding cannot grant access to original
  // execution or the state oracle, even if the model selects those tools.
  const originalReply = workload.reply;
  workload.reply = (name, args) =>
    ['hpm_list_retained_evidence', 'hpm_read_retained_evidence'].includes(name)
      ? originalReply(name, args)
      : { ok: false, code: 'diagnostic_original_tool_refused' };
  const client = createNativeEvidenceV2Client({ workload, report });
  try {
    const names = [
      'native-evidence-diagnostic-plan.js',
      'native-evidence-diagnostic-runtime.js',
      'native-evidence-v2-runtime.js',
      'native-evidence-v2-client.js',
      'native-evidence-v2-gateway.js',
      'native-evidence-v2-response.js',
      'native-evidence-v2-options.js',
      'native-loopback-rpc.js',
      'native-evidence-benchmark-workload-v2.js',
      'native-evidence-benchmark-workload.js',
    ];
    if (run === 'run3') names.push('native-evidence-guidance-workload.js');
    const snapshotDir = plan.reportPath.replace('-result.json', '-sources');
    fs.mkdirSync(snapshotDir);
    report.executedSources = names.map((name) => {
      const source = path.join(__dirname, name);
      fs.copyFileSync(source, path.join(snapshotDir, name), fs.constants.COPYFILE_EXCL);
      return { file: 'scripts/lib/' + name, sha256: hashFile(source) };
    });
    if (run === 'run3') {
      for (const name of [
        'context-evidence-native-tools.js',
        'context-evidence-native-delivery.js',
      ]) {
        const source = path.join(root, 'lib/client', name);
        fs.copyFileSync(source, path.join(snapshotDir, name), fs.constants.COPYFILE_EXCL);
        report.executedSources.push({ file: 'lib/client/' + name, sha256: hashFile(source) });
      }
    }
    phase('isolated_proxy_starting');
    proxy = await startIsolatedEvidenceProxy(root, plan.route, ingressKey, noteFailure);
    await proxy.ready();
    proxy.child.stdout.on('data', () => {});
    phase('isolated_proxy_ready');
    gateway = createNativeEvidenceV2Gateway({
      report,
      workload,
      budget,
      upstreamPort: proxy.port,
      ingressKey,
      testKey,
      prefix,
      onFailure: noteFailure,
    });
    const port = await new Promise((resolve, reject) => {
      gateway.server.once('error', () =>
        reject(
          Object.assign(new Error('Gateway failed'), { code: 'native_diagnostic_gateway_failed' })
        )
      );
      gateway.server.listen(0, '127.0.0.1', () => resolve(gateway.server.address().port));
    });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-diagnostic-client-'));
    const env = {
      ...selectEnv(),
      USERPROFILE: directory,
      HOME: directory,
      CODEX_HOME: path.join(directory, 'codex-home'),
      APPDATA: path.join(directory, 'appdata'),
      LOCALAPPDATA: path.join(directory, 'localappdata'),
      HPM_NATIVE_TEST_AUTH: testKey,
    };
    for (const key of ['CODEX_HOME', 'APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(env[key]);
    child = spawn(
      path.join(os.homedir(), 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe'),
      ['app-server', '--listen', 'stdio://'],
      { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    rpc = createNativeLoopbackRpc(child, {
      onFailure: noteFailure,
      onServerRequest: client.onServerRequest,
      onNotification: client.onNotification,
    });
    await rpc.call('initialize', {
      clientInfo: { name: 'hpm_native_diagnostic', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    report.realNativeClient = true;
    const start = await rpc.call(
      'thread/start',
      nativeEvidenceV2Thread(port, directory, workload.tools, 'compact')
    );
    if (start.thread?.ephemeral !== true)
      throw Object.assign(new Error('Isolation not confirmed'), {
        code: 'native_diagnostic_isolation_unconfirmed',
      });
    client.bind(start.thread.id);
    report.nativeEphemeralThreads = 1;
    phase('native_retained_read_diagnostic');
    const completion = rpc
      .waitFor('turn/completed', (p) => p?.threadId === start.thread.id, 120000)
      .then(
        (value) => ({ value }),
        (problem) => ({ problem })
      );
    await rpc.call('turn/start', {
      threadId: start.thread.id,
      input: [{ type: 'text', text: workload.prompts[0] }],
      effort: 'low',
    });
    const terminal = await completion;
    if (terminal.problem) throw terminal.problem;
    report.diagnosticCompleted =
      terminal.value.turn?.status === 'completed' &&
      report.completedDynamicReadItems === 1 &&
      report.toolFailureCount === 0 &&
      !report.failureCode;
  } catch (problem) {
    report.failureCode ??= safeCode(problem);
  } finally {
    closing = true;
    if (rpc) {
      report.rpc = rpc.inspect();
      rpc.close();
    }
    report.nativeProcessTerminal = await stopNativeEvidenceChild(child);
    if (gateway) {
      gateway.server.closeAllConnections();
      await new Promise((resolve) => gateway.server.close(resolve));
    }
    report.loopbackServerTerminal = !gateway || !gateway.server.listening;
    report.isolatedProxyTerminal = await stopNativeEvidenceChild(proxy?.child);
    Object.assign(
      report,
      nativeEvidenceV2Routes(proxy?.eventFile, prefix, report.transport.length)
    );
    try {
      report.guardedFilesUnchanged = plan.protectedFiles.every(
        (row) => hashFile(row.path) === row.sha256
      );
    } catch {
      report.guardedFilesUnchanged = false;
    }
    report.toolDiagnostics = workload.diagnostics();
    report.exactRetainedEvidenceEnteringInput = new Set(
      report.transport
        .flatMap((row) => row.exactRetainedEvidence)
        .filter((row) => row?.observed)
        .map((row) => row.index)
    ).size;
    report.diagnosticCompleted &&=
      report.exactRetainedEvidenceEnteringInput === 1 &&
      report.toolDiagnostics.evidenceTools.calls === 2 &&
      report.toolDiagnostics.evidenceTools.successfulReads === 1 &&
      report.unsafeToolRequests === 0 &&
      report.providerRouteVerified === true &&
      report.transport.every(
        (row) =>
          row.status === 200 && row.responseCompletedEvents === 1 && row.responseFailedEvents === 0
      );
    report.toolConcurrency = client.inspect();
    report.requestBudget = budget.inspect();
    report.phase = 'terminal';
    report.isolatedDirectoriesRemoved = true;
    for (const [candidate, expectedPrefix, stopped] of [
      [directory, 'hpm-native-diagnostic-client-', report.nativeProcessTerminal],
      [proxy?.directory, 'hpm-native-v2-proxy-', report.isolatedProxyTerminal],
    ]) {
      if (!candidate) continue;
      if (
        !stopped ||
        path.dirname(candidate) !== os.tmpdir() ||
        !path.basename(candidate).startsWith(expectedPrefix)
      ) {
        report.isolatedDirectoriesRemoved = false;
        continue;
      }
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
      } catch {
        report.isolatedDirectoriesRemoved = false;
      }
    }
    if (
      !report.nativeProcessTerminal ||
      !report.isolatedProxyTerminal ||
      !report.loopbackServerTerminal ||
      !report.guardedFilesUnchanged ||
      !report.isolatedDirectoriesRemoved
    ) {
      report.failureCode ??= 'native_diagnostic_cleanup_unconfirmed';
      report.diagnosticCompleted = false;
    }
    workload.close();
    if (!report.diagnosticCompleted) report.failureCode ??= 'native_diagnostic_incomplete';
    fs.writeFileSync(plan.reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    progress({
      phase: 'terminal',
      diagnosticCompleted: report.diagnosticCompleted,
      failureCode: report.failureCode,
      requests: report.transport.length,
    });
  }
  return report;
}

module.exports = { runNativeEvidenceDiagnostic };
