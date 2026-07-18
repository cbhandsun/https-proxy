'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertSafeReleasePath } = require('../lib/release/governance');

const repoRoot = path.resolve(__dirname, '..');
const outputDir = assertSafeReleasePath(repoRoot, path.join(repoRoot, 'dist', 'release-runtime'));
const sourcePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const runtimePackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  private: true,
  dependencies: sourcePackage.dependencies || {},
};

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runNpmCi() {
  const npmCliCandidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) throw new Error('Unable to locate npm-cli.js for production dependency staging');
  const result = spawnSync(
    process.execPath,
    [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: outputDir, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    const detail = result.error && result.error.message ? `: ${result.error.message}` : '';
    throw new Error(
      `Production dependency staging failed with exit code ${result.status}${detail}`
    );
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outputDir, 'runtime', 'node'), { recursive: true });
fs.writeFileSync(
  path.join(outputDir, 'package.json'),
  JSON.stringify(runtimePackage, null, 2) + '\n'
);
fs.copyFileSync(
  path.join(repoRoot, 'package-lock.json'),
  path.join(outputDir, 'package-lock.json')
);

const nodeTarget = path.join(outputDir, 'runtime', 'node', 'node.exe');
fs.copyFileSync(process.execPath, nodeTarget);
runNpmCi();

for (const dependency of Object.keys(runtimePackage.dependencies)) {
  const packageFile = path.join(outputDir, 'node_modules', dependency, 'package.json');
  if (!fs.existsSync(packageFile))
    throw new Error(`Missing staged production dependency: ${dependency}`);
}

const manifest = {
  schemaVersion: 1,
  applicationVersion: sourcePackage.version,
  nodeVersion: process.version,
  nodeSha256: sha256(nodeTarget),
  dependencies: runtimePackage.dependencies,
};
fs.writeFileSync(
  path.join(outputDir, 'release-runtime-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

console.log(`[release-runtime] prepared ${path.relative(repoRoot, outputDir)}`);
