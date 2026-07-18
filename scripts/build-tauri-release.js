'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { collectTauriArtifacts, resolveCargoTargetDir } = require('./collect-tauri-artifacts');

const repoRoot = path.resolve(__dirname, '..');
const cargoTargetDir = resolveCargoTargetDir(repoRoot, process.env.CARGO_TARGET_DIR);
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');
const result = spawnSync(process.execPath, [tauriCli, 'build'], {
  cwd: repoRoot,
  env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
  stdio: 'inherit',
});

if (result.status !== 0) {
  const detail = result.error && result.error.message ? `: ${result.error.message}` : '';
  throw new Error(`Tauri release build failed with exit code ${result.status}${detail}`);
}

const collected = collectTauriArtifacts(repoRoot, cargoTargetDir);
console.log(`[tauri-build] complete: ${collected.manifest.length} installer(s)`);
