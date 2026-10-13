'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createIsolatedTestEnv } = require('../../lib/test-runtime');
const { findAvailablePorts } = require('../../test/helpers/test-ports');
const { prepareProxyFixtureSecret } = require('../../test/helpers/proxy-fixture-secret');
const { waitForProxyFixtureReady } = require('../../test/helpers/proxy-fixture-ready');
const { createNativeLoopbackRpc } = require('./native-loopback-rpc');
const { createNativeBenchmarkRequestBudget } = require('./native-benchmark-request-budget');
const {
  createNativeEvidenceBenchmarkWorkloadV2,
} = require('./native-evidence-benchmark-workload-v2');
const { verifyNativeEvidenceV2Preflight, hashFile } = require('./native-evidence-v2-preflight');
const { createNativeEvidenceV2Gateway } = require('./native-evidence-v2-gateway');
const {
  createNativeEvidenceV2Client,
  nativeEvidenceV2Thread,
} = require('./native-evidence-v2-client');
const { summarizeNativeEvidenceV2 } = require('./native-evidence-v2-summary');

const BASE_ENV = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT'];
const fail = (code) => Object.assign(new Error('Isolated native evidence run failed'), { code });
const safeCode = (problem) =>
  typeof problem?.code === 'string' && /^native_[a-z0-9_]{1,80}$/.test(problem.code)
    ? problem.code
    : 'native_v2_runtime_failed';
const selectEnv = (names) =>
  Object.fromEntries(names.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));

async function stopNativeEvidenceChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  let timer;
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  if (child.stdin?.writable) child.stdin.end();
  child.kill();
  const result = await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

function nativeEvidenceV2Routes(file, prefix, requestCount) {
  if (!file || !fs.existsSync(file) || fs.statSync(file).size > 2 * 1024 * 1024)
    return { providerRouteVerified: false, verifiedRouteCount: 0 };
  const routes = new Set();
  let wrong = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    } // A partial line is not route proof.
    if (
      row.kind !== 'route' ||
      typeof row.reqId !== 'string' ||
      !row.reqId.startsWith(prefix + '-')
    )
      continue;
    const index = row.reqId.slice(prefix.length + 1);
    if (
      row.profileId !== 'openai-official' ||
      !/^[1-9]\d*$/.test(index) ||
      Number(index) > requestCount
    )
      wrong = true;
    routes.add(row.reqId);
  }
  return {
    providerRouteVerified: !wrong && requestCount > 0 && routes.size === requestCount,
    verifiedRouteCount: routes.size,
  };
}

async function startIsolatedEvidenceProxy(root, route, ingressKey, failure) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-v2-proxy-'));
  const env = createIsolatedTestEnv(
    selectEnv([
      ...BASE_ENV,
      'USERPROFILE',
      'HOME',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
    ]),
    directory
  );
  const [port, managementPort] = await findAvailablePorts(2);
  Object.assign(env, { MGMT_PORT: String(managementPort), PROXY_DISABLE_CONVERSATION_AUDIT: '1' });
  const secret = prepareProxyFixtureSecret(env, ingressKey);
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'openai-official',
      localServer: {
        host: '127.0.0.1',
        listenPort: port,
        managementPort,
        basePath: '/v1',
        protocol: 'openai-responses',
      },
      entryServers: [
        {
          host: '127.0.0.1',
          listenPort: port,
          basePath: '/v1',
          protocol: 'openai-responses',
          tls: false,
          enabled: true,
        },
      ],
      profiles: [route.profile],
      modelRoutes: [route.route],
      entryAuth: {
        enabled: true,
        keys: [
          { id: 'isolated', key: secret, enabled: true, allowedProfileIds: ['openai-official'] },
        ],
      },
      appSettings: {
        conversationAuditEnabled: false,
        conversationAuditCaptureContent: false,
        forceResponseStreaming: false,
      },
    }),
    { flag: 'wx' }
  );
  const child = spawn(process.execPath, [path.join(root, 'openai-proxy.js')], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', () => failure('native_v2_proxy_spawn_failed'));
  child.stderr.on('data', () => {});
  return {
    child,
    directory,
    port,
    eventFile: path.join(env.PROXY_RUNTIME_DIR, 'proxy-events.jsonl'),
    ready: () =>
      waitForProxyFixtureReady(child, {
        setTimer: (callback, ms) => setTimeout(callback, ms === 15000 ? 90000 : ms),
      }),
  };
}

async function runNativeEvidenceV2(root, arm, progress = () => {}) {
  const workload = createNativeEvidenceBenchmarkWorkloadV2();
  // No process, socket or real provider call can occur before authorization,
  // immutable prior evidence and installed-config protections are verified.
  let plan;
  try {
    plan = verifyNativeEvidenceV2Preflight(root, arm, workload.descriptor.corpusSha256);
  } catch (problem) {
    workload.close();
    throw problem;
  }
  const report = {
    schema: 'hpm.context.native-evidence-v2-candidate',
    version: 2,
    benchmarkArm: arm,
    syntheticWorkload: true,
    fixedWorkload: workload.descriptor,
    model: 'gpt-5.6-sol',
    phase: 'preflight',
    passed: false,
    failureCode: null,
    automaticRetries: 0,
    requestLimit: 30,
    uniformToolReplyDelayMs: 100,
    executedSources: [
      'native-evidence-v2-runtime.js',
      'native-evidence-v2-client.js',
      'native-evidence-v2-gateway.js',
      'native-evidence-v2-preflight.js',
      'native-evidence-v2-response.js',
      'native-evidence-v2-summary.js',
      'native-evidence-v2-options.js',
      'native-loopback-rpc.js',
      'native-evidence-benchmark-workload-v2.js',
    ].map((name) => ({
      file: 'scripts/lib/' + name,
      sha256: hashFile(path.join(__dirname, name)),
    })),
    authorizationSha256: plan.authorizationSha256,
    preservedControlSha256: plan.controlSha256,
    installedClientConfigurationWritten: false,
    installedClientAuthReadByHarness: false,
    installedClientRolloutsRead: false,
    currentSessionSwitched: false,
    productionRestarted: false,
    realNativeClient: false,
    realProviderRequests: false,
    nativeEphemeralThreads: 0,
    compactionInvoker: 'native-auto-threshold',
    manualCompactionRpcCalls: 0,
    automaticThreshold: arm === 'compact' ? 4096 : 1000000,
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
    finalStateCorrect: false,
    providerBilling: 'not-verified',
  };
  // Claim the one authorized attempt before calls. A crash cannot silently turn
  // a missing terminal report into permission to run another paid pair.
  fs.writeFileSync(
    plan.reportPath.replace('-result.json', '-attempt.json'),
    JSON.stringify({
      schema: 'hpm.context.native-evidence-v2-attempt',
      arm,
      requestLimit: 30,
      authorizationSha256: plan.authorizationSha256,
      candidateSha256: workload.descriptor.corpusSha256,
      retriesAuthorized: false,
    }),
    { flag: 'wx' }
  );
  const budget = createNativeBenchmarkRequestBudget({
    priorRequests: plan.priorRequests,
    cumulativeLimit: plan.cumulativeLimit,
  });
  const prefix = 'hpm-v2-' + randomBytes(6).toString('hex');
  const ingressKey = randomBytes(24).toString('hex');
  const testKey = randomBytes(24).toString('hex');
  let proxy, gateway, child, rpc, startedMs;
  let closing = false;
  const client = createNativeEvidenceV2Client({ workload, report });
  function noteFailure(code) {
    if (closing) return;
    report.failureCode ??= code;
    if (rpc) rpc.close();
  }
  const phase = (name) => {
    report.phase = name;
    progress({ phase: name, arm });
  };
  try {
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
      gateway.server.once('error', () => reject(fail('native_v2_gateway_failed')));
      gateway.server.listen(0, '127.0.0.1', () => resolve(gateway.server.address().port));
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-v2-client-'));
    const env = {
      ...selectEnv(BASE_ENV),
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
      clientInfo: { name: 'hpm_native_evidence_v2', version: '2.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    report.realNativeClient = true;
    const start = await rpc.call(
      'thread/start',
      nativeEvidenceV2Thread(port, directory, workload.tools, arm)
    );
    if (start.thread?.ephemeral !== true) throw fail('native_v2_isolation_unconfirmed');
    client.bind(start.thread.id);
    report.nativeEphemeralThreads = 1;
    startedMs = Date.now();
    for (let index = 0; index < workload.prompts.length; index++) {
      phase('native_turn_' + (index + 1));
      const completion = rpc
        .waitFor('turn/completed', (p) => p?.threadId === start.thread.id, 120000)
        .then(
          (value) => ({ value }),
          (problem) => ({ problem })
        );
      await rpc.call('turn/start', {
        threadId: start.thread.id,
        input: [{ type: 'text', text: workload.prompts[index] }],
        effort: 'low',
      });
      const completed = await completion;
      if (completed.problem) throw completed.problem;
      if (completed.value.turn?.status !== 'completed') throw fail('native_v2_turn_failed');
      if (index === workload.prompts.length - 1) client.verifyFinal();
      if (report.failureCode) throw fail(report.failureCode);
    }
  } catch (problem) {
    report.failureCode ??= safeCode(problem);
  } finally {
    closing = true;
    if (startedMs) report.taskTotalMs = Date.now() - startedMs;
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
    report.toolConcurrency = client.inspect();
    report.exactEvidenceInputReplies = gateway?.inspect().exactEvidenceInputReplies ?? 0;
    report.requestBudget = budget.inspect();
    report.phase = 'terminal';
    if (
      !report.nativeProcessTerminal ||
      !report.isolatedProxyTerminal ||
      !report.loopbackServerTerminal ||
      !report.guardedFilesUnchanged
    )
      report.failureCode ??= 'native_v2_cleanup_unconfirmed';
    report.mechanismSummary = summarizeNativeEvidenceV2(report);
    report.passed = report.mechanismSummary.nativeAcceptancePassed === true;
    if (!report.passed) report.failureCode ??= 'native_v2_acceptance_incomplete';
    report.mechanismSummary = summarizeNativeEvidenceV2(report);
    workload.close();
    fs.writeFileSync(plan.reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    progress({
      phase: 'terminal',
      arm,
      passed: report.passed,
      failureCode: report.failureCode,
      requests: report.transport.length,
      cumulativeRequests: report.requestBudget.cumulativeRequests,
    });
  }
  return report;
}

module.exports = {
  runNativeEvidenceV2,
  stopNativeEvidenceChild,
  nativeEvidenceV2Routes,
  startIsolatedEvidenceProxy,
};
