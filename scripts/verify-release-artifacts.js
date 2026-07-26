'use strict';

const fs = require('fs');
const path = require('path');
const { sha256, isInstallerFile } = require('./collect-tauri-artifacts');
const { validateArtifactManifest } = require('../lib/release/artifact-manifest');
const { resolveReleaseLayout } = require('../lib/release/layout');

function validateArtifactDirectory(directory, predicate, label, required) {
  const filesByName = {};
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !predicate(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      filesByName[entry.name] = { bytes: fs.statSync(filePath).size, sha256: sha256(filePath) };
    }
  }
  if (Object.keys(filesByName).length === 0 && !required) return 0;

  const manifestPath = path.join(directory, 'SHA256SUMS.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${label} manifest is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = validateArtifactManifest(manifest, filesByName);
  if (errors.length > 0) {
    throw new Error(`${label} artifact validation failed: ${errors.join(', ')}`);
  }
  return manifest.length;
}

function verifyReleaseArtifacts(repoRoot) {
  const layout = resolveReleaseLayout(repoRoot);
  return {
    installerCount: validateArtifactDirectory(
      layout.installersDir,
      isInstallerFile,
      'Installer',
      true
    ),
    portableCount: validateArtifactDirectory(
      layout.portableRoot,
      (fileName) => fileName.toLowerCase().endsWith('.zip'),
      'Portable',
      true
    ),
  };
}

if (require.main === module) {
  const result = verifyReleaseArtifacts(path.resolve(__dirname, '..'));
  console.log(
    `[release-artifacts] ok: ${result.installerCount} installer(s), ${result.portableCount} portable archive(s)`
  );
}

module.exports = {
  validateArtifactDirectory,
  verifyReleaseArtifacts,
};
