'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = () => new Error('local_evidence_bundle_refused');
const safePath = (name) =>
  typeof name === 'string' &&
  name.length <= 1024 &&
  /^[A-Za-z0-9@+_./-]+$/.test(name) &&
  name.split('/').every((part) => part && part !== '.' && part !== '..');

function readBundledFile(root, relative, maximum = 8 * 1024 * 1024) {
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    !safePath(relative) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 8 * 1024 * 1024
  )
    throw refused();
  let file = path.resolve(root);
  const base = fs.lstatSync(file);
  if (!base.isDirectory() || base.isSymbolicLink()) throw refused();
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    file = path.join(file, parts[index]);
    const stat = fs.lstatSync(file);
    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1
        ? !stat.isFile() || stat.nlink !== 1 || stat.size > maximum
        : !stat.isDirectory())
    )
      throw refused();
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > maximum) throw refused();
  return bytes;
}

const PACKAGE_FILES = Object.freeze([
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'mcp.json',
  'package-lock.json',
  'package.json',
  'plugin.portable.json',
  'server.cjs',
  'third-party-notices.json',
]);

// An integrity/packaging contract, not a signature or a grant of read authority.
// Both legacy and bundled artifacts still pass the vault's complete inventory.
function verifyBundledPlugin(files, manifest, pkg, lock) {
  const fail = () => {
    throw refused();
  };
  const byName = new Map(files.map((entry) => [entry.path, entry]));
  if (
    !manifest ||
    Object.keys(manifest).sort().join(',') !== 'files,inputs,nodeMajor,schema,version' ||
    manifest.schema !== 'hpm.context.plugin-bundle' ||
    manifest.version !== 1 ||
    !Number.isSafeInteger(manifest.nodeMajor) ||
    manifest.nodeMajor < 22 ||
    manifest.nodeMajor > 100 ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.inputs) ||
    manifest.inputs.length < 1 ||
    manifest.inputs.length > 4096
  )
    fail();
  if (files.length !== PACKAGE_FILES.length + 1 || manifest.files.length !== PACKAGE_FILES.length)
    fail();
  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      !entry ||
      Object.keys(entry).sort().join(',') !== 'path,sha256' ||
      !PACKAGE_FILES.includes(entry.path) ||
      seen.has(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      byName.get(entry.path)?.sha256 !== entry.sha256
    )
      fail();
    seen.add(entry.path);
  }
  seen.clear();
  for (const entry of manifest.inputs) {
    if (
      !entry ||
      Object.keys(entry).sort().join(',') !== 'path,sha256' ||
      !safePath(entry.path) ||
      seen.has(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      fail();
    seen.add(entry.path);
  }
  const sbom = JSON.parse(byName.get('third-party-notices.json').content.toString('utf8'));
  if (
    !sbom ||
    sbom.schema !== 'hpm.context.plugin-sbom' ||
    sbom.version !== 1 ||
    sbom.lockSha256 !== byName.get('package-lock.json')?.sha256 ||
    !Array.isArray(sbom.packages) ||
    !sbom.packages.length ||
    sbom.packages.length > 512
  )
    fail();
  seen.clear();
  for (const entry of sbom.packages) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !/^node_modules\/(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(entry.path) ||
      seen.has(entry.path) ||
      typeof entry.name !== 'string' ||
      entry.path !== 'node_modules/' + entry.name ||
      typeof entry.version !== 'string' ||
      entry.version !== lock.packages?.[entry.path]?.version ||
      !Array.isArray(entry.notices) ||
      entry.notices.length > 16 ||
      entry.notices.some((text) => typeof text !== 'string' || text.length > 256 * 1024)
    )
      fail();
    seen.add(entry.path);
  }
  const sdk = pkg.dependencies?.['@modelcontextprotocol/sdk'];
  if (
    typeof sdk !== 'string' ||
    !sbom.packages.some(
      (entry) => entry.name === '@modelcontextprotocol/sdk' && entry.version === sdk
    )
  )
    fail();
}

module.exports = { readBundledFile, verifyBundledPlugin, PACKAGE_FILES, sha };
