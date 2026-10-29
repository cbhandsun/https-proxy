'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { resolveTestPython } = require('./test-python-runtime');

function resolvePhysicalTestTempDirectory(input = os.tmpdir()) {
  try {
    if (
      typeof input !== 'string' ||
      !input.trim() ||
      input.length > 32768 ||
      !path.isAbsolute(input) ||
      /[\0\r\n]/.test(input)
    )
      throw new Error();
    const physical = fs.realpathSync.native(input);
    const stat = fs.lstatSync(physical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    return physical;
  } catch {
    throw new Error('test_temporary_directory_unavailable');
  }
}

function createIsolatedTestEnv(baseEnv, workspaceDir) {
  if (!baseEnv || typeof baseEnv !== 'object' || Array.isArray(baseEnv)) {
    throw new TypeError('baseEnv must be an object');
  }
  if (typeof workspaceDir !== 'string' || workspaceDir.trim() === '') {
    throw new TypeError('workspaceDir must be a non-empty string');
  }
  if (workspaceDir.includes('\0')) {
    throw new TypeError('workspaceDir must not contain null bytes');
  }
  const workspaceRoot = path.resolve(workspaceDir);
  // Locate an installed interpreter before replacing the user's home. Only its
  // executable path crosses the boundary; Python data/config homes stay isolated.
  const python = resolveTestPython(baseEnv);
  const env = { ...baseEnv };
  // Match Node's platform-specific tmp precedence, then remove all case aliases.
  // Existing short names/junctions are resolved only for test fixture placement;
  // product path guards still inspect every physical ancestor independently.
  const tempKeys = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR', 'TMP', 'TEMP'];
  const inheritedKeys = Object.keys(baseEnv);
  let tempDirectory;
  for (const name of tempKeys) {
    const key = Object.hasOwn(baseEnv, name)
      ? name
      : inheritedKeys.find((candidate) => candidate.toUpperCase() === name);
    if (key !== undefined) {
      const selected = baseEnv[key];
      if (selected === undefined) throw new Error('test_temporary_directory_unavailable');
      tempDirectory = resolvePhysicalTestTempDirectory(selected);
      break;
    }
  }
  tempDirectory ??= resolvePhysicalTestTempDirectory();
  // Fixture startup can synchronize client catalogs via os.homedir(). Isolate
  // the child's home and per-user config paths, not just proxy-owned storage.
  // Remove case variants too: Windows deduplicates environment keys when
  // spawning a child, so an inherited `UserProfile` must not win over ours.
  const isolatedKeys = new Set([
    'PROXY_DATA_DIR',
    'PROXY_CONFIG_DIR',
    'PROXY_RUNTIME_DIR',
    'PROXY_CERT_DIR',
    'NODE_COMPILE_CACHE',
    'NODE_DISABLE_COMPILE_CACHE',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'CODEX_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'HPM_TEST_PYTHON',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]);
  for (const key of Object.keys(env)) if (isolatedKeys.has(key.toUpperCase())) delete env[key];
  env.TEMP = tempDirectory;
  env.TMP = tempDirectory;
  env.TMPDIR = tempDirectory;
  if (path.isAbsolute(python)) env.HPM_TEST_PYTHON = python;
  const testHome = path.join(workspaceRoot, 'home');
  env.HOME = testHome;
  env.USERPROFILE = testHome;
  if (process.platform === 'win32') {
    env.HOMEDRIVE = path.parse(testHome).root.slice(0, -1);
    env.HOMEPATH = testHome.slice(env.HOMEDRIVE.length);
  }
  env.CODEX_HOME = path.join(testHome, '.codex');
  env.APPDATA = path.join(testHome, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(testHome, 'AppData', 'Local');
  env.XDG_CONFIG_HOME = path.join(testHome, '.config');
  env.XDG_DATA_HOME = path.join(testHome, '.local', 'share');
  env.XDG_CACHE_HOME = path.join(testHome, '.cache');
  env.XDG_STATE_HOME = path.join(testHome, '.local', 'state');
  env.PROXY_CONFIG_DIR = path.join(workspaceRoot, 'config');
  env.PROXY_RUNTIME_DIR = path.join(workspaceRoot, 'runtime');
  env.NODE_COMPILE_CACHE = path.join(env.PROXY_RUNTIME_DIR, '.node-compile-cache');
  // Node recommends disabling the module compile cache when generating precise
  // V8 test coverage. Keep the path isolated, but never deserialize cached code
  // or generate throwaway per-fixture caches in this test environment.
  // https://nodejs.org/docs/latest-v22.x/api/module.html#module-compile-cache
  env.NODE_DISABLE_COMPILE_CACHE = '1';
  env.NODE_ENV = 'test';
  return env;
}

module.exports = { createIsolatedTestEnv, resolvePhysicalTestTempDirectory };
