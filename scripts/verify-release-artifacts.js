'use strict';

const fs = require('fs');
const path = require('path');
const { sha256, isInstallerFile } = require('./collect-tauri-artifacts');
const { validateArtifactManifest } = require('../lib/release/artifact-manifest');

const repoRoot = path.resolve(__dirname, '..');
const installerDir = path.join(repoRoot, 'dist', 'release', 'installers');
const manifestPath = path.join(installerDir, 'SHA256SUMS.json');
if (!fs.existsSync(manifestPath)) throw new Error(`Release manifest is missing: ${manifestPath}`);

const filesByName = {};
for (const entry of fs.readdirSync(installerDir, { withFileTypes: true })) {
  if (!entry.isFile() || !isInstallerFile(entry.name)) continue;
  const filePath = path.join(installerDir, entry.name);
  filesByName[entry.name] = { bytes: fs.statSync(filePath).size, sha256: sha256(filePath) };
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const errors = validateArtifactManifest(manifest, filesByName);
if (errors.length > 0) throw new Error(`Release artifact validation failed: ${errors.join(', ')}`);
console.log(`[release-artifacts] ok: ${manifest.length} artifact(s)`);
