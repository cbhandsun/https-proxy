'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');

const fail = () => new Error('Hook fixture toolchain rejected');
const nativeIo = {
  stat: fs.statSync,
  realpath: fs.realpathSync.native,
  executable: (file) => fs.accessSync(file, fs.constants.X_OK),
};

function environmentCopy(input) {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw fail();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length > 8192) throw fail();
  const output = Object.create(null);
  for (const key of keys) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== 'string' ||
      !key ||
      /[=\0\r\n]/.test(key) ||
      !slot?.enumerable ||
      !Object.hasOwn(slot, 'value') ||
      typeof slot.value !== 'string'
    )
      throw fail();
    output[key] = slot.value;
  }
  return output;
}

function oneValue(env, name, required = true) {
  const keys = Object.keys(env).filter((key) => key.toLowerCase() === name.toLowerCase());
  if (keys.length > 1 || (required && keys.length !== 1)) throw fail();
  return keys.length ? env[keys[0]] : undefined;
}

// Resolve Git once before fixture setup. Only selected tool directories survive
// into the fixture PATH; absent inherited search directories are not retained.
function createHookFixtureTools(input, io = nativeIo) {
  try {
    if (!input || typeof input !== 'object' || types.isProxy(input)) throw fail();
    const slots = {};
    for (const key of ['binDirectory', 'nodeExecutable', 'environment', 'platform']) {
      const slot = Object.getOwnPropertyDescriptor(input, key);
      if (slot && !Object.hasOwn(slot, 'value')) throw fail();
      slots[key] = slot?.value;
    }
    const platform = slots.platform ?? process.platform;
    if (
      !['win32', 'aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos'].includes(
        platform
      )
    )
      throw fail();
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    const delimiter = paths.delimiter;
    const identity = (file) => (windows ? file.toLowerCase() : file);
    function absolute(value) {
      if (
        typeof value !== 'string' ||
        !value ||
        value.length > 32768 ||
        !value.isWellFormed() ||
        value !== value.trim() ||
        [...value].some((character) => character.codePointAt(0) < 32) ||
        /["\u007f\u2028\u2029]/.test(value) ||
        value.includes(delimiter) ||
        !paths.isAbsolute(value) ||
        (windows && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':'))) ||
        value.split(windows ? /[\\/]/ : /\//).some((part) => part === '.' || part === '..')
      )
        throw fail();
      return paths.normalize(value);
    }
    function checked(value, directory) {
      const file = absolute(value);
      const stat = io.stat(file);
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw fail();
      const physical = absolute(io.realpath(file));
      if (!directory) io.executable(physical);
      return physical;
    }
    function existingFile(file) {
      try {
        return io.stat(file).isFile();
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
        throw fail();
      }
    }
    const env = environmentCopy(slots.environment);
    const inherited = oneValue(env, 'PATH');
    if (!inherited || inherited.length > 32768) throw fail();
    const search = inherited.split(delimiter);
    if (search.length > 512 || search.some((entry) => !entry)) throw fail();
    const extensions = windows
      ? (oneValue(env, 'PATHEXT', false) ?? '.EXE;.CMD;.BAT;.COM').toUpperCase().split(';')
      : [''];
    if (
      windows &&
      (extensions.length > 32 ||
        extensions.some((extension) => !/^\.[A-Z0-9]{1,16}$/.test(extension)) ||
        !extensions.includes('.EXE') ||
        !extensions.includes('.CMD'))
    )
      throw fail();
    let gitExecutable;
    const visited = new Set();
    for (const entry of search) {
      const directory = absolute(
        entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry
      );
      if (visited.has(identity(directory))) continue;
      visited.add(identity(directory));
      for (const extension of extensions) {
        const file = paths.join(directory, 'git' + extension);
        if (!existingFile(file)) continue;
        if (windows && extension !== '.EXE') throw fail();
        gitExecutable = checked(file, false);
        break;
      }
      if (gitExecutable) break;
    }
    if (!gitExecutable) throw fail();
    const directories = [
      checked(slots.binDirectory, true),
      checked(paths.dirname(checked(slots.nodeExecutable, false)), true),
      checked(paths.dirname(gitExecutable), true),
    ];
    if (windows) {
      const systemRoot = checked(oneValue(env, 'SystemRoot'), true);
      const system32 = checked(paths.join(systemRoot, 'System32'), true);
      checked(paths.join(system32, 'cmd.exe'), false);
      directories.push(system32, systemRoot);
    } else {
      for (const directory of ['/usr/bin', '/bin']) directories.push(checked(directory, true));
    }
    const unique = [
      ...new Map(directories.map((directory) => [identity(directory), directory])).values(),
    ];
    // Earlier tool directories must not silently select a different Git binary.
    for (const directory of unique) {
      for (const extension of extensions) {
        const file = paths.join(directory, 'git' + extension);
        if (!existingFile(file)) continue;
        if (identity(checked(file, false)) !== identity(gitExecutable)) throw fail();
        break;
      }
      if (identity(directory) === identity(paths.dirname(gitExecutable))) break;
    }
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path' || (windows && key.toLowerCase() === 'pathext'))
        delete env[key];
    }
    env.PATH = unique.join(delimiter);
    if (windows) env.PATHEXT = extensions.join(';');
    return Object.freeze({ gitExecutable, env });
  } catch {
    // No paths, command arguments, native errors, or environment values escape.
    throw fail();
  }
}

module.exports = { createHookFixtureTools };
