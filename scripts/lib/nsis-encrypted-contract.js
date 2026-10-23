'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const BASELINE_INSTALLER_SHA256 =
  'e7dc2ec976df82c2679eb45b336312253caec2f7cf8e7629cc4940e147b85ce6';
const BASELINE_MANIFEST_SHA256 = '32157042cb8988a035f29c9f94261f0b18ad055670214d3daf33095a70b1f62d';
const fail = () => new Error('nsis_encrypted_qualification_failed');
const equalPath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function inspectSafePath(input, directory = false) {
  if (
    typeof input !== 'string' ||
    !path.isAbsolute(input) ||
    /^[\\/]{2}/.test(input) ||
    /[\0\r\n]/.test(input)
  )
    throw fail();
  const resolved = path.resolve(input);
  let current = resolved;
  while (current !== path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !equalPath(fs.realpathSync.native(current), current)) throw fail();
    if (current !== resolved && !stat.isDirectory()) throw fail();
    current = path.dirname(current);
  }
  const stat = fs.lstatSync(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw fail();
  return { resolved, stat };
}
function safePath(input, directory = false) {
  return inspectSafePath(input, directory).resolved;
}
function child(root, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw fail();
  const result = path.resolve(root, relative);
  if (!result.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw fail();
  return result;
}
function digest(file) {
  const { stat } = inspectSafePath(file);
  if (stat.size > 256 * 1024 * 1024) throw fail();
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = createHash('sha256');
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size !== stat.size ||
      opened.nlink !== 1
    )
      throw fail();
    const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    let offset = 0;
    while (offset < stat.size) {
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset
      );
      if (!count) throw fail();
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.nlink !== 1
    )
      throw fail();
  } finally {
    fs.closeSync(descriptor);
  }
  safePath(file);
  return hash.digest('hex');
}
function parseDriverArguments(args) {
  if (
    !Array.isArray(args) ||
    args.length !== 4 ||
    !['seed', 'read', 'resave', 'refuse-legacy'].includes(args[0]) ||
    typeof args[3] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(args[3])
  )
    throw fail();
  return {
    operation: args[0],
    install: safePath(args[1], true),
    store: safePath(args[2], true),
    manifestSha256: args[3],
  };
}
function visitInstallationFiles(install, expected, visit) {
  safePath(install, true);
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw fail();
  const file = child(install, 'release-runtime-manifest.json');
  if (digest(file) !== expected || fs.statSync(file).size > 4 * 1024 * 1024) throw fail();
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.schemaVersion !== 2 ||
    !manifest.sourceSha256 ||
    typeof manifest.sourceSha256 !== 'object' ||
    Array.isArray(manifest.sourceSha256)
  )
    throw fail();
  const entries = Object.entries(manifest.sourceSha256);
  if (entries.length < 1 || entries.length > 4096) throw fail();
  const names = new Set();
  for (const [relative, expectedHash] of [
    ...entries,
    ['runtime/node/node.exe', manifest.nodeSha256],
    ['runtime/native/hpm-context-recovery-key.exe', manifest.contextRecoveryNativeSha256],
    ['package-lock.json', manifest.packageLockSha256],
  ]) {
    if (
      typeof expectedHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedHash) ||
      names.has(relative.toLowerCase())
    )
      throw fail();
    names.add(relative.toLowerCase());
    visit(child(install, relative), expectedHash);
  }
  return {
    manifestSha256: expected,
    sourceCount: entries.length,
    native: child(install, 'runtime/native/hpm-context-recovery-key.exe'),
    node: child(install, 'runtime/node/node.exe'),
  };
}
function verifyInstallation(install, expected) {
  return visitInstallationFiles(install, expected, (file, expectedHash) => {
    if (digest(file) !== expectedHash) throw fail();
  });
}
function nativeKeyInvocation(executable, args, expectedNative) {
  if (
    typeof executable !== 'string' ||
    typeof expectedNative !== 'string' ||
    !equalPath(path.resolve(executable), expectedNative) ||
    !Array.isArray(args) ||
    args.length !== 1 ||
    !['--hpm-context-key-v1', '--hpm-context-private-path-v1', '--hpm-context-anchor-v1'].includes(
      args[0]
    )
  )
    throw fail();
  return args[0] === '--hpm-context-key-v1';
}
function compareReceipts(baseline, next) {
  const keys = 'budgetSha256,callCount,expiresAt,keySha256,originalSha256,rootId,sourceId';
  for (const value of [baseline, next]) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== keys ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0 ||
      !Number.isSafeInteger(value.callCount) ||
      value.callCount < 0 ||
      !/^hbs_[a-f0-9]{32}$/.test(value.rootId) ||
      !/^hce_[a-f0-9]{32}$/.test(value.sourceId) ||
      ['budgetSha256', 'keySha256', 'originalSha256'].some(
        (key) => typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])
      )
    )
      throw fail();
  }
  for (const key of keys.split(',')) if (baseline[key] !== next[key]) throw fail();
  return true;
}
module.exports = {
  BASELINE_INSTALLER_SHA256,
  BASELINE_MANIFEST_SHA256,
  fail,
  safePath,
  child,
  digest,
  parseDriverArguments,
  verifyInstallation,
  visitInstallationFiles,
  compareReceipts,
  nativeKeyInvocation,
};
