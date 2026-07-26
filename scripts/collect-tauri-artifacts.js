'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertSafeReleasePath } = require('../lib/release/governance');

const INSTALLER_SUFFIXES = ['.exe', '.msi', '.dmg', '.appimage', '.deb', '.rpm', '.tar.gz'];

function resolveCargoTargetDir(repoRoot, value) {
  if (!value) return path.join(repoRoot, 'src-tauri', 'target');
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
}

function isInstallerFile(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  return INSTALLER_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function collectInstallerFiles(bundleDir) {
  const files = [];
  if (!fs.existsSync(bundleDir)) return files;
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && isInstallerFile(entry.name)) files.push(absolute);
    }
  }
  visit(bundleDir);
  return files.sort();
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeArtifactManifest(outputDir, artifactPaths) {
  const manifest = artifactPaths
    .map((artifactPath) => ({
      file: path.basename(artifactPath),
      bytes: fs.statSync(artifactPath).size,
      sha256: sha256(artifactPath),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
  fs.writeFileSync(
    path.join(outputDir, 'SHA256SUMS.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(outputDir, 'SHA256SUMS.txt'),
    manifest.map((entry) => `${entry.sha256} *${entry.file}`).join('\n') + '\n'
  );
  return manifest;
}

function collectTauriArtifacts(repoRoot, cargoTargetDir) {
  const outputDir = assertSafeReleasePath(
    repoRoot,
    path.join(repoRoot, 'dist', 'release', 'installers')
  );
  const bundleDir = path.join(cargoTargetDir, 'release', 'bundle');
  const installers = collectInstallerFiles(bundleDir);
  if (installers.length === 0) throw new Error(`No Tauri installers found under ${bundleDir}`);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const collectedPaths = [];
  for (const source of installers) {
    const target = path.join(outputDir, path.basename(source));
    fs.copyFileSync(source, target);
    collectedPaths.push(target);
  }
  const manifest = writeArtifactManifest(outputDir, collectedPaths);
  return { outputDir, manifest };
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const cargoTargetDir = resolveCargoTargetDir(repoRoot, process.env.CARGO_TARGET_DIR);
  const result = collectTauriArtifacts(repoRoot, cargoTargetDir);
  console.log(
    `[tauri-artifacts] collected ${result.manifest.length} installer(s) in ${path.relative(repoRoot, result.outputDir)}`
  );
}

module.exports = {
  collectInstallerFiles,
  collectTauriArtifacts,
  isInstallerFile,
  resolveCargoTargetDir,
  sha256,
  writeArtifactManifest,
};
