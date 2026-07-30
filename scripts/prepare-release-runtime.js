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
const proxySourceManifestPath = path.join(__dirname, 'release-proxy-sources.json');
const proxySourceFiles = JSON.parse(fs.readFileSync(proxySourceManifestPath, 'utf8'));
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

function copyReleaseFile(sourceRelativePath, targetRelativePath = sourceRelativePath) {
  const sourcePath = path.join(repoRoot, sourceRelativePath);
  const targetPath = path.join(outputDir, targetRelativePath);
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Release source must be a regular file: ${sourceRelativePath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function copyProxySourceTree() {
  const sourceRoot = path.join(repoRoot, 'lib', 'proxy');
  if (!Array.isArray(proxySourceFiles) || proxySourceFiles.length === 0) {
    throw new Error('Release proxy source manifest must be a non-empty array');
  }
  const declared = new Set();
  for (const relativePath of proxySourceFiles) {
    const normalized = String(relativePath || '').replaceAll('\\', '/');
    if (
      normalized !== relativePath ||
      !normalized.startsWith('lib/proxy/') ||
      !normalized.endsWith('.js') ||
      normalized.includes('/../') ||
      declared.has(normalized)
    ) {
      throw new Error(`Invalid release proxy source declaration: ${relativePath}`);
    }
    declared.add(normalized);
    copyReleaseFile(normalized);
  }

  const discovered = [];
  function inspectSourceDirectory(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Release proxy source must not contain symbolic links: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        inspectSourceDirectory(absolutePath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.js') {
        discovered.push(path.relative(repoRoot, absolutePath).replaceAll('\\', '/'));
      }
    }
  }
  inspectSourceDirectory(sourceRoot);
  const undeclared = discovered.filter((relativePath) => !declared.has(relativePath));
  if (undeclared.length > 0) {
    throw new Error(`Undeclared release proxy sources: ${undeclared.join(', ')}`);
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outputDir, 'runtime', 'node'), { recursive: true });
for (const releaseFile of [
  'openai-proxy.js',
  'proxy.bat',
  'proxy.ps1',
  'proxy.config.example.json',
]) {
  copyReleaseFile(releaseFile);
}
copyProxySourceTree();
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
  sourceSha256: Object.fromEntries(
    [
      'openai-proxy.js',
      'proxy.bat',
      'proxy.ps1',
      'proxy.config.example.json',
      ...proxySourceFiles,
    ].map((relativePath) => [
      relativePath,
      sha256(path.join(outputDir, relativePath.replaceAll('/', path.sep))),
    ])
  ),
  dependencies: runtimePackage.dependencies,
};
fs.writeFileSync(
  path.join(outputDir, 'release-runtime-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

console.log(`[release-runtime] prepared ${path.relative(repoRoot, outputDir)}`);
