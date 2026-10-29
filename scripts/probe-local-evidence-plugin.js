'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createNativeLoopbackRpc } = require('./lib/native-loopback-rpc');
const { stopNativeEvidenceChild } = require('./lib/native-evidence-v2-runtime');
const { prepareLocalEvidencePlugin } = require('./prepare-local-evidence-plugin');
const { inspectLocalEvidencePlugin } = require('./lib/local-evidence-plugin-vault');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-local-plugin-'));
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
  Object.assign(env, {
    CODEX_HOME: path.join(directory, 'codex'),
    APPDATA: path.join(directory, 'appdata'),
    LOCALAPPDATA: path.join(directory, 'local'),
    USERPROFILE: directory,
    HOME: directory,
  });
  for (const key of ['CODEX_HOME', 'APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(env[key]);
  const binary = 'C:/Users/juhon/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe';
  const report = {
    schema: 'hpm.context.local-plugin-native',
    modelCalls: 0,
    oldChatsRead: false,
    installedConfigWritten: false,
    isolatedInstallPassed: false,
    threadIsolationPassed: false,
    capturePassed: false,
    exactReadPassed: false,
    hookExecutionVerified: false,
    failureCode: null,
  };
  let child, rpc;
  try {
    const artifact = await prepareLocalEvidencePlugin(root);
    const marketplace = spawnSync(
      binary,
      ['plugin', 'marketplace', 'add', artifact.marketplaceDirectory],
      {
        cwd: directory,
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    report.marketplaceAdded = marketplace.status === 0;
    if (marketplace.status !== 0)
      throw Object.assign(new Error('Marketplace unavailable'), {
        code: 'native_plugin_marketplace_failed',
      });
    const installed = spawnSync(
      binary,
      ['plugin', 'add', 'hpm-local-evidence@hpm-local', '--json'],
      { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30000 }
    );
    if (installed.status !== 0) {
      report.installErrorClass = [
        'manifest',
        'schema',
        'marketplace',
        'not found',
        'source',
        'permission',
        'mcp',
        'invalid',
      ].filter((word) => installed.stderr?.toLowerCase().includes(word));
      throw Object.assign(new Error('Plugin install refused'), {
        code: 'native_plugin_install_failed',
      });
    }
    const receipt = JSON.parse(installed.stdout);
    report.installedPath = receipt.installedPath;
    report.isolatedCache = receipt.installedPath.startsWith(directory);
    report.installReceiptKeys = Object.keys(receipt).sort();
    report.isolatedInstallPassed = true;
    report.installedEntrypointPresent = fs.existsSync(
      path.join(receipt.installedPath, 'server.cjs')
    );
    report.installedBundleVerified =
      inspectLocalEvidencePlugin(receipt.installedPath).snapshotId === artifact.snapshotId;
    report.cachedOverlayPresent = fs.existsSync(
      path.join(receipt.installedPath, '.codex-plugin/plugin.json')
    );
    report.cachedHooksPresent = fs.existsSync(path.join(receipt.installedPath, 'hooks/hooks.json'));
    report.cachedPortableMcpPresent = fs.existsSync(path.join(receipt.installedPath, 'mcp.json'));
    report.cachedLegacyMcpPresent = fs.existsSync(path.join(receipt.installedPath, '.mcp.json'));
    child = spawn(
      binary,
      [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'plugins.hpm-local-evidence@hpm-local.enabled=true',
      ],
      {
        cwd: directory,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    rpc = createNativeLoopbackRpc(child);
    await rpc.call('initialize', {
      clientInfo: { name: 'hpm_local_plugin_probe', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const loadedHooks = await rpc.call('hooks/list', { cwds: [directory] });
    report.loadedHookEntries = loadedHooks.data?.map((entry) => ({
      count: entry.hooks.length,
      errorCount: entry.errors.length,
      warningCount: entry.warnings.length,
    }));
    const readPlugin = await rpc.call('plugin/read', {
      pluginName: 'hpm-local-evidence',
      marketplacePath: path.join(artifact.marketplaceDirectory, '.agents/plugins/marketplace.json'),
    });
    report.pluginReadKeys = Object.keys(readPlugin).sort();
    report.pluginDetailKeys = Object.keys(readPlugin.plugin ?? {}).sort();
    const cfg = await rpc.call('config/read', {});
    report.configPluginKeys = Object.keys(cfg.config?.plugins ?? {});
    report.configPluginEnabled = cfg.config?.plugins?.['hpm-local-evidence@hpm-local']?.enabled;
    report.pluginData = readPlugin.plugin;
    const thread = await rpc.call('thread/start', { ephemeral: true, cwd: directory });
    const threadId = thread.thread.id;
    const status = await rpc.call('mcpServerStatus/list', { threadId });
    report.statusKeys = Object.keys(status).sort();
    const entries = status.data ?? status.servers ?? [];
    report.servers = entries.map((entry) => ({
      name: entry.name,
      tools: Object.keys(entry.tools ?? {}),
    }));
    const entry = entries.find((item) => /evidence/.test(item.name));
    if (!entry)
      throw Object.assign(new Error('Evidence server missing'), {
        code: 'native_plugin_server_missing',
      });
    const server = entry.name;
    const call = (tool, args, id = threadId) =>
      rpc.call('mcpServer/tool/call', { threadId: id, server, tool, arguments: args });
    const captured = await call('hpm_capture_completed_hook', {
      hook_event_name: 'PostToolUse',
      session_id: threadId,
      tool_use_id: 'synthetic-call-1',
      tool_name: 'exec_command',
      tool_input: { command: 'Write-Output synthetic' },
      tool_response: 'synthetic retained 中文🙂',
    });
    report.capturePassed = captured.isError !== true && captured.content[0].text === '{}';
    const listed = await call('hpm_list_retained_evidence', {});
    const index = JSON.parse(listed.content[0].text);
    const source = index.sources[0];
    const read = await call('hpm_read_retained_evidence', {
      sourceId: source.sourceId,
      digest: source.digest,
    });
    report.exactReadPassed =
      JSON.parse(read.content[0].text).page.text === 'synthetic retained 中文🙂';
    const otherThread = await rpc.call('thread/start', { ephemeral: true, cwd: directory });
    await rpc.call('mcpServerStatus/list', { threadId: otherThread.thread.id, serverName: server });
    const denied = await call(
      'hpm_read_retained_evidence',
      { sourceId: source.sourceId, digest: source.digest },
      otherThread.thread.id
    );
    report.threadIsolationPassed = denied.isError === true;
    const hooks = await rpc.call('hooks/list', { cwds: [directory] });
    report.hookListKeys = Object.keys(hooks).sort();
    report.hooks = (hooks.data ?? [])
      .flatMap((item) => item.hooks ?? [])
      .filter((hook) => /hpm-local-evidence/.test(hook.pluginId ?? ''))
      .map((hook) => ({
        key: hook.key,
        currentHash: hook.currentHash,
        handlerType: hook.handlerType,
        server: hook.server,
        tool: hook.tool,
        trustStatus: hook.trustStatus,
        enabled: hook.enabled,
      }));
  } catch (problem) {
    report.failureCode = /^native_[a-z_]+$/.test(problem?.code)
      ? problem.code
      : 'native_plugin_probe_failed';
  } finally {
    rpc?.close();
    report.processTerminal = await stopNativeEvidenceChild(child);
    if (directory.startsWith(path.join(os.tmpdir(), 'hpm-local-plugin-')) && report.processTerminal)
      fs.rmSync(directory, { recursive: true });
    else report.failureCode ??= 'native_plugin_cleanup_failed';
  }
  const run = process.argv[2] ?? 'run1';
  if (!/^run[1-9][0-9]?$/.test(run)) throw new Error('Invalid probe run');
  fs.writeFileSync(
    path.join(root, '.hpm-runtime/context-local-plugin-native-20261012-' + run + '-result.json'),
    JSON.stringify(report, null, 2),
    { flag: 'wx' }
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.failureCode) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write('local_plugin_probe_failed\n');
  process.exitCode = 1;
});
