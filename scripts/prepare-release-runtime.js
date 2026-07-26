'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  createRuntimePackage,
  createRuntimePackageLock,
  resolveReleaseLayout,
} = require('../lib/release/layout');

const repoRoot = path.resolve(__dirname, '..');
const outputDir = resolveReleaseLayout(repoRoot).runtimeDir;
const sourcePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const sourcePackageLock = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')
);
const runtimePackage = createRuntimePackage(sourcePackage);
const runtimePackageLock = createRuntimePackageLock(sourcePackageLock, runtimePackage);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runNpmCommand(args, failureLabel) {
  const npmCliCandidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) throw new Error('Unable to locate npm-cli.js for production dependency staging');
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: outputDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    const detail = result.error && result.error.message ? `: ${result.error.message}` : '';
    throw new Error(`${failureLabel} failed with exit code ${result.status}${detail}`);
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outputDir, 'runtime', 'node'), { recursive: true });
fs.writeFileSync(
  path.join(outputDir, 'package.json'),
  JSON.stringify(runtimePackage, null, 2) + '\n'
);
fs.writeFileSync(
  path.join(outputDir, 'package-lock.json'),
  JSON.stringify(runtimePackageLock, null, 2) + '\n'
);

const nodeTarget = path.join(outputDir, 'runtime', 'node', 'node.exe');
fs.copyFileSync(process.execPath, nodeTarget);
runNpmCommand(
  ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  'Production lockfile pruning'
);
runNpmCommand(
  ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  'Production dependency staging'
);

for (const dependency of Object.keys(runtimePackage.dependencies)) {
  const packageFile = path.join(outputDir, 'node_modules', dependency, 'package.json');
  if (!fs.existsSync(packageFile))
    throw new Error(`Missing staged production dependency: ${dependency}`);
}

const manifest = {
  schemaVersion: 2,
  applicationVersion: sourcePackage.version,
  nodeVersion: process.version,
  nodeSha256: sha256(nodeTarget),
  packageLockSha256: sha256(path.join(outputDir, 'package-lock.json')),
  dependencies: runtimePackage.dependencies,
};
fs.writeFileSync(
  path.join(outputDir, 'release-runtime-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

console.log(`[release-runtime] prepared ${path.relative(repoRoot, outputDir)}`);
