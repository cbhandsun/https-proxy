'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createNativeLoopbackRpc } = require('./lib/native-loopback-rpc');
const { stopNativeEvidenceChild } = require('./lib/native-evidence-v2-runtime');
const { protectedConfig } = require('./install-local-evidence-plugin');

async function main() {
  const run = process.argv[2] ?? 'run1';
  if (!/^run[1-9][0-9]?$/.test(run)) throw new Error('Invalid installed probe run');
  const root = path.resolve(__dirname, '..');
  const binary = 'C:/Users/juhon/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe';
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: root,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const report = {
    schema: 'hpm.context.installed-local-plugin',
    modelCalls: 0,
    oldChatsRead: false,
    credentialsReadByHarness: false,
    productionRestarted: false,
    hookExecutionVerified: false,
    failureCode: null,
  };
  const rpc = createNativeLoopbackRpc(child, {
    onNotification: (message) => {
      if (/hook\/(?:started|completed)/.test(message.method)) {
        report.hookNotificationCount = (report.hookNotificationCount ?? 0) + 1;
        report.hookNotificationKeys = Object.keys(message.params ?? {}).sort();
      }
    },
  });
  try {
    await rpc.call('initialize', {
      clientInfo: { name: 'hpm_installed_plugin_verify', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const hooks = await rpc.call('hooks/list', { cwds: [root] });
    report.hooks = hooks.data
      .flatMap((entry) => entry.hooks)
      .filter((hook) => hook.pluginId === 'hpm-local-evidence@hpm-local')
      .map((hook) => ({
        key: hook.key,
        currentHash: hook.currentHash,
        trustStatus: hook.trustStatus,
        enabled: hook.enabled,
        server: hook.server,
        tool: hook.tool,
      }));
    report.hookTrusted =
      report.hooks.length === 1 &&
      report.hooks[0].trustStatus === 'trusted' &&
      report.hooks[0].enabled;
    const thread = await rpc.call('thread/start', { ephemeral: true, cwd: root });
    const threadId = thread.thread.id;
    const status = await rpc.call('mcpServerStatus/list', { threadId, serverName: 'evidence' });
    report.exposedTools = Object.keys(status.data[0]?.tools ?? {}).sort();
    report.readerOnly =
      report.exposedTools.join(',') === 'hpm_list_retained_evidence,hpm_read_retained_evidence';
    const call = (tool, args) =>
      rpc.call('mcpServer/tool/call', { threadId, server: 'evidence', tool, arguments: args });
    const before = JSON.parse((await call('hpm_list_retained_evidence', {})).content[0].text);
    report.newSessionEmpty = before.sources.length === 0;
    const finished = rpc.waitFor(
      'item/completed',
      (params) => params?.threadId === threadId && params.item?.type === 'commandExecution'
    );
    await rpc.call('thread/shellCommand', {
      threadId,
      command: 'Write-Output hpm-synthetic-installed-hook',
      timeoutMs: 10000,
    });
    await finished;
    const after = JSON.parse((await call('hpm_list_retained_evidence', {})).content[0].text);
    report.shellCommandCaptured = after.sources.length > 0;
    // Explicit trusted app-server capture is adapter proof, not a real Hook.
    await call('hpm_capture_completed_hook', {
      hook_event_name: 'PostToolUse',
      session_id: threadId,
      tool_use_id: 'synthetic-installed-call',
      tool_name: 'synthetic_fixture',
      tool_input: {},
      tool_response: 'synthetic installed evidence 中文🙂',
    });
    const index = JSON.parse((await call('hpm_list_retained_evidence', {})).content[0].text);
    const source = index.sources.find((item) => item.callId === 'synthetic-installed-call');
    const read = JSON.parse(
      (
        await call('hpm_read_retained_evidence', {
          sourceId: source.sourceId,
          digest: source.digest,
        })
      ).content[0].text
    );
    report.installedExactReadPassed = read.page.text === 'synthetic installed evidence 中文🙂';
    const config = fs.readFileSync('C:/Users/juhon/.codex/config.toml', 'utf8');
    const install = JSON.parse(
      fs.readFileSync(
        path.join(root, '.hpm-runtime/context-local-plugin-install-20261012-result.json'),
        'utf8'
      )
    );
    report.protectedConfigUnchanged =
      createHash('sha256').update(protectedConfig(config)).digest('hex') ===
      install.protectedConfigBeforeSha256;
    report.globallyDisabled =
      /\[plugins\."hpm-local-evidence@hpm-local"\]\s*enabled\s*=\s*false/.test(config);
    const outside = await rpc.call('hooks/list', { cwds: [path.dirname(root)] });
    report.outsideProjectInactive = outside.data
      .flatMap((entry) => entry.hooks)
      .every((hook) => hook.pluginId !== 'hpm-local-evidence@hpm-local');
    if (
      !report.hookTrusted ||
      !report.readerOnly ||
      !report.installedExactReadPassed ||
      !report.protectedConfigUnchanged ||
      !report.outsideProjectInactive
    )
      throw new Error('Installed plugin gate failed');
  } catch (problem) {
    report.failureCode = /^native_[a-z_]+$/.test(problem?.code)
      ? problem.code
      : 'installed_plugin_verification_failed';
  } finally {
    rpc.close();
    report.processTerminal = await stopNativeEvidenceChild(child);
  }
  fs.writeFileSync(
    path.join(root, '.hpm-runtime/context-installed-local-plugin-20261012-' + run + '-result.json'),
    JSON.stringify(report, null, 2),
    { flag: 'wx' }
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.failureCode) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write('installed_plugin_verification_failed\n');
  process.exitCode = 1;
});
