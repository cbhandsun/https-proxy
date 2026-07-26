'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeArtifactManifest } = require('./collect-tauri-artifacts');
const { resolveReleaseLayout } = require('../lib/release/layout');

function collectPortableArchives(portableRoot) {
  if (!fs.existsSync(portableRoot)) return [];
  return fs
    .readdirSync(portableRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.zip')
    )
    .map((entry) => path.join(portableRoot, entry.name))
    .sort();
}

function writePortableArtifactManifest(repoRoot) {
  const portableRoot = resolveReleaseLayout(repoRoot).portableRoot;
  const archives = collectPortableArchives(portableRoot);
  if (archives.length === 0) {
    throw new Error(`No portable ZIP archives found under ${portableRoot}`);
  }
  return {
    manifest: writeArtifactManifest(portableRoot, archives),
    outputDir: portableRoot,
  };
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const result = writePortableArtifactManifest(repoRoot);
  console.log(
    `[portable-artifacts] recorded ${result.manifest.length} archive(s) in ${path.relative(repoRoot, result.outputDir)}`
  );
}

module.exports = {
  collectPortableArchives,
  writePortableArtifactManifest,
};
