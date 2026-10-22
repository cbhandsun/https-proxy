'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const nativeBuildFailure = () => new Error('context_recovery_native_build_failed');
const sameFile = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;

function readNativeArtifact(file, optional = false, buildSource = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file))
    throw nativeBuildFailure();
  let ancestor = path.dirname(file);
  while (ancestor !== path.dirname(ancestor)) {
    const stat = fs.lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw nativeBuildFailure();
    ancestor = path.dirname(ancestor);
  }
  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink < 1n ||
    (!buildSource && before.nlink !== 1n) ||
    before.size < 1n ||
    before.size > 16777216n
  )
    throw nativeBuildFailure();
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, opened) || opened.nlink !== before.nlink || opened.size !== before.size)
      throw nativeBuildFailure();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fs.lstatSync(file, { bigint: true });
    const final = fs.fstatSync(descriptor, { bigint: true });
    if (
      !sameFile(opened, after) ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      final.mtimeNs !== before.mtimeNs ||
      BigInt(offset) !== before.size
    )
      throw nativeBuildFailure();
    return bytes.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

// Retain the installed inode when a verified build is byte-identical. Repeated
// preparation must not replace an executable that a running worker may launch.
function installContextRecoveryNativeArtifact(source, destination) {
  // Cargo hard-links its release output to its own build cache. Read that
  // pinned object as data, then create an independent installed file; never
  // execute a linked destination or carry a build-cache hard link into runtime.
  const bytes = readNativeArtifact(source, false, true);
  const installed = readNativeArtifact(destination, true);
  if (installed?.equals(bytes)) return destination;
  const temporary = destination + '.' + randomUUID() + '.staged';
  let staged = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o700);
    staged = true;
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (!readNativeArtifact(temporary).equals(bytes)) throw nativeBuildFailure();
    fs.renameSync(temporary, destination);
    staged = false;
    return destination;
  } finally {
    if (staged) fs.unlinkSync(temporary);
  }
}

function prepareContextRecoveryNative({ test = false } = {}) {
  if (process.platform !== 'win32') return null;
  const root = path.resolve(__dirname, '..');
  const target = path.join(root, 'src-tauri/target/context-recovery-native');
  const manifest = path.join(root, 'native/context-recovery-key/Cargo.toml');
  if (test) {
    for (const args of [
      ['fmt', '--manifest-path', manifest, '--', '--check'],
      [
        'clippy',
        '--locked',
        '--manifest-path',
        manifest,
        '--target-dir',
        target,
        '--all-targets',
        '--',
        '-D',
        'warnings',
      ],
    ]) {
      const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit', windowsHide: true });
      if (result.status !== 0) throw new Error('context_recovery_native_build_failed');
    }
  }
  const command = test ? 'test' : 'build';
  const args = [
    command,
    '--locked',
    '--release',
    '--manifest-path',
    manifest,
    '--target-dir',
    target,
  ];
  if (test) args.push('--all-targets');
  const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('context_recovery_native_build_failed');
  if (test) return null;
  const source = path.join(target, 'release/hpm-context-recovery-key.exe');
  const destination = path.join(root, 'runtime/native/hpm-context-recovery-key.exe');
  if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink())
    throw new Error('context_recovery_native_build_failed');
  for (const relative of ['runtime', 'runtime/native']) {
    const directory = path.join(root, relative);
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('context_recovery_native_build_failed');
  }
  // Rename a complete build on the same filesystem; never expose a partial exe.
  return installContextRecoveryNativeArtifact(source, destination);
}

if (require.main === module) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--test'))
      throw new Error('context_recovery_native_build_failed');
    prepareContextRecoveryNative({ test: process.argv[2] === '--test' });
  } catch {
    process.stderr.write('context_recovery_native_build_failed\n');
    process.exitCode = 1;
  }
}
module.exports = { prepareContextRecoveryNative, installContextRecoveryNativeArtifact };
