'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const cleanupScript = path.join(repoRoot, 'src-tauri', 'nsis', 'stop-installed-processes.ps1');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-installer-cleanup-'));
const installDir = path.join(tempRoot, 'HTTPS Proxy Manager');
const controlDir = path.join(tempRoot, 'control');
const bundledNode = path.join(installDir, 'runtime', 'node', 'node.exe');
const installedApp = path.join(installDir, 'app.exe');
const legacyInstalledApp = path.join(installDir, 'https-proxy-manager.exe');
const proxyScript = path.join(installDir, 'openai-proxy.js');
const controlScript = path.join(controlDir, 'openai-proxy.js');
const controlApp = path.join(controlDir, 'app.exe');

function runPowerShell(args, env = process.env, cwd = repoRoot) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 35000,
    windowsHide: true,
  });
}

function runCleanup(installPath, fallbackInstallPath = '') {
  const args = ['-ExecutionPolicy', 'Bypass', '-File', cleanupScript, '-InstallDir', installPath];
  if (fallbackInstallPath) args.push('-FallbackInstallDir', fallbackInstallPath);
  return runPowerShell(args);
}

function runCleanupFromLocalAppData(localAppData, cwd) {
  return runPowerShell(
    ['-ExecutionPolicy', 'Bypass', '-File', cleanupScript],
    {
      ...process.env,
      LOCALAPPDATA: localAppData,
    },
    cwd
  );
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function main() {
  fs.mkdirSync(path.dirname(bundledNode), { recursive: true });
  fs.mkdirSync(controlDir, { recursive: true });
  fs.copyFileSync(process.execPath, bundledNode);
  fs.copyFileSync(process.execPath, installedApp);
  fs.copyFileSync(process.execPath, legacyInstalledApp);
  fs.copyFileSync(process.execPath, controlApp);
  fs.writeFileSync(proxyScript, 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(controlScript, 'setInterval(() => {}, 1000);\n');

  const emptyResult = runCleanup(path.join(tempRoot, 'missing-install'));
  assert.strictEqual(emptyResult.status, 0, emptyResult.stderr || emptyResult.stdout);

  const unsafeResult = runCleanup(path.parse(installDir).root);
  assert.notStrictEqual(unsafeResult.status, 0, 'filesystem root must be rejected');

  const fallbackResult = runCleanup(path.parse(installDir).root, installDir);
  assert.strictEqual(fallbackResult.status, 0, fallbackResult.stderr || fallbackResult.stdout);
  assert.match(fallbackResult.stdout, /using validated fallback/i);

  const target = spawn(bundledNode, [proxyScript], { stdio: 'ignore', windowsHide: true });
  const appTarget = spawn(installedApp, [proxyScript], { stdio: 'ignore', windowsHide: true });
  const legacyAppTarget = spawn(legacyInstalledApp, [proxyScript], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const control = spawn(process.execPath, [controlScript], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const appControl = spawn(controlApp, [controlScript], {
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.strictEqual(target.exitCode, null, 'owned proxy fixture must be running');
    assert.strictEqual(appTarget.exitCode, null, 'owned desktop fixture must be running');
    assert.strictEqual(
      legacyAppTarget.exitCode,
      null,
      'owned legacy desktop fixture must be running'
    );
    assert.strictEqual(control.exitCode, null, 'control Node fixture must be running');
    assert.strictEqual(
      appControl.exitCode,
      null,
      'same-name app outside install dir must be running'
    );

    const result = runCleanupFromLocalAppData(tempRoot, installDir);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Process cleanup install directory:/i);
    assert.strictEqual(await waitForExit(target, 3000), true, 'owned proxy must be stopped');
    assert.strictEqual(
      await waitForExit(appTarget, 3000),
      true,
      'owned desktop app must be stopped'
    );
    assert.strictEqual(
      await waitForExit(legacyAppTarget, 3000),
      true,
      'owned legacy desktop app must be stopped'
    );
    assert.strictEqual(control.exitCode, null, 'unrelated Node process must remain running');
    assert.strictEqual(
      appControl.exitCode,
      null,
      'same-name app outside install dir must remain running'
    );
    assert.match(result.stdout, /executable locks released/i);

    console.log('[installer-process-cleanup.test] ok');
  } finally {
    if (target.exitCode === null) target.kill();
    if (appTarget.exitCode === null) appTarget.kill();
    if (legacyAppTarget.exitCode === null) legacyAppTarget.kill();
    if (control.exitCode === null) control.kill();
    if (appControl.exitCode === null) appControl.kill();
    await Promise.all([
      waitForExit(target, 3000),
      waitForExit(appTarget, 3000),
      waitForExit(legacyAppTarget, 3000),
      waitForExit(control, 3000),
      waitForExit(appControl, 3000),
    ]);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
