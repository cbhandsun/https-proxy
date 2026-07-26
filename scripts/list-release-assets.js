'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isInstallerFile } = require('./collect-tauri-artifacts');
const { verifyReleaseArtifacts } = require('./verify-release-artifacts');
const { resolveReleaseLayout } = require('../lib/release/layout');

const CHECKSUM_FILE_NAMES = ['SHA256SUMS.json', 'SHA256SUMS.txt'];

function regularFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && predicate(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function requiredChecksumFiles(directory, prefix) {
  return CHECKSUM_FILE_NAMES.map((fileName) => {
    const filePath = path.join(directory, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Release checksum is missing: ${filePath}`);
    }
    return { filePath, assetName: `${prefix}-${fileName}` };
  });
}

function requiredSbomFiles(directory) {
  const files = regularFiles(directory, (fileName) => fileName.toLowerCase().endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`Release SBOM is missing: ${directory}`);
  }
  return files.map((filePath) => ({
    filePath,
    assetName: `HTTPS-Proxy-Manager-${path.basename(filePath)}`,
  }));
}

function collectReleaseAssets(repoRoot) {
  const root = path.resolve(repoRoot);
  const layout = resolveReleaseLayout(root);
  verifyReleaseArtifacts(root);

  const assets = [
    ...regularFiles(layout.installersDir, isInstallerFile).map((filePath) => ({
      filePath,
      assetName: path.basename(filePath),
    })),
    ...requiredChecksumFiles(layout.installersDir, 'HTTPS-Proxy-Manager-installers'),
    ...regularFiles(layout.portableRoot, (fileName) => fileName.toLowerCase().endsWith('.zip')).map(
      (filePath) => ({ filePath, assetName: path.basename(filePath) })
    ),
    ...requiredChecksumFiles(layout.portableRoot, 'HTTPS-Proxy-Manager-portable'),
    ...requiredSbomFiles(layout.sbomDir),
  ];
  const names = new Set();
  for (const asset of assets) {
    if (names.has(asset.assetName)) {
      throw new Error(`Release asset name is duplicated: ${asset.assetName}`);
    }
    names.add(asset.assetName);
  }
  return assets;
}

function toGhAssetArgument(asset) {
  if (!asset || typeof asset.filePath !== 'string' || typeof asset.assetName !== 'string') {
    throw new TypeError('release asset must provide filePath and assetName');
  }
  return `${asset.filePath}#${asset.assetName}`;
}

if (require.main === module) {
  for (const asset of collectReleaseAssets(path.resolve(__dirname, '..'))) {
    process.stdout.write(`${toGhAssetArgument(asset)}\n`);
  }
}

module.exports = {
  CHECKSUM_FILE_NAMES,
  collectReleaseAssets,
  regularFiles,
  requiredChecksumFiles,
  requiredSbomFiles,
  toGhAssetArgument,
};
