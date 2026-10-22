'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  digest,
  regularArtifactFile,
  readEvidenceGatewayArtifact,
  ARTIFACT_DIRECTORY,
} = require('../../scripts/lib/evidence-gateway-artifact');
const {
  PACKAGED_GATEWAY_FILES,
  PACKAGED_GATEWAY_INPUTS,
  RELEASE_GATEWAY_MANIFEST,
  readPackagedEvidenceGateway,
} = require('../../scripts/lib/evidence-gateway-release-artifact');

function stagePackagedEvidenceGateway(sourceRoot, releaseRoot) {
  try {
    if (
      typeof sourceRoot !== 'string' ||
      !path.isAbsolute(sourceRoot) ||
      typeof releaseRoot !== 'string' ||
      !path.isAbsolute(releaseRoot) ||
      sourceRoot.includes('\0') ||
      releaseRoot.includes('\0') ||
      path.resolve(sourceRoot) === path.resolve(releaseRoot)
    )
      throw new Error('invalid');
    // The caller owns its staging directory. Validate every ancestor we create
    // before writes; never follow a junction into existing user data.
    const ensureDirectory = (relative) => {
      let current = releaseRoot;
      const rootStat = fs.lstatSync(current);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid');
      for (const part of relative.split('/')) {
        current = path.join(current, part);
        try {
          fs.mkdirSync(current);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid');
      }
    };
    const artifact = readEvidenceGatewayArtifact(sourceRoot);
    const rows = PACKAGED_GATEWAY_FILES.map((file) => ({
      file,
      bytes: regularArtifactFile(sourceRoot, file, 2 * 1024 * 1024),
    }));
    const bundleRelative = `${ARTIFACT_DIRECTORY}/gateway-${artifact.manifest.bundleSha256}.cjs`;
    const bundle = regularArtifactFile(sourceRoot, bundleRelative, 8 * 1024 * 1024);
    if (digest(bundle) !== artifact.manifest.bundleSha256) throw new Error('invalid');
    for (const { file, bytes } of rows) {
      ensureDirectory(path.posix.dirname(file));
      fs.writeFileSync(path.join(releaseRoot, file), bytes, { flag: 'wx' });
    }
    ensureDirectory(ARTIFACT_DIRECTORY);
    fs.writeFileSync(path.join(releaseRoot, bundleRelative), bundle, { flag: 'wx' });
    const files = PACKAGED_GATEWAY_INPUTS.map((file) => ({
      file,
      sha256: digest(regularArtifactFile(releaseRoot, file, 2 * 1024 * 1024)),
    }));
    // Recheck both the copied launchers and the workspace provenance before
    // publishing the release-only manifest. A failure leaves no usable entry.
    for (const row of rows) {
      if (digest(regularArtifactFile(sourceRoot, row.file, 2 * 1024 * 1024)) !== digest(row.bytes))
        throw new Error('changed');
    }
    if (
      readEvidenceGatewayArtifact(sourceRoot).manifest.bundleSha256 !==
      artifact.manifest.bundleSha256
    )
      throw new Error('changed');
    const manifest = {
      schemaVersion: 1,
      nodeMajor: artifact.manifest.nodeMajor,
      bundleSha256: artifact.manifest.bundleSha256,
      files,
    };
    const temporary = path.join(releaseRoot, ARTIFACT_DIRECTORY, `release-${randomUUID()}.staged`);
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, path.join(releaseRoot, RELEASE_GATEWAY_MANIFEST));
    return readPackagedEvidenceGateway(releaseRoot);
  } catch {
    throw new Error('evidence_gateway_release_stage_failed');
  }
}

module.exports = { stagePackagedEvidenceGateway };
