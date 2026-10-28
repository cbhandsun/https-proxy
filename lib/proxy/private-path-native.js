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

const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
const identity = ({ dev, ino, birthtimeNs }) => Object.freeze({ dev, ino, birthtimeNs });

function receiptIdentity(input) {
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !== 'birthtimeNs,dev,ino'
  )
    throw nativeAclFailure();
  const output = {};
  for (const key of ['dev', 'ino', 'birthtimeNs']) {
    const value = input[key];
    if (
      typeof value !== 'string' ||
      value.length > 24 ||
      !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)
    )
      throw nativeAclFailure();
    const number = BigInt(value);
    if (
      key === 'birthtimeNs'
        ? number < -11644473600000000000n ||
          number > (9223372036854775807n - 116444736000000000n) * 100n
        : number < 0n || number > 18446744073709551615n
    )
      throw nativeAclFailure();
    output[key] = number;
  }
  return identity(output);
}

// Directory admission and the fixed writer's ACL share one native process.
// The native handles, rather than a later pathname observation, supply both
// identities. The caller may consume this proof only for that exact writer.
function prepareStorageDirectoryNative(
  directory,
  {
    platform = process.platform,
    nativeExecutable = DEFAULT_EXECUTABLE,
    execute = execFileSync,
    onDispatch,
  } = {}
) {
  try {
    if (onDispatch !== undefined && typeof onDispatch !== 'function') throw nativeAclFailure();
    const before = assertPath(directory, 'directory');
    if (platform !== 'win32') return null;
    if (typeof nativeExecutable !== 'string' || !nativeExecutable.endsWith('.exe'))
      throw nativeAclFailure();
    try {
      assertPath(nativeExecutable, 'file');
    } catch (error) {
      if (error?.code === 'ENOENT' && nativeExecutable === DEFAULT_EXECUTABLE) return null;
      throw nativeAclFailure();
    }
    onDispatch?.();
    const text = execute(nativeExecutable, ['--hpm-context-storage-directory-v1'], {
      input: JSON.stringify({ path: directory, kind: 'directory' }),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 512,
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot || process.env.WINDIR,
        WINDIR: process.env.WINDIR || process.env.SystemRoot,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (typeof text !== 'string' || Buffer.byteLength(text) > 512) throw nativeAclFailure();
    const receipt = JSON.parse(text);
    if (
      !receipt ||
      Array.isArray(receipt) ||
      Object.keys(receipt).sort().join(',') !== 'directory,ok,writer' ||
      receipt.ok !== true ||
      JSON.stringify(receipt) !== text
    )
      throw nativeAclFailure();
    const directoryIdentity = receiptIdentity(receipt.directory);
    const writerIdentity = receiptIdentity(receipt.writer);
    const after = assertPath(directory, 'directory');
    const writer = assertPath(path.join(directory, '.writer.sqlite'), 'file');
    if (
      !sameIdentity(before, after) ||
      !sameIdentity(before, directoryIdentity) ||
      !sameIdentity(writer, writerIdentity) ||
      writer.size > 1048576n
    )
      throw nativeAclFailure();
    return Object.freeze({ directory: directoryIdentity, writer: writerIdentity });
  } catch {
    throw nativeAclFailure();
  }
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

module.exports = {
  securePrivatePathNative,
  securePrivatePathNativeAsync,
  prepareStorageDirectoryNative,
};
