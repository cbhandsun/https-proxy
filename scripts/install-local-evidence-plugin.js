'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { prepareLocalEvidencePlugin } = require('./prepare-local-evidence-plugin');
const { retainLocalEvidencePlugin } = require('./lib/local-evidence-plugin-vault');
const { createNativeLoopbackRpc } = require('./lib/native-loopback-rpc');
const { stopNativeEvidenceChild } = require('./lib/native-evidence-v2-runtime');
const sha = (value) => createHash('sha256').update(value).digest('hex');

function protectedConfig(text) {
  return (
    text
      .replace(/\r\n/g, '\n')
      // Native trust UI may emit an empty parent table. It carries no settings.
      .replace(/^\[hooks\.state\]\s*(?=^\[hooks\.state\.)/gm, '')
      .replace(
        /^\[(?:marketplaces\.hpm-local|plugins\."hpm-local-evidence@hpm-local"|hooks\.state\."hpm-local-evidence@hpm-local:hooks\/hooks\.json:post_tool_use:0:0")\][^]*?(?=^\[|(?![^]))/gm,
        ''
      )
      .trim()
  );
}

async function projectOnlyScope(binary, root) {
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: root,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = createNativeLoopbackRpc(child);
  let terminal;
  try {
    await rpc.call('initialize', {
      clientInfo: { name: 'hpm_plugin_scope', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    await rpc.call('config/value/write', {
      keyPath: 'plugins.hpm-local-evidence@hpm-local.enabled',
      value: false,
      mergeStrategy: 'replace',
    });
  } finally {
    rpc.close();
    terminal = await stopNativeEvidenceChild(child);
  }
  return terminal;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const config = 'C:/Users/juhon/.codex/config.toml';
  const receiptPath = path.join(
    root,
    '.hpm-runtime/context-local-plugin-install-20261012-result.json'
  );
  if (fs.existsSync(receiptPath)) throw new Error('One-shot plugin install already recorded');
  const original = fs.readFileSync(config, 'utf8');
  const before = sha(protectedConfig(original));
  const binary = 'C:/Users/juhon/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe';
  const report = {
    schema: 'hpm.context.local-plugin-install',
    modelCalls: 0,
    oldChatsRead: false,
    providerCredentialsRead: false,
    productionRestarted: false,
    protectedConfigBeforeSha256: before,
    failureCode: null,
  };
  try {
    report.package = await prepareLocalEvidencePlugin(root);
    const vault = path.join(root, '.hpm-runtime', 'local-evidence-plugin-vault');
    fs.mkdirSync(vault, { recursive: true, mode: 0o700 });
    // Keep a verified rollback source outside the native client's prunable cache
    // before handing it any installation or configuration ownership.
    report.rollbackPackage = retainLocalEvidencePlugin(report.package.packageDirectory, vault);
    for (const args of [
      ['plugin', 'marketplace', 'add', report.package.marketplaceDirectory, '--json'],
      ['plugin', 'add', 'hpm-local-evidence@hpm-local', '--json'],
    ]) {
      const result = spawnSync(binary, args, {
        cwd: root,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60000,
      });
      if (result.status !== 0) throw new Error('local_plugin_install_failed');
      const metadata = JSON.parse(result.stdout);
      if (args[1] === 'add') report.installedPath = metadata.installedPath;
    }
    report.scopeProcessTerminal = await projectOnlyScope(binary, root);
    if (!report.scopeProcessTerminal) throw new Error('local_plugin_install_failed');
    const current = fs.readFileSync(config, 'utf8');
    report.protectedConfigAfterSha256 = sha(protectedConfig(current));
    report.protectedConfigUnchanged = report.protectedConfigAfterSha256 === before;
    if (!report.protectedConfigUnchanged)
      throw new Error('local_plugin_config_changed_outside_scope');
    report.projectPolicyPresent = fs.existsSync(path.join(root, '.codex/config.toml'));
    report.installed =
      typeof report.installedPath === 'string' &&
      fs.existsSync(path.join(report.installedPath, 'server.cjs')) &&
      fs.existsSync(path.join(report.installedPath, 'third-party-notices.json'));
  } catch (problem) {
    report.failureCode = [
      'local_plugin_install_failed',
      'local_plugin_config_changed_outside_scope',
    ].includes(problem.message)
      ? problem.message
      : 'local_plugin_install_failed';
    process.exitCode = 1;
  }
  fs.writeFileSync(receiptPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('local_plugin_install_failed\n');
    process.exitCode = 1;
  });
module.exports = { protectedConfig };
