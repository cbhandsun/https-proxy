'use strict';
const fs = require('node:fs');
const path = require('node:path');

function regularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw new Error('test_python_unavailable', { cause: error });
  }
}
function resolveTestPython(env, { platform = process.platform, isFile = regularFile } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || typeof isFile !== 'function')
    throw new TypeError('test_python_environment_invalid');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const value = (name, strict = false) => {
    const keys = Object.keys(env).filter((key) =>
      platform === 'win32' ? key.toUpperCase() === name : key === name
    );
    if (keys.some((key) => env[key] !== env[keys[0]])) {
      if (strict) throw new TypeError('test_python_environment_invalid');
      return undefined;
    }
    return keys.length ? env[keys[0]] : undefined;
  };
  const validPath = (file) =>
    typeof file === 'string' &&
    file.length > 0 &&
    file.length <= 32768 &&
    !/[\0\r\n]/.test(file) &&
    paths.isAbsolute(file);
  const explicit = value('HPM_TEST_PYTHON', true);
  if (explicit !== undefined) {
    if (!validPath(explicit) || !isFile(explicit))
      throw new Error('test_python_executable_invalid');
    return explicit;
  }
  const local = value('LOCALAPPDATA');
  if (platform === 'win32' && validPath(local)) {
    const bundled = paths.join(
      local,
      '..',
      '..',
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      'python.exe'
    );
    if (isFile(bundled)) return bundled;
  }
  return platform === 'win32' ? 'python' : 'python3';
}
function parsePythonTestCount(output) {
  if (typeof output !== 'string') return 0;
  const match = /^Ran ([1-9]\d*) tests? in \d+(?:\.\d+)?s\r?$/m.exec(output);
  if (!match) return 0;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : 0;
}

module.exports = { resolveTestPython, parsePythonTestCount };
