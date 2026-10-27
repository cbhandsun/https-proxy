'use strict';

const path = require('node:path');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { digest, regularArtifactFile, ARTIFACT_DIRECTORY } = require('./evidence-gateway-artifact');

const PACKAGED_GATEWAY_FILES = Object.freeze([
  'scripts/start-packaged-evidence-mcp-gateway.js',
  'scripts/lib/evidence-gateway-release-artifact.js',
  'scripts/lib/evidence-gateway-artifact.js',
  'scripts/lib/evidence-gateway-config.js',
  'scripts/lib/evidence-gateway-environment.js',
  'scripts/lib/evidence-gateway-shutdown.js',
]);
const PACKAGED_GATEWAY_INPUTS = Object.freeze(
  [
    ...PACKAGED_GATEWAY_FILES,
    'package.json',
    'package-lock.json',
    'lib/proxy/context-compaction-envelope.js',
    'lib/proxy/context-compaction-byte-budget.js',
    'lib/proxy/context-evidence-utf8.js',
    'lib/proxy/context-call-id-lineage.js',
    'lib/proxy/context-compaction-lease.js',
  ].sort()
);
const RELEASE_GATEWAY_MANIFEST = `${ARTIFACT_DIRECTORY}/release-manifest.json`;
const SHA256 = /^[a-f0-9]{64}$/;

function readPackagedEvidenceGateway(root) {
  try {
    const manifest = normalizeCompactionData(
      JSON.parse(regularArtifactFile(root, RELEASE_GATEWAY_MANIFEST, 32768).toString('utf8')),
      32768
    );
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(',') !== 'bundleSha256,files,nodeMajor,schemaVersion' ||
      manifest.schemaVersion !== 1 ||
      manifest.nodeMajor !== Number(process.versions.node.split('.')[0]) ||
      typeof manifest.bundleSha256 !== 'string' ||
      !SHA256.test(manifest.bundleSha256) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== PACKAGED_GATEWAY_INPUTS.length
    )
      throw new Error('invalid');
    for (let index = 0; index < PACKAGED_GATEWAY_INPUTS.length; index++) {
      const row = manifest.files[index];
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(',') !== 'file,sha256' ||
        row.file !== PACKAGED_GATEWAY_INPUTS[index] ||
        typeof row.sha256 !== 'string' ||
        !SHA256.test(row.sha256) ||
        digest(regularArtifactFile(root, row.file, 2 * 1024 * 1024)) !== row.sha256
      )
        throw new Error('invalid');
    }
    const relative = `${ARTIFACT_DIRECTORY}/gateway-${manifest.bundleSha256}.cjs`;
    if (digest(regularArtifactFile(root, relative, 8 * 1024 * 1024)) !== manifest.bundleSha256)
      throw new Error('invalid');
    return { file: path.join(root, relative), manifest };
  } catch {
    throw new Error('evidence_gateway_release_unavailable');
  }
}

module.exports = {
  PACKAGED_GATEWAY_FILES,
  PACKAGED_GATEWAY_INPUTS,
  RELEASE_GATEWAY_MANIFEST,
  readPackagedEvidenceGateway,
};
