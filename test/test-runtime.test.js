'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');

const source = {
  PATH: 'safe-path',
  PROXY_CONFIG_DIR: 'developer-config',
  PROXY_RUNTIME_DIR: 'developer-runtime',
  PROXY_DATA_DIR: 'developer-data',
  PROXY_CERT_DIR: 'developer-certificates',
  NODE_ENV: 'production',
};
const isolated = createIsolatedTestEnv(source, 'isolated-test-runtime');
const isolatedRoot = path.resolve('isolated-test-runtime');

assert.strictEqual(isolated.PATH, 'safe-path');
assert.strictEqual(isolated.PROXY_CONFIG_DIR, path.join(isolatedRoot, 'config'));
assert.strictEqual(isolated.PROXY_RUNTIME_DIR, path.join(isolatedRoot, 'runtime'));
assert.strictEqual(
  isolated.NODE_COMPILE_CACHE,
  path.join(isolatedRoot, 'runtime', '.node-compile-cache')
);
assert.strictEqual(isolated.PROXY_DATA_DIR, undefined);
assert.strictEqual(isolated.PROXY_CERT_DIR, undefined);
assert.strictEqual(source.PROXY_CERT_DIR, 'developer-certificates');
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

const cacheFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-compile-cache-'));
try {
  const coverage = path.join(cacheFixture, 'coverage');
  const sourceEnv = { ...process.env, NODE_V8_COVERAGE: coverage };
  for (const key of Object.keys(sourceEnv))
    if (key.toUpperCase() === 'NODE_DISABLE_COMPILE_CACHE') delete sourceEnv[key];
  const env = createIsolatedTestEnv(sourceEnv, cacheFixture);
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      'const m=require("node:module");process.stdout.write(JSON.stringify({cacheEnabled:m.getCompileCacheDir?.()!==undefined,coverageEnabled:typeof process.env.NODE_V8_COVERAGE==="string"}));',
    ],
    { env, encoding: 'utf8', windowsHide: true, timeout: 10000 }
  );
  assert.strictEqual(child.status, 0);
  assert.deepStrictEqual(JSON.parse(child.stdout), { cacheEnabled: false, coverageEnabled: true });
  assert.strictEqual(env.NODE_DISABLE_COMPILE_CACHE, '1');
  assert.strictEqual(env.node_disable_compile_cache, undefined);
  assert.strictEqual(env.NODE_V8_COVERAGE, coverage);
  assert.ok(fs.readdirSync(coverage).some((name) => /^coverage-.*\.json$/.test(name)));
  const overridden = createIsolatedTestEnv(
    {
      ...sourceEnv,
      NODE_DISABLE_COMPILE_CACHE: '0',
      node_disable_compile_cache: '0',
    },
    cacheFixture
  );
  assert.strictEqual(overridden.NODE_DISABLE_COMPILE_CACHE, '1');
  assert.strictEqual(overridden.node_disable_compile_cache, undefined);
} finally {
  const resolved = path.resolve(cacheFixture);
  assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('hpm-test-compile-cache-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

console.log('[test-runtime.test] ok');
