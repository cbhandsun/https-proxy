'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');

const ARTIFACT_DIRECTORY = 'runtime/evidence-gateway';
const DIGEST = /^[a-f0-9]{64}$/;
const fail = () => new Error('evidence_gateway_artifact_unavailable');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function regularArtifactFile(root, relative, maximum) {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 8 * 1024 * 1024 ||
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    root.includes('\0') ||
    typeof relative !== 'string' ||
    relative.length > 512 ||
    !/^[a-zA-Z0-9_./-]+$/.test(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw fail();
  let current = root;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail();
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1 ? !stat.isFile() || stat.size > maximum : !stat.isDirectory())
    )
      throw fail();
  }
  const bytes = fs.readFileSync(current);
  if (bytes.length > maximum) throw fail();
  return bytes;
}

// This is a local build-consistency check, not a signature or an authorization
// boundary. Source/lock changes require rebuilding; there is no source fallback.
function readEvidenceGatewayArtifact(root) {
  try {
    const manifest = normalizeCompactionData(
      JSON.parse(
        regularArtifactFile(root, `${ARTIFACT_DIRECTORY}/manifest.json`, 256 * 1024).toString(
          'utf8'
        )
      ),
      256 * 1024
    );
    if (
      !manifest ||
      Array.isArray(manifest) ||
      typeof manifest !== 'object' ||
      Object.keys(manifest).sort().join(',') !== 'bundleSha256,inputs,nodeMajor,schemaVersion' ||
      manifest.schemaVersion !== 1 ||
      manifest.nodeMajor !== Number(process.versions.node.split('.')[0]) ||
      typeof manifest.bundleSha256 !== 'string' ||
      !DIGEST.test(manifest.bundleSha256) ||
      !Array.isArray(manifest.inputs) ||
      manifest.inputs.length < 3 ||
      manifest.inputs.length > 512
    )
      throw fail();
    const names = new Set();
    for (const row of manifest.inputs) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(',') !== 'file,sha256' ||
        typeof row.file !== 'string' ||
        !/^(?:package(?:-lock)?\.json|(?:lib|scripts)\/[a-zA-Z0-9_./-]+\.js)$/.test(row.file) ||
        names.has(row.file) ||
        typeof row.sha256 !== 'string' ||
        !DIGEST.test(row.sha256)
      )
        throw fail();
      names.add(row.file);
      if (digest(regularArtifactFile(root, row.file, 2 * 1024 * 1024)) !== row.sha256) throw fail();
    }
    if (
      !names.has('package.json') ||
      !names.has('package-lock.json') ||
      !names.has('scripts/lib/evidence-gateway-runtime.js')
    )
      throw fail();
    const relative = `${ARTIFACT_DIRECTORY}/gateway-${manifest.bundleSha256}.cjs`;
    if (digest(regularArtifactFile(root, relative, 8 * 1024 * 1024)) !== manifest.bundleSha256)
      throw fail();
    return { file: path.join(root, relative), manifest };
  } catch {
    throw fail();
  }
}

module.exports = { ARTIFACT_DIRECTORY, digest, regularArtifactFile, readEvidenceGatewayArtifact };
