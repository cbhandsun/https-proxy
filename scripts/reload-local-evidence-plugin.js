'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createNativeLoopbackRpc } = require('./lib/native-loopback-rpc');
const { stopNativeEvidenceChild } = require('./lib/native-evidence-v2-runtime');

async function main() {
  const root = path.resolve(__dirname, '..');
  const child = spawn(
    'C:/Users/juhon/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe',
    ['app-server', 'proxy'],
    { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const rpc = createNativeLoopbackRpc(child);
  const report = {
    schema: 'hpm.context.local-plugin-current-host',
    modelCalls: 0,
    oldChatsRead: false,
    providerConfigurationChanged: false,
    productionProxyRestarted: false,
    reloadRequested: false,
    failureCode: null,
  };
  try {
    await rpc.call('initialize', {
      clientInfo: { name: 'hpm_plugin_reload', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    await rpc.call('config/mcpServer/reload');
    report.reloadRequested = true;
    const hooks = await rpc.call('hooks/list', { cwds: [root] });
    report.trusted = hooks.data
      .flatMap((entry) => entry.hooks)
      .some(
        (hook) =>
          hook.pluginId === 'hpm-local-evidence@hpm-local' &&
          hook.trustStatus === 'trusted' &&
          hook.enabled
      );
    const status = await rpc.call('mcpServerStatus/list', {
      threadId: '01a12461-7f41-7a30-a2c3-1b585f1fd16e',
      serverName: 'evidence',
    });
    report.readerNames = Object.keys(status.data[0]?.tools ?? {}).sort();
    report.currentHostRegistered =
      report.readerNames.join(',') === 'hpm_list_retained_evidence,hpm_read_retained_evidence';
  } catch (problem) {
    report.failureCode = /^native_[a-z_]+$/.test(problem?.code)
      ? problem.code
      : 'local_plugin_current_host_failed';
  } finally {
    rpc.close();
    report.controlProxyTerminal = await stopNativeEvidenceChild(child);
  }
  fs.writeFileSync(
    path.join(root, '.hpm-runtime/context-local-plugin-current-host-20261012-result.json'),
    JSON.stringify(report, null, 2),
    { flag: 'wx' }
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.failureCode) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write('local_plugin_current_host_failed\n');
  process.exitCode = 1;
});
