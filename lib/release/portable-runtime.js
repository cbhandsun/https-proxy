'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');
const { collectReleaseEntries, validateReleaseDirectory } = require('./governance');
const {
  PACKAGED_GATEWAY_FILES,
  readPackagedEvidenceGateway,
} = require('../../scripts/lib/evidence-gateway-release-artifact');
const { regularArtifactFile } = require('../../scripts/lib/evidence-gateway-artifact');

const MANIFEST = 'release-runtime-manifest.json';
const ROOT_FILES = [
  'openai-proxy.js',
  'proxy.bat',
  'proxy.ps1',
  'proxy.config.example.json',
  'package.json',
  'package-lock.json',
  MANIFEST,
];
const ROOT_DIRECTORIES = ['lib', 'node_modules', 'runtime', 'scripts'];
const SHA256 = /^[a-f0-9]{64}$/;
const refuse = () => new Error('portable_runtime_unavailable');
const comparisonKey = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

function directory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw refuse();
  const root = path.resolve(input);
  if (comparisonKey(root) === comparisonKey(path.parse(root).root)) throw refuse();
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw refuse();
  const real = fs.realpathSync(root);
  if (process.platform === 'win32' ? real.toLowerCase() !== root.toLowerCase() : real !== root)
    throw refuse();
  return root;
}

// Hash binaries in bounded chunks; neither a large Node binary nor a malformed
// manifest can force an unbounded allocation. Never follow a linked ancestor.
function fileDigest(root, relative, maximum) {
  let file = root;
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
      throw refuse();
  }
  const before = fs.lstatSync(file);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw refuse();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(1024 * 1024, before.size));
    let offset = 0;
    while (offset < before.size) {
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset
      );
      if (!count) throw refuse();
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1
    )
      throw refuse();
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyPortableRuntime(input) {
  try {
    const root = directory(input);
    const bytes = regularArtifactFile(root, MANIFEST, 1024 * 1024);
    const manifest = normalizeCompactionData(JSON.parse(bytes), 1024 * 1024);
    if (
      !manifest ||
      Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(',') !==
        'applicationVersion,contextRecoveryNativeSha256,dependencies,evidenceGatewayBundleSha256,nodeSha256,nodeVersion,packageLockSha256,schemaVersion,sourceSha256' ||
      manifest.schemaVersion !== 2 ||
      typeof manifest.applicationVersion !== 'string' ||
      typeof manifest.nodeVersion !== 'string' ||
      !/^v\d+\.\d+\.\d+$/.test(manifest.nodeVersion) ||
      !manifest.sourceSha256 ||
      Array.isArray(manifest.sourceSha256) ||
      typeof manifest.sourceSha256 !== 'object'
    )
      throw refuse();
    const sources = Object.entries(manifest.sourceSha256);
    if (!sources.length || sources.length > 4096) throw refuse();
    if (
      !manifest.dependencies ||
      Array.isArray(manifest.dependencies) ||
      typeof manifest.dependencies !== 'object' ||
      !Object.keys(manifest.dependencies).length ||
      Object.keys(manifest.dependencies).length > 256 ||
      Object.entries(manifest.dependencies).some(
        ([name, version]) =>
          !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name) ||
          typeof version !== 'string' ||
          !version.length ||
          version.length > 256
      )
    )
      throw refuse();
    const names = new Set();
    const required = new Set([...ROOT_FILES.slice(0, 4), ...PACKAGED_GATEWAY_FILES]);
    for (const [name, digest] of sources) {
      if (
        name.length > 512 ||
        (!required.has(name) &&
          !/^lib\/proxy\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/.test(name)) ||
        name.split('/').some((part) => part === '.' || part === '..') ||
        names.has(name.toLowerCase()) ||
        typeof digest !== 'string' ||
        !SHA256.test(digest) ||
        fileDigest(root, name, 2 * 1024 * 1024) !== digest
      )
        throw refuse();
      names.add(name.toLowerCase());
    }
    for (const name of required) if (!Object.hasOwn(manifest.sourceSha256, name)) throw refuse();
    const entries = collectReleaseEntries(root);
    if (
      entries.files.some(
        (entry) =>
          /^(?:lib\/proxy|scripts)\/.*\.js$/.test(entry.relative) &&
          !Object.hasOwn(manifest.sourceSha256, entry.relative)
      )
    )
      throw refuse();
    for (const [name, field, maximum] of [
      ['runtime/node/node.exe', 'nodeSha256', 256 * 1024 * 1024],
      [
        'runtime/native/hpm-context-recovery-key.exe',
        'contextRecoveryNativeSha256',
        16 * 1024 * 1024,
      ],
      ['package-lock.json', 'packageLockSha256', 8 * 1024 * 1024],
    ]) {
      if (
        typeof manifest[field] !== 'string' ||
        !SHA256.test(manifest[field]) ||
        fileDigest(root, name, maximum) !== manifest[field]
      )
        throw refuse();
    }
    const validation = validateReleaseDirectory(root, manifest.dependencies, {
      requireExecutable: false,
    });
    const pkg = JSON.parse(regularArtifactFile(root, 'package.json', 1024 * 1024));
    const dependencies = (value) => JSON.stringify(Object.entries(value ?? {}).sort());
    if (
      !validation.ok ||
      pkg.version !== manifest.applicationVersion ||
      dependencies(pkg.dependencies) !== dependencies(manifest.dependencies) ||
      readPackagedEvidenceGateway(root).manifest.bundleSha256 !==
        manifest.evidenceGatewayBundleSha256
    )
      throw refuse();
    return {
      manifestSha256: createHash('sha256').update(bytes).digest('hex'),
      sourceCount: sources.length,
    };
  } catch {
    throw refuse();
  }
}

function copyPortableRuntime(source, destination) {
  try {
    const root = directory(source);
    const output = directory(destination);
    const rootKey = comparisonKey(root);
    const outputKey = comparisonKey(output);
    if (
      outputKey === rootKey ||
      outputKey.startsWith(rootKey + path.sep) ||
      rootKey.startsWith(outputKey + path.sep) ||
      fs.readdirSync(output).length
    )
      throw refuse();
    const before = verifyPortableRuntime(root);
    for (const name of [...ROOT_FILES, ...ROOT_DIRECTORIES])
      fs.cpSync(path.join(root, name), path.join(output, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    const copied = verifyPortableRuntime(output);
    const after = verifyPortableRuntime(root);
    if (
      copied.manifestSha256 !== before.manifestSha256 ||
      after.manifestSha256 !== before.manifestSha256
    )
      throw refuse();
    return copied;
  } catch {
    // Preserve partial output for diagnosis; never remove or overwrite a user's
    // directory to recover from a failed copy, and never fall back to sources.
    throw refuse();
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw refuse();
    process.stdout.write(
      JSON.stringify(copyPortableRuntime(process.argv[2], process.argv[3])) + '\n'
    );
  } catch {
    process.stderr.write('portable_runtime_unavailable\n');
    process.exitCode = 1;
  }
}

module.exports = { copyPortableRuntime, verifyPortableRuntime };
