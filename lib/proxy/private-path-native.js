'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const nativeAclFailure = () =>
  Object.assign(new Error('private_path_unavailable'), { code: 'private_path_unavailable' });

const DEFAULT_EXECUTABLE = path.resolve(
  __dirname,
  '../../runtime/native/hpm-context-recovery-key.exe'
);

function assertPath(file, kind) {
  if (
    typeof file !== 'string' ||
    file.length > 4096 ||
    !path.isAbsolute(file) ||
    /[\0\r\n]/.test(file) ||
    /^[\\/]{2}/.test(file) ||
    !['file', 'directory'].includes(kind) ||
    path.resolve(file) === path.parse(file).root
  )
    throw nativeAclFailure();
  const stat = fs.lstatSync(file, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (kind === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
  )
    throw nativeAclFailure();
  let parent = path.dirname(file);
  while (parent !== path.dirname(parent)) {
    const ancestor = fs.lstatSync(parent);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw nativeAclFailure();
    parent = path.dirname(parent);
  }
  // The validated target observation also pins its exact identity. A second
  // lstat at the same boundary adds I/O without validating another operation.
  return stat;
}

// The caller keeps its inode cache. The native operation additionally pins
// the target and ancestors, replaces the DACL atomically and verifies readback.
// Never retry a dispatched failure through the compatibility backend.
function securePrivatePathNative(
  file,
  kind,
  {
    platform = process.platform,
    nativeExecutable = DEFAULT_EXECUTABLE,
    execute = execFileSync,
  } = {}
) {
  try {
    const before = assertPath(file, kind);
    const environment = {
      SystemRoot: process.env.SystemRoot || process.env.WINDIR,
      WINDIR: process.env.WINDIR || process.env.SystemRoot,
    };
    let native = platform === 'win32';
    if (native) {
      if (typeof nativeExecutable !== 'string' || !nativeExecutable.endsWith('.exe'))
        throw nativeAclFailure();
      try {
        assertPath(nativeExecutable, 'file');
      } catch (error) {
        if (error?.code !== 'ENOENT' || nativeExecutable !== DEFAULT_EXECUTABLE)
          throw nativeAclFailure();
        native = false;
      }
    }
    if (native) {
      const result = execute(nativeExecutable, ['--hpm-context-private-path-v1'], {
        input: JSON.stringify({ path: file, kind }),
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 128,
        windowsHide: true,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result !== '{"ok":true}') throw nativeAclFailure();
      const after = assertPath(file, kind);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.birthtimeNs !== after.birthtimeNs
      )
        throw nativeAclFailure();
    }
    return native;
  } catch {
    throw nativeAclFailure();
  }
}

// execFile's promise wrapper does not write stdin. Keep the bounded native
// protocol asynchronous without putting the path in process arguments.
function executeNativeAsync(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, options, (error, stdout, stderr) => {
      if (error || stderr) reject(nativeAclFailure());
      else resolve(stdout);
    });
    child.stdin.on('error', () => {
      child.kill();
      reject(nativeAclFailure());
    });
    child.stdin.end(options.input);
  });
}

async function securePrivatePathNativeAsync(
  file,
  kind,
  {
    platform = process.platform,
    nativeExecutable = DEFAULT_EXECUTABLE,
    execute = executeNativeAsync,
  } = {}
) {
  try {
    const before = assertPath(file, kind);
    if (platform !== 'win32') return false;
    if (typeof nativeExecutable !== 'string' || !nativeExecutable.endsWith('.exe'))
      throw nativeAclFailure();
    try {
      assertPath(nativeExecutable, 'file');
    } catch (error) {
      // Only absence of the optional default helper permits the existing
      // compatibility backend. Never retry a native dispatch failure there.
      if (error?.code === 'ENOENT' && nativeExecutable === DEFAULT_EXECUTABLE) return false;
      throw nativeAclFailure();
    }
    const result = await execute(nativeExecutable, ['--hpm-context-private-path-v1'], {
      input: JSON.stringify({ path: file, kind }),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 128,
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot || process.env.WINDIR,
        WINDIR: process.env.WINDIR || process.env.SystemRoot,
      },
    });
    if (result !== '{"ok":true}') throw nativeAclFailure();
    const after = assertPath(file, kind);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.birthtimeNs !== after.birthtimeNs
    )
      throw nativeAclFailure();
    return true;
  } catch {
    throw nativeAclFailure();
  }
}

module.exports = { securePrivatePathNative, securePrivatePathNativeAsync };
