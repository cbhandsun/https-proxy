'use strict';

const assert = require('assert');
const { createIsolatedTestEnv } = require('../lib/test-runtime');

const source = {
  PATH: 'safe-path',
  PROXY_CONFIG_DIR: 'developer-config',
  PROXY_RUNTIME_DIR: 'developer-runtime',
  PROXY_DATA_DIR: 'developer-data',
  NODE_ENV: 'production',
};
const isolated = createIsolatedTestEnv(source, 'isolated-test-runtime');

assert.strictEqual(isolated.PATH, 'safe-path');
assert.strictEqual(isolated.PROXY_CONFIG_DIR, undefined);
assert.strictEqual(isolated.PROXY_RUNTIME_DIR, undefined);
assert.strictEqual(isolated.PROXY_DATA_DIR, 'isolated-test-runtime');
assert.strictEqual(isolated.NODE_ENV, 'test');
assert.strictEqual(source.PROXY_CONFIG_DIR, 'developer-config', 'source environment is not mutated');
assert.throws(() => createIsolatedTestEnv({}, ''), /runtimeDir/);
assert.throws(() => createIsolatedTestEnv({}, null), /runtimeDir/);

console.log('[test-runtime.test] ok');
