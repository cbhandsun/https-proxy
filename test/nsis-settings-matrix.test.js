'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const testTempRoot = resolvePhysicalTestTempDirectory();
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  runSettingsCombination,
  combinations,
} = require('../scripts/lib/nsis-settings-matrix-case');
const { discoverTestFiles } = require('../lib/test-discovery');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// This fixture deliberately never executes native code. It proves the harness,
// not DPAPI, actual storage startup or installed product behavior.
function syntheticRuntime({ dataDirectory }) {
  assert.equal(arguments.length, 1);
  assert.deepEqual(Object.keys(arguments[0]), ['dataDirectory']);
  let enabled = false,
    persistent = false,
    closed = false;
  return {
    configureSettings(config) {
      enabled = config.appSettings.contextRecoveryEnabled;
      persistent = config.appSettings.contextRecoveryPersistenceEnabled;
    },
    async ready() {
      if (enabled && persistent) {
        const dir = path.join(dataDirectory, 'context-recovery-v1');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '.data-key'), 'hpm-context-dpapi-v1:AA==');
        fs.writeFileSync(path.join(dir, '.writer.sqlite'), '');
        fs.writeFileSync(path.join(dir, 'checkpoint.sqlite'), 'SQLite format 3\0');
      }
      return { ok: true };
    },
    inspect() {
      return {
        requestedEnabled: enabled,
        requestedPersistence: persistent,
        appliedEnabled: enabled && !closed,
        appliedPersistence: enabled && persistent,
        storage: enabled && persistent ? 'persistent' : 'memory',
        state: closed ? 'closed' : enabled ? 'enabled' : 'disabled',
        restartRetention: false,
      };
    },
    async shutdownAsync() {
      closed = true;
      return { ok: true };
    },
  };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(testTempRoot, 'hpm-settings-unit-'));
  for (const name of ['config', 'data']) fs.mkdirSync(path.join(root, name));
  return root;
}
async function withFixture(work) {
  const root = fixture();
  try {
    await work(root);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(testTempRoot) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('all policy combinations use only dataDirectory and independent roots', async () => {
  for (const combination of combinations)
    await withFixture(async (root) => {
      assert.deepEqual(
        await runSettingsCombination({
          combination,
          caseRoot: root,
          runtimeApi: { createContextRecoveryRuntime: syntheticRuntime },
        }),
        {
          combination,
          checks: ['policy_applied', 'storage_boundary', 'shutdown_acknowledged'],
          restartRetention: false,
        }
      );
    });
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/nsis-settings-matrix.test.js')
  );
});
test('empty, illegal, proxy, extra input and occupied directories fail sanitized', async () => {
  await withFixture(async (root) => {
    const valid = {
      combination: '00',
      caseRoot: root,
      runtimeApi: { createContextRecoveryRuntime: syntheticRuntime },
    };
    for (const input of [
      null,
      {},
      { ...valid, combination: '99' },
      { ...valid, combination: '' },
      { ...valid, extra: true },
      new Proxy(valid, {}),
      { ...valid, caseRoot: root + '/missing' },
    ])
      await assert.rejects(runSettingsCombination(input), /^Error: nsis_settings_matrix_failed$/);
    fs.writeFileSync(path.join(root, 'config', 'existing'), 'PRIVATE_INPUT');
    await assert.rejects(runSettingsCombination(valid), /^Error: nsis_settings_matrix_failed$/);
  });
});
test('accessors never execute and rejected input never acquires a runtime', async () => {
  await withFixture(async (root) => {
    let factoryCalls = 0,
      getterCalls = 0,
      shutdownCalls = 0;
    const runtimeApi = {
      createContextRecoveryRuntime() {
        factoryCalls++;
        return syntheticRuntime(...arguments);
      },
    };
    const valid = { combination: '00', caseRoot: root, runtimeApi };
    const accessor = { ...valid };
    Object.defineProperty(accessor, 'combination', {
      enumerable: true,
      get() {
        getterCalls++;
        throw new Error('PRIVATE_ACCESSOR_CONTENT');
      },
    });
    for (const input of [
      accessor,
      { ...valid, combination: 'illegal' },
      { ...valid, caseRoot: root + '/missing' },
    ]) {
      await assert.rejects(runSettingsCombination(input), /^Error: nsis_settings_matrix_failed$/);
    }
    fs.writeFileSync(path.join(root, 'data', 'occupied'), 'PRIVATE_ACCESSOR_CONTENT');
    await assert.rejects(runSettingsCombination(valid), /^Error: nsis_settings_matrix_failed$/);
    fs.unlinkSync(path.join(root, 'data', 'occupied'));
    assert.equal(factoryCalls, 0);
    assert.equal(getterCalls, 0);
    const unsafeApi = {
      createContextRecoveryRuntime(options) {
        const runtime = syntheticRuntime(options);
        const close = runtime.shutdownAsync;
        runtime.shutdownAsync = async () => {
          shutdownCalls++;
          return close();
        };
        Object.defineProperty(runtime, 'ready', {
          enumerable: true,
          get() {
            getterCalls++;
            throw new Error('PRIVATE_ACCESSOR_CONTENT');
          },
        });
        return runtime;
      },
    };
    await assert.rejects(
      runSettingsCombination({ ...valid, runtimeApi: unsafeApi }),
      /^Error: nsis_settings_matrix_failed$/
    );
    assert.equal(getterCalls, 0);
    assert.equal(shutdownCalls, 1);
  });
});
test('initialization, unsafe file, wrong state and shutdown failures cannot pass', async () => {
  for (const mode of [
    'startup',
    'shutdown',
    'retention',
    'unexpected-file',
    'invalid-key',
    'hardlink',
    'oversized-key',
    'wrong-ready',
    'missing-method',
  ])
    await withFixture(async (root) => {
      let shutdown = false;
      const factory = (options) => {
        const runtime = syntheticRuntime(options);
        const ready = runtime.ready,
          close = runtime.shutdownAsync,
          inspect = runtime.inspect;
        runtime.ready = async () => {
          if (mode === 'startup') throw new Error('PRIVATE_NATIVE_CONTENT');
          const reply = await ready();
          const dir = path.join(options.dataDirectory, 'context-recovery-v1');
          if (mode === 'unexpected-file')
            fs.writeFileSync(path.join(dir, 'unexpected'), 'PRIVATE_NATIVE_CONTENT');
          if (mode === 'invalid-key')
            fs.writeFileSync(path.join(dir, '.data-key'), 'PRIVATE_NATIVE_CONTENT');
          if (mode === 'hardlink')
            fs.linkSync(path.join(dir, '.data-key'), path.join(root, 'linked-key'));
          if (mode === 'oversized-key')
            fs.writeFileSync(path.join(dir, '.data-key'), 'x'.repeat(17001));
          if (mode === 'wrong-ready') return { ok: true, extra: 'PRIVATE_NATIVE_CONTENT' };
          return reply;
        };
        runtime.inspect = () => ({
          ...inspect(),
          ...(mode === 'retention' ? { restartRetention: true } : {}),
        });
        runtime.shutdownAsync = async () => {
          shutdown = true;
          if (mode === 'shutdown') throw new Error('PRIVATE_NATIVE_CONTENT');
          return close();
        };
        if (mode === 'missing-method') delete runtime.ready;
        return runtime;
      };
      await assert.rejects(
        runSettingsCombination({
          combination: '11',
          caseRoot: root,
          runtimeApi: { createContextRecoveryRuntime: factory },
        }),
        /^Error: nsis_settings_matrix_failed$/
      );
      assert.equal(shutdown, true);
    });
});

test(
  'PowerShell controller runs four isolated synthetic payload children and refuses identity/schema failures',
  { timeout: 540000 },
  () => {
    const root = fs.mkdtempSync(path.join(testTempRoot, 'hpm-settings-composition-'));
    try {
      const install = path.join(root, 'installed');
      fs.mkdirSync(path.join(install, 'runtime/node'), { recursive: true });
      fs.mkdirSync(path.join(install, 'runtime/native'), { recursive: true });
      fs.mkdirSync(path.join(install, 'lib/proxy'), { recursive: true });
      const node = path.join(install, 'runtime/node/node.exe');
      fs.copyFileSync(process.execPath, node);
      const placeholder = 'never-executed-helper-placeholder';
      fs.writeFileSync(
        path.join(install, 'runtime/native/hpm-context-recovery-key.exe'),
        placeholder
      );
      fs.writeFileSync(path.join(install, 'package-lock.json'), '{}');
      const runtime =
        "const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');module.exports={createContextRecoveryRuntime:" +
        syntheticRuntime.toString() +
        '};';
      fs.writeFileSync(path.join(install, 'lib/proxy/context-recovery-runtime.js'), runtime);
      const manifest = JSON.stringify({
        schemaVersion: 2,
        sourceSha256: { 'lib/proxy/context-recovery-runtime.js': hash(runtime) },
        nodeSha256: hash(fs.readFileSync(node)),
        contextRecoveryNativeSha256: hash(placeholder),
        packageLockSha256: hash('{}'),
      });
      fs.writeFileSync(path.join(install, 'release-runtime-manifest.json'), manifest);
      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-File', 'test/fixtures/nsis-settings-matrix-mocks.ps1'],
        {
          encoding: 'utf8',
          timeout: 520000,
          maxBuffer: 16384,
          env: {
            ...process.env,
            HPM_MATRIX_TEST_ROOT: root,
            HPM_MATRIX_TEST_SHA: hash(manifest),
            NODE_OPTIONS: '--require=PRIVATE_PRELOAD_SENTINEL',
            NODE_PATH: 'PRIVATE_PATH_SENTINEL',
            PROXY_TEST_SENTINEL: 'PRIVATE_CONFIG_SENTINEL',
          },
        }
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /syntheticCombinations=4; schemaAndIdentityRefusals=\d+; nativeExecutions=0; networkRequests=0/
      );
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
      const cases = fs
        .readdirSync(root)
        .filter((name) => /^settings-[01]{2}-[a-f0-9]{32}$/.test(name));
      assert.equal(cases.length, 4);
      assert.equal(
        new Set(cases.map((name) => fs.statSync(path.join(root, name, 'data')).ino)).size,
        4
      );
    } finally {
      assert.ok(path.resolve(root).startsWith(path.resolve(testTempRoot) + path.sep));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
