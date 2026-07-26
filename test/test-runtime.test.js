'use strict';

const assert = require('assert');
const path = require('path');
const { createIsolatedTestEnv } = require('../lib/test-runtime');

const source = {
  PATH: 'safe-path',
  PROXY_CONFIG_DIR: 'developer-config',
  PROXY_RUNTIME_DIR: 'developer-runtime',
  PROXY_DATA_DIR: 'developer-data',
  NODE_ENV: 'production',
};
const isolated = createIsolatedTestEnv(source, 'isolated-test-runtime');
const isolatedRoot = path.resolve('isolated-test-runtime');

assert.strictEqual(isolated.PATH, 'safe-path');
assert.strictEqual(isolated.PROXY_CONFIG_DIR, path.join(isolatedRoot, 'config'));
assert.strictEqual(isolated.PROXY_RUNTIME_DIR, path.join(isolatedRoot, 'runtime'));
assert.strictEqual(isolated.PROXY_DATA_DIR, undefined);
assert.strictEqual(isolated.NODE_ENV, 'test');
assert.strictEqual(
  source.PROXY_CONFIG_DIR,
  'developer-config',
  'source environment is not mutated'
);
assert.throws(() => createIsolatedTestEnv({}, ''), /workspaceDir/);
assert.throws(() => createIsolatedTestEnv({}, '   '), /workspaceDir/);
assert.throws(() => createIsolatedTestEnv({}, null), /workspaceDir/);
assert.throws(() => createIsolatedTestEnv({}, 'bad\0path'), /null bytes/);
assert.throws(() => createIsolatedTestEnv(null, 'runtime'), /baseEnv/);
assert.throws(() => createIsolatedTestEnv([], 'runtime'), /baseEnv/);

console.log('[test-runtime.test] ok');
