'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');

const repoRoot = path.resolve(__dirname, '..');
const homeKeys = [
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
];

test('fixture home variables replace inherited aliases without mutating the parent', () => {
  const base = Object.fromEntries(
    homeKeys.flatMap((key) => [
      [key, 'outside'],
      [key.toLowerCase(), 'outside-alias'],
    ])
  );
  base.Path = 'preserved-path';
  base.Proxy_Config_Dir = 'outside-proxy';
  base.Node_Compile_Cache = 'outside-cache';
  const original = { ...base };
  const fixtureRoot = path.resolve('isolated fixture home');
  const env = createIsolatedTestEnv(base, fixtureRoot);
  const home = path.join(fixtureRoot, 'home');
  assert.deepEqual(base, original);
  assert.equal(env.Path, base.Path);
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.CODEX_HOME, path.join(home, '.codex'));
  assert.equal(env.APPDATA, path.join(home, 'AppData', 'Roaming'));
  assert.equal(env.LOCALAPPDATA, path.join(home, 'AppData', 'Local'));
  for (const key of homeKeys) assert.equal(Object.hasOwn(env, key.toLowerCase()), false);
  assert.equal(Object.hasOwn(env, 'Proxy_Config_Dir'), false);
  assert.equal(Object.hasOwn(env, 'Node_Compile_Cache'), false);
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    const relative = path.relative(home, env[key]);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  if (process.platform === 'win32') assert.equal(env.HOMEDRIVE + env.HOMEPATH, home);
  else {
    assert.equal(env.HOMEDRIVE, undefined);
    assert.equal(env.HOMEPATH, undefined);
  }
});

test('empty and malformed environments and workspace boundaries stay explicit', () => {
  const env = createIsolatedTestEnv({}, 'fixture');
  assert.equal(env.HOME, path.resolve('fixture', 'home'));
  for (const base of [null, [], undefined, 1, 'outside'])
    assert.throws(() => createIsolatedTestEnv(base, 'fixture'), /baseEnv/);
  for (const directory of [null, undefined, 1, '', '  ', 'bad\0path', 'x'.repeat(8192) + '\0'])
    assert.throws(() => createIsolatedTestEnv({}, directory), /workspaceDir/);
});

test('home isolation regression participates in the unified unit gate', () => {
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(repoRoot), {
      excludedPrefixes: ['test/frontend/'],
    }).includes('test/test-runtime-home-isolation.test.js')
  );
});
