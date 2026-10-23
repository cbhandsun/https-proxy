'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { discoverTestFiles } = require('../lib/test-discovery');
const { scripts } = require('../package.json');
const source = fs.readFileSync(path.join(__dirname, 'helpers/physical-test-temp.cjs'), 'utf8');

test('client coverage canonicalizes test temp aliases before loading the original full suite', () => {
  assert.match(
    scripts['test:client:coverage'],
    /node --require \.\/test\/helpers\/physical-test-temp\.cjs --test --test-concurrency=4 test\//
  );
});

test('test preload replaces only temp case aliases and resolves the physical directory once', () => {
  for (const initial of [
    {},
    { TEMP: 'short', Temp: 'alias', TMP: 'short', tmp: 'alias', tmpdir: 'alias' },
  ]) {
    const env = { ...initial, PRIVATE_SENTINEL: 'retained', NODE_OPTIONS: 'retained' };
    let calls = 0;
    vm.runInNewContext(source, {
      process: { env },
      require(name) {
        assert.equal(name, '../../lib/test-runtime');
        return {
          resolvePhysicalTestTempDirectory() {
            calls++;
            return 'physical-directory';
          },
        };
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(env, {
      PRIVATE_SENTINEL: 'retained',
      NODE_OPTIONS: 'retained',
      TEMP: 'physical-directory',
      TMP: 'physical-directory',
      TMPDIR: 'physical-directory',
    });
  }
});

test('a failed physical path check stops preload without changing the inherited environment', () => {
  const env = { TEMP: 'invalid', TMP: 'retained' };
  assert.throws(
    () =>
      vm.runInNewContext(source, {
        process: { env },
        require() {
          return {
            resolvePhysicalTestTempDirectory() {
              throw new Error('test_temporary_directory_unavailable');
            },
          };
        },
      }),
    /test_temporary_directory_unavailable/
  );
  assert.deepEqual(env, { TEMP: 'invalid', TMP: 'retained' });
});

test('actual preload resolves an owned alias before child fixtures without mutating the parent', (t) => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'hpm-temp-preload-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = { ...process.env };
  const child = spawnSync(
    process.execPath,
    [
      '--require',
      path.join(__dirname, 'helpers/physical-test-temp.cjs'),
      '-e',
      'const fs=require("node:fs"),os=require("node:os");const d=os.tmpdir();process.stdout.write(JSON.stringify({physical:d===fs.realpathSync.native(d),consistent:["TEMP","TMP","TMPDIR"].every(k=>process.env[k]===d),sentinel:process.env.HPM_TEST_SENTINEL==="retained"}));',
    ],
    {
      env: {
        ...process.env,
        TEMP: alias,
        TMP: alias,
        TMPDIR: alias,
        HPM_TEST_SENTINEL: 'retained',
      },
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }
  );
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), { physical: true, consistent: true, sentinel: true });
  assert.deepEqual({ ...process.env }, before);
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/physical-test-temp.test.js')
  );
});
