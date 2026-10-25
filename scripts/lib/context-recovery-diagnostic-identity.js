'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function diagnosticIdentity() {
  const root = path.resolve(__dirname, '../..');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  const head = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw Error();
  const sources = git([
    'ls-files',
    '-z',
    '--',
    'package.json',
    'package-lock.json',
    'lib/proxy',
    'native/context-recovery-key',
    'scripts/prepare-context-recovery-native.js',
    'scripts/diagnose-context-recovery-open.js',
    'scripts/lib/context-recovery-open-diagnostic.js',
    'scripts/lib/context-recovery-diagnostic-identity.js',
    'scripts/lib/context-recovery-capacity-*.js',
    'scripts/lib/context-recovery-native-day.js',
    'scripts/lib/context-recovery-native-prefix.js',
    'scripts/diagnose-context-recovery-native-prefix.js',
    'scripts/qualify-context-recovery-native-day.js',
  ])
    .split('\0')
    .filter(Boolean);
  // Include these files while the diagnostic itself is still uncommitted.
  for (const name of [
    'scripts/diagnose-context-recovery-open.js',
    'scripts/lib/context-recovery-open-diagnostic.js',
    'scripts/lib/context-recovery-diagnostic-identity.js',
    'scripts/lib/context-recovery-native-day.js',
    'scripts/lib/context-recovery-native-prefix.js',
    'scripts/diagnose-context-recovery-native-prefix.js',
    'scripts/qualify-context-recovery-native-day.js',
    'scripts/lib/context-recovery-capacity-retention.js',
    'scripts/lib/context-recovery-capacity-failure.js',
  ])
    if (!sources.includes(name)) sources.push(name);
  const digest = createHash('sha256');
  for (const name of sources.sort()) {
    const file = path.resolve(root, name);
    if (
      !file.startsWith(root + path.sep) ||
      !fs.lstatSync(file).isFile() ||
      fs.lstatSync(file).isSymbolicLink()
    )
      throw Error();
    digest
      .update(name + '\0')
      .update(fs.readFileSync(file))
      .update('\0');
  }
  const storage = require('../../lib/proxy/context-recovery-storage');
  const progress = require('../../lib/proxy/context-recovery-storage-progress');
  const native = path.join(root, 'runtime/native/hpm-context-recovery-key.exe');
  let nativeSha256 = null;
  if (fs.existsSync(native)) {
    const stat = fs.lstatSync(native);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16777216)
      throw Error();
    nativeSha256 = createHash('sha256').update(fs.readFileSync(native)).digest('hex');
  }
  return {
    head,
    pid: process.pid,
    dirty: git(['status', '--porcelain']).length > 0,
    sourceSha256: digest.digest('hex'),
    sourceFiles: sources.length,
    node: process.version,
    nodeSha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    platform: process.platform,
    arch: process.arch,
    storageExports: Object.keys(storage).sort(),
    progressExports: Object.keys(progress).sort(),
    storageResolvedToCheckout:
      require.resolve('../../lib/proxy/context-recovery-storage') ===
      path.join(root, 'lib/proxy/context-recovery-storage.js'),
    nativeSha256,
  };
}

module.exports = { diagnosticIdentity };
