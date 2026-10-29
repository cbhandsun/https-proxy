'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createNativeLoopbackRpc } = require('./native-loopback-rpc');
const { createNativeBenchmarkRequestBudget } = require('./native-benchmark-request-budget');
const { createNativeEvidenceV2Gateway } = require('./native-evidence-v2-gateway');
const { approvedNativeEvidenceRoute, hashFile } = require('./native-evidence-v2-preflight');
const {
  startIsolatedEvidenceProxy,
  stopNativeEvidenceChild,
  nativeEvidenceV2Routes,
} = require('./native-evidence-v2-runtime');
const {
  acceptanceAuthority,
  acceptanceContinuationPrompt,
  createFreshAcceptanceSource,
  validateCapturedPage,
  inspectAcceptanceInput,
  acceptanceVerdict,
  acceptanceCyclePassed,
} = require('./installed-evidence-acceptance');
const fail = (code) => Object.assign(new Error('Installed evidence acceptance failed'), { code });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const TRUST_KEY = 'hpm-local-evidence@hpm-local:hooks/hooks.json:post_tool_use:0:0';
const TRUST_HASH = 'sha256:a59584acde6541a0a26349e2544dbe3f93479a3841bdd36d9111a27098461d14';

async function runInstalledEvidenceAcceptance(root, progress, run = 'run1') {
  if (!['run1', 'run2', 'multi1'].includes(run)) throw fail('native_acceptance_run_invalid');
  const repeated = run === 'multi1';
  const requestLimit = repeated ? 12 : 6;
  const requiredCycles = repeated ? 2 : 1;
  const name = 'context-installed-evidence-acceptance-20261012-' + run;
  const runtime = path.join(root, run === 'run1' ? '.hpm-runtime' : '.hpm-acceptance');
  const authorityPath = path.join(runtime, name + '-authorization.json');
  acceptanceAuthority(read(authorityPath), run);
  const reportPath = path.join(runtime, name + '-result.json');
  const attemptPath = path.join(runtime, name + '-attempt.json');
  if (fs.existsSync(reportPath) || fs.existsSync(attemptPath))
    throw fail('native_acceptance_already_attempted');
  const priorRequests = repeated ? 0 : run === 'run2' ? 96 : 91;
  if (run === 'run1') {
    const prior = read(
      path.join(runtime, 'context-native-evidence-diagnostic-20261012-run3-result.json')
    );
    if (prior.requestBudget?.cumulativeRequests !== 91 || prior.phase !== 'terminal')
      throw fail('native_acceptance_prior_budget_unconfirmed');
  }
  const route = approvedNativeEvidenceRoute(read(path.join(root, 'proxy.config.json')));
  const guarded =
    run !== 'run1'
      ? [
          path.join(root, 'proxy.config.json'),
          path.join(os.homedir(), '.codex/config.toml'),
          ...['.hpm-runtime', '.hpm-runtime-probe'].flatMap((directory) =>
            ['proxy-key.pem', 'proxy-cert.pem', 'proxy-ca-key.pem', 'proxy-ca-cert.pem'].map(
              (file) => path.join(root, directory, '.certs', file)
            )
          ),
        ].map((file) => ({ path: file }))
      : read(
          path.join(runtime, 'context-native-evidence-candidate-20261012-pair1-audit-result.json')
        ).protection.protectedFiles;
  if (!Array.isArray(guarded) || guarded.length !== (run === 'run1' ? 11 : 10))
    throw fail('native_acceptance_guards_missing');
  const guards = guarded.map((row) => ({ path: row.path, sha256: hashFile(row.path) }));
  for (const file of ['.codex/config.toml', 'plugins/hpm-local-evidence/hooks/hooks.json']) {
    const full = path.join(root, file);
    guards.push({ path: full, sha256: hashFile(full) });
  }
  fs.writeFileSync(
    attemptPath,
    JSON.stringify({
      maximumAdditionalRequests: requestLimit,
      automaticRetries: 0,
      authorizationSha256: hashFile(authorityPath),
    }),
    { flag: 'wx' }
  );
  const report = {
    schema: 'hpm.context.installed-evidence-acceptance',
    version: 1,
    acceptanceRun: run,
    previousReceiptPresent: fs.existsSync(
      path.join(
        root,
        '.hpm-runtime/context-installed-evidence-acceptance-20261012-run1-result.json'
      )
    ),
    priorRequestsSource: repeated
      ? 'independent_new_authorization_no_historical_budget_reconstruction'
      : run === 'run2'
        ? 'previously_reported_aggregate_not_current_file'
        : 'verified_prior_receipt',
    phase: 'preflight',
    failureCode: null,
    passed: false,
    model: 'gpt-5.6-sol',
    requestLimit,
    requiredCompactionCycles: requiredCycles,
    cycles: [],
    automaticRetries: 0,
    fixturePreseededOriginals: false,
    oldChatsRead: false,
    installedConfigurationWritten: false,
    productionRestarted: false,
    providerCredentialsCreatedOrCopied: false,
    currentSessionSwitched: false,
    transport: [],
    turns: [],
    compactionChainReuseChecks: [],
    nativeCompactionCycles: 0,
    sourceToolCompleted: false,
    originalHookCaptured: false,
    preCompactExactRead: false,
    nativeCompactionItemCompleted: false,
    postCompactCheckpointObserved: false,
    postCompactInitialMarkerAbsent: false,
    modelListCompleted: false,
    modelExactReadCompleted: false,
    exactReaderOutputEnteredModelInput: false,
    finalStateCorrect: false,
    unsafeToolRequests: 0,
    authorizationSha256: hashFile(authorityPath),
  };
  const budget = createNativeBenchmarkRequestBudget({
    priorRequests,
    cumulativeLimit: priorRequests + requestLimit,
  });
  const marker = 'probe-' + randomBytes(16).toString('hex');
  const expected = createFreshAcceptanceSource(marker).expected;
  const ingressKey = randomBytes(24).toString('hex');
  const testKey = randomBytes(24).toString('hex');
  const prefix = 'hpm-v2-' + randomBytes(6).toString('hex');
  let proxy, gateway, directory, child, rpc, original, readerEnvelope, threadId, finalText;
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
  const completion = () =>
    rpc
      .waitFor('turn/completed', (p) => p.threadId === threadId, 120000)
      .then(
        (value) => ({ value }),
        (problem) => ({ problem })
      );
  const finish = async (pending) => {
    const done = await pending;
    if (done.problem) throw done.problem;
    if (done.value.turn?.status !== 'completed') throw fail('native_acceptance_turn_failed');
    if (report.failureCode) throw fail(report.failureCode);
  };
  try {
    phase('isolated_proxy_starting');
    proxy = await startIsolatedEvidenceProxy(root, route, ingressKey, noteFailure);
    await proxy.ready();
    proxy.child.stdout.on('data', () => {});
    gateway = createNativeEvidenceV2Gateway({
      report,
      budget,
      upstreamPort: proxy.port,
      ingressKey,
      testKey,
      prefix,
      onFailure: noteFailure,
      workload: {
        inspectInput(items) {
          const observation = inspectAcceptanceInput(items, marker, original, readerEnvelope);
          if (report.phase === 'native_continue' && !report.postCompactFirstInputObserved) {
            report.postCompactFirstInputObserved = true;
            report.postCompactInitialMarkerAbsent = !observation.visibleMarker;
          }
          if (report.phase === 'native_continue') {
            report.postCompactCheckpointObserved ||= observation.checkpointItems > 0;
            report.exactReaderOutputEnteredModelInput ||= observation.exactRetainedPageInput;
          }
          return [];
        },
        inspectReadbackInput: () => [],
      },
    });
    const port = await new Promise((resolve, reject) => {
      gateway.server.once('error', () => reject(fail('native_acceptance_gateway_failed')));
      gateway.server.listen(0, '127.0.0.1', () => resolve(gateway.server.address().port));
    });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-installed-acceptance-'));
    const env = Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]])
    );
    Object.assign(env, {
      USERPROFILE: directory,
      HOME: directory,
      CODEX_HOME: path.join(directory, 'codex'),
      APPDATA: path.join(directory, 'appdata'),
      LOCALAPPDATA: path.join(directory, 'local'),
      HPM_NATIVE_TEST_AUTH: testKey,
    });
    for (const key of ['CODEX_HOME', 'APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(env[key]);
    const binary = path.join(os.homedir(), 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe');
    for (const args of [
      ['plugin', 'marketplace', 'add', root, '--json'],
      ['plugin', 'add', 'hpm-local-evidence@hpm-local', '--json'],
    ]) {
      const result = spawnSync(binary, args, {
        cwd: directory,
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60000,
      });
      if (result.status !== 0) throw fail('native_acceptance_isolated_plugin_failed');
    }
    fs.appendFileSync(
      path.join(env.CODEX_HOME, 'config.toml'),
      '\n[hooks.state."' + TRUST_KEY + '"]\ntrusted_hash = "' + TRUST_HASH + '"\n'
    );
    child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd: directory,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rpc = createNativeLoopbackRpc(child, {
      onFailure: noteFailure,
      onServerRequest() {
        report.unsafeToolRequests++;
        throw fail('native_acceptance_approval_refused');
      },
      onNotification(message) {
        const p = message.params;
        if (message.method === 'error') throw fail('native_acceptance_native_error');
        if (['item/started', 'item/completed'].includes(message.method)) {
          const item = p?.item;
          if (p?.threadId !== threadId) throw fail('native_acceptance_thread_mismatch');
          if (
            [
              'commandExecution',
              'fileChange',
              'webSearch',
              'dynamicToolCall',
              'collabAgentToolCall',
              'collabToolCall',
            ].includes(item?.type)
          ) {
            report.unsafeToolRequests++;
            throw fail('native_acceptance_tool_refused');
          }
          if (item?.type === 'mcpToolCall') {
            const allowed =
              (item.server === 'source' &&
                item.tool === 'emit_fresh_evidence' &&
                report.phase === 'native_source') ||
              (item.server === 'evidence' &&
                ['hpm_list_retained_evidence', 'hpm_read_retained_evidence'].includes(item.tool) &&
                report.phase === 'native_continue');
            if (!allowed) {
              report.unsafeToolRequests++;
              throw fail('native_acceptance_tool_refused');
            }
            if (message.method === 'item/completed') {
              if (item.status !== 'completed' || item.error || item.result?.isError)
                throw fail('native_acceptance_tool_failed');
              if (item.tool === 'emit_fresh_evidence') report.sourceToolCompleted = true;
              if (item.tool === 'hpm_list_retained_evidence') report.modelListCompleted = true;
              if (item.tool === 'hpm_read_retained_evidence') {
                const page = validateCapturedPage(item.result, expected);
                if (page.text !== original) throw fail('native_acceptance_reader_changed');
                readerEnvelope = item.result.content[0].text;
                report.modelExactReadCompleted = true;
              }
            }
          }
          if (message.method === 'item/completed' && item?.type === 'contextCompaction')
            report.nativeCompactionItemCompleted = true;
          if (message.method === 'item/completed' && item?.type === 'agentMessage')
            finalText = item.text;
        }
        if (message.method === 'turn/completed')
          report.turns.push({ completed: p?.turn?.status === 'completed' });
      },
    });
    await rpc.call('initialize', {
      clientInfo: { name: 'hpm_installed_acceptance', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const hooks = (await rpc.call('hooks/list', { cwds: [directory] })).data
      .flatMap((entry) => entry.hooks)
      .filter((hook) => hook.pluginId === 'hpm-local-evidence@hpm-local');
    report.hookTrusted =
      hooks.length === 1 &&
      hooks[0].trustStatus === 'trusted' &&
      hooks[0].enabled &&
      hooks[0].currentHash === TRUST_HASH;
    if (!report.hookTrusted) throw fail('native_acceptance_hook_not_trusted');
    const start = await rpc.call('thread/start', {
      ephemeral: true,
      cwd: directory,
      model: report.model,
      modelProvider: 'hpm-isolated',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      config: {
        model_reasoning_effort: 'low',
        web_search: 'disabled',
        model_auto_compact_token_limit: 1000000,
        features: { shell_tool: false },
        mcp_servers: {
          source: {
            command: process.execPath,
            args: [path.join(root, 'test/fixtures/fresh-evidence-source-mcp.js')],
            cwd: directory,
            env: { HPM_SYNTHETIC_MARKER: marker },
            enabled_tools: ['emit_fresh_evidence'],
            default_tools_approval_mode: 'approve',
          },
        },
        plugins: {
          'hpm-local-evidence@hpm-local': {
            enabled: true,
            mcp_servers: {
              evidence: {
                enabled: true,
                enabled_tools: [
                  'hpm_list_retained_evidence',
                  'hpm_read_retained_evidence',
                  'hpm_capture_completed_hook',
                ],
                default_tools_approval_mode: 'approve',
              },
            },
          },
        },
        model_providers: {
          'hpm-isolated': {
            name: 'OpenAI',
            base_url: 'http://127.0.0.1:' + port + '/backend-api/codex',
            wire_api: 'responses',
            env_key: 'HPM_NATIVE_TEST_AUTH',
            supports_websockets: false,
            capabilities: { remote_compaction: 'v2' },
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
      },
    });
    threadId = start.thread.id;
    if (!start.thread.ephemeral) throw fail('native_acceptance_not_ephemeral');
    const status = await rpc.call('mcpServerStatus/list', { threadId });
    report.discoveredServers = status.data.map((entry) => ({
      name: entry.name,
      tools: Object.keys(entry.tools ?? {}).sort(),
    }));
    if (
      !status.data.some((entry) => entry.name === 'source') ||
      !status.data.some((entry) => entry.name === 'evidence')
    )
      throw fail('native_acceptance_tools_missing');
    const tool = (name, args) =>
      rpc.call('mcpServer/tool/call', {
        threadId,
        server: 'evidence',
        tool: name,
        arguments: args,
      });
    const before = JSON.parse((await tool('hpm_list_retained_evidence', {})).content[0].text);
    if (before.sources.length !== 0) throw fail('native_acceptance_ledger_not_empty');
    phase('native_source');
    let pending = completion();
    await rpc.call('turn/start', {
      threadId,
      effort: 'low',
      input: [
        {
          type: 'text',
          text: 'This is an isolated read-only Hook acceptance test. Call source emit_fresh_evidence exactly once with {}. Do not use any other tool, shell, file, network or agent operation. After the tool succeeds, reply only SOURCE_DONE, without copying its contents. If any tool fails, stop immediately; do not retry.',
        },
      ],
    });
    await finish(pending);
    if (!report.sourceToolCompleted) throw fail('native_acceptance_source_not_called');
    phase('host_capture_verification');
    const index = JSON.parse((await tool('hpm_list_retained_evidence', {})).content[0].text);
    const source = index.sources.find((row) => /emit_fresh_evidence/.test(row.toolName));
    if (!source) throw fail('native_acceptance_original_not_captured');
    const page = validateCapturedPage(
      await tool('hpm_read_retained_evidence', {
        sourceId: source.sourceId,
        digest: source.digest,
        limitBytes: 8192,
      }),
      expected
    );
    original = page.text;
    report.originalHookCaptured = true;
    report.preCompactExactRead = true;
    report.originalReceipt = {
      sourceId: page.sourceId,
      digest: page.digest,
      bytes: Buffer.byteLength(original),
    };
    for (let index = 1; index <= requiredCycles; index++) {
      // Each cycle must earn its own observations; previous successes cannot
      // qualify a later read, checkpoint or continuation.
      for (const key of [
        'nativeCompactionItemCompleted',
        'postCompactFirstInputObserved',
        'postCompactCheckpointObserved',
        'postCompactInitialMarkerAbsent',
        'modelListCompleted',
        'modelExactReadCompleted',
        'exactReaderOutputEnteredModelInput',
        'finalStateCorrect',
      ])
        report[key] = false;
      readerEnvelope = undefined;
      finalText = '';
      report.activeCycle = index;
      phase('native_compact');
      pending = completion();
      await rpc.call('thread/compact/start', { threadId });
      await finish(pending);
      if (!report.nativeCompactionItemCompleted || report.nativeCompactionCycles !== index)
        throw fail('native_acceptance_compaction_missing');
      phase('native_continue');
      pending = completion();
      await rpc.call('turn/start', {
        threadId,
        effort: 'low',
        input: [{ type: 'text', text: acceptanceContinuationPrompt() }],
      });
      await finish(pending);
      try {
        report.finalStateCorrect = isDeepStrictEqual(JSON.parse(finalText.trim()), expected);
      } catch {
        report.finalStateCorrect = false;
      }
      const cycle = {
        index,
        nativeCompactionItemCompleted: report.nativeCompactionItemCompleted,
        postCompactCheckpointObserved: report.postCompactCheckpointObserved,
        postCompactInitialMarkerAbsent: report.postCompactInitialMarkerAbsent,
        modelListCompleted: report.modelListCompleted,
        modelExactReadCompleted: report.modelExactReadCompleted,
        exactReaderOutputEnteredModelInput: report.exactReaderOutputEnteredModelInput,
        finalStateCorrect: report.finalStateCorrect,
      };
      report.cycles.push(cycle);
      if (!acceptanceCyclePassed(cycle)) throw fail('native_acceptance_cycle_incomplete');
      progress({
        phase: 'cycle_completed',
        cycle: index,
        requests: budget.inspect().reservedRequests,
      });
    }
  } catch (problem) {
    report.failureCode ??= /^native_[a-z0-9_]{1,80}$/.test(problem?.code)
      ? problem.code
      : 'native_acceptance_failed';
  } finally {
    closing = true;
    report.rpc = rpc?.inspect();
    rpc?.close();
    report.nativeProcessTerminal = await stopNativeEvidenceChild(child);
    if (gateway) {
      gateway.server.closeAllConnections();
      await new Promise((resolve) => gateway.server.close(resolve));
    }
    report.loopbackServerTerminal = !gateway?.server.listening;
    report.isolatedProxyTerminal = await stopNativeEvidenceChild(proxy?.child);
    Object.assign(
      report,
      nativeEvidenceV2Routes(proxy?.eventFile, prefix, report.transport.length)
    );
    report.guardedFilesUnchanged = guards.every((row) => hashFile(row.path) === row.sha256);
    report.requestBudget = budget.inspect();
    const directories = [
      [directory, 'hpm-installed-acceptance-'],
      [proxy?.directory, 'hpm-native-v2-proxy-'],
    ];
    report.isolatedDirectoriesRemoved = true;
    for (const [target, allowed] of directories) {
      if (!target) continue;
      if (
        report.nativeProcessTerminal &&
        report.isolatedProxyTerminal &&
        path.dirname(target) === path.resolve(os.tmpdir()) &&
        path.basename(target).startsWith(allowed)
      )
        fs.rmSync(target, { recursive: true });
      else report.isolatedDirectoriesRemoved = false;
    }
    report.phase = 'terminal';
    report.passed = acceptanceVerdict(report);
    if (!report.passed) report.failureCode ??= 'native_acceptance_incomplete';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    progress({
      phase: 'terminal',
      passed: report.passed,
      failureCode: report.failureCode,
      requests: report.requestBudget.reservedRequests,
    });
  }
  return report;
}

module.exports = { runInstalledEvidenceAcceptance };
