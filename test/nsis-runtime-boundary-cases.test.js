'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const testTempRoot = resolvePhysicalTestTempDirectory();
const path = require('node:path');
const { discoverTestFiles } = require('../lib/test-discovery');
const runtimeApi = require('../lib/proxy/context-recovery-runtime');
const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
const { runRuntimeBoundaryCase } = require('../scripts/lib/nsis-runtime-boundary-cases');

function fixture(t) {
  const caseRoot = fs.mkdtempSync(path.join(testTempRoot, 'hpm-runtime-case-'));
  const configDirectory = path.join(caseRoot, 'config');
  const dataDirectory = path.join(caseRoot, 'data');
  fs.mkdirSync(configDirectory);
  fs.mkdirSync(dataDirectory);
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  const configApi = {
    CONFIG_DIR: configDirectory,
    CONFIG_FILE: path.join(configDirectory, 'proxy.config.json'),
    DATA_DIR: dataDirectory,
    loadConfig() {
      return {
        appSettings: { contextRecoveryEnabled: false, contextRecoveryPersistenceEnabled: false },
      };
    },
  };
  return { caseRoot, configApi, runtimeApi };
}
const safe = (error) => {
  assert.equal(error.message, 'nsis_runtime_boundary_case_failed');
  assert.equal(error.cause, undefined);
  assert.equal(error.code, undefined);
  return true;
};

test('capability invocation preserves its receiver without reading a function bind getter', async (t) => {
  const f = fixture(t);
  let reads = 0;
  let calls = 0;
  f.configApi.loadConfig = function () {
    assert.equal(this, f.configApi);
    calls++;
    return {};
  };
  Object.defineProperty(f.configApi.loadConfig, 'bind', {
    get() {
      reads++;
      throw new Error('PRIVATE_BIND_GETTER');
    },
  });
  const result = await runRuntimeBoundaryCase({ ...f, caseId: 'defaults-migration' });
  assert.equal(result.complete, false);
  assert.equal(calls, 1);
  assert.equal(reads, 0);
});

test('capability invocation rejects a proxy function before invoking any traps', async (t) => {
  const f = fixture(t);
  let traps = 0;
  f.configApi.loadConfig = new Proxy(() => ({}), {
    get() {
      traps++;
      throw new Error('PRIVATE_PROXY_GET');
    },
    apply() {
      traps++;
      throw new Error('PRIVATE_PROXY_APPLY');
    },
  });
  await assert.rejects(runRuntimeBoundaryCase({ ...f, caseId: 'defaults-migration' }), safe);
  assert.equal(traps, 0);
  assert.deepEqual(fs.readdirSync(f.configApi.DATA_DIR), []);
});

test('empty defaults subcheck executes supplied config and runtime without claiming migration', async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.configApi.loadConfig = () => {
    reads++;
    return {};
  };
  const result = await runRuntimeBoundaryCase({ ...f, caseId: 'defaults-migration' });
  assert.deepEqual(result, {
    caseId: 'defaults-migration',
    scope: 'module_api',
    complete: false,
    checks: [
      'empty_config_directory',
      'default_policy_disabled',
      'runtime_disabled',
      'shutdown_acknowledged',
    ],
  });
  assert.equal(reads, 1);
  assert.deepEqual(fs.readdirSync(f.configApi.CONFIG_DIR), []);
  assert.deepEqual(fs.readdirSync(f.configApi.DATA_DIR), []);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
});

test('settings matrix checks all four combinations and closes each owner; persistence is synthetic', async (t) => {
  const f = fixture(t);
  const modes = [];
  f.runtimeApi = {
    recoveryStorageSettings: runtimeApi.recoveryStorageSettings,
    createContextRecoveryRuntime(options) {
      return runtimeApi.createContextRecoveryRuntime({
        ...options,
        prepareDirectory() {},
        createLifecycle(mode) {
          modes.push(!!mode.directory);
          const owner = createContextRecoveryLifecycle();
          const inspect = owner.inspect;
          owner.inspect = () => ({
            ...inspect(),
            storage: mode.directory ? 'persistent' : 'memory',
          });
          return owner;
        },
      });
    },
  };
  const result = await runRuntimeBoundaryCase({ ...f, caseId: 'settings-matrix' });
  assert.equal(result.complete, true);
  assert.deepEqual(result.checks, [
    'settings_00',
    'settings_01',
    'settings_10',
    'settings_11',
    'shutdown_acknowledged',
  ]);
  assert.deepEqual(modes, [false, false, false, false, true]);
  assert.deepEqual(fs.readdirSync(f.configApi.DATA_DIR), []);
});

test('real default runtime fails closed on a regular file at storage directory', async (t) => {
  const f = fixture(t);
  const result = await runRuntimeBoundaryCase({ ...f, caseId: 'initialization-failure' });
  assert.deepEqual(result.checks, [
    'storage_directory_blocked',
    'initialization_failed_closed',
    'reenable_rejected',
    'shutdown_failure_acknowledged',
  ]);
  assert.equal(result.complete, true);
  const blocker = path.join(f.configApi.DATA_DIR, 'context-recovery-v1');
  assert.equal(fs.lstatSync(blocker).isFile(), true);
  assert.equal(fs.statSync(blocker).size, 0);
  assert.deepEqual(fs.readdirSync(f.configApi.DATA_DIR), ['context-recovery-v1']);
});

test('unimplemented cases and malformed capabilities fail before calling APIs or creating blockers', async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.configApi.loadConfig = () => {
    calls++;
    throw new Error('PRIVATE_TOKEN');
  };
  for (const caseId of [
    'switch-revoke',
    'reopen-clear',
    'kill-after-durable-ack',
    '',
    null,
    'x'.repeat(100000),
  ]) {
    await assert.rejects(runRuntimeBoundaryCase({ ...f, caseId }), safe);
  }
  const accessor = { ...f, caseId: 'settings-matrix' };
  Object.defineProperty(accessor, 'runtimeApi', {
    enumerable: true,
    get() {
      calls++;
      return undefined;
    },
  });
  for (const input of [
    null,
    [],
    {},
    accessor,
    new Proxy({}, {}),
    { ...f, caseId: 'settings-matrix', extra: true },
    { ...f, runtimeApi: {}, caseId: 'settings-matrix' },
  ]) {
    await assert.rejects(runRuntimeBoundaryCase(input), safe);
  }
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(f.configApi.DATA_DIR), []);
});

test('nonempty or mismatched directories reject without executing trusted APIs', async (t) => {
  for (const mode of [
    'config-nonempty',
    'data-nonempty',
    'config-path',
    'data-path',
    'file-path',
  ]) {
    const f = fixture(t);
    let calls = 0;
    f.configApi.loadConfig = () => {
      calls++;
      return {};
    };
    if (mode === 'config-nonempty')
      fs.writeFileSync(path.join(f.configApi.CONFIG_DIR, 'existing'), 'retained');
    if (mode === 'data-nonempty')
      fs.writeFileSync(path.join(f.configApi.DATA_DIR, 'existing'), 'retained');
    if (mode === 'config-path') f.configApi.CONFIG_DIR = f.caseRoot;
    if (mode === 'data-path') f.configApi.DATA_DIR = f.caseRoot;
    if (mode === 'file-path') f.configApi.CONFIG_FILE = path.join(f.caseRoot, 'proxy.config.json');
    await assert.rejects(runRuntimeBoundaryCase({ ...f, caseId: 'defaults-migration' }), safe);
    assert.equal(calls, 0);
  }
});

test('wrong defaults, pending ready, wrong state and shutdown failures never produce completed checks', async (t) => {
  for (const mode of ['defaults', 'ready', 'inspect', 'shutdown', 'throw']) {
    const f = fixture(t);
    if (mode === 'defaults')
      f.configApi.loadConfig = () => ({ appSettings: { contextRecoveryEnabled: true } });
    f.runtimeApi = {
      ...runtimeApi,
      createContextRecoveryRuntime(options) {
        const runtime = runtimeApi.createContextRecoveryRuntime(options);
        if (mode === 'ready') runtime.ready = async () => ({ ok: true, pending: true });
        if (mode === 'inspect') runtime.inspect = () => ({ state: 'disabled' });
        if (mode === 'shutdown')
          runtime.shutdownAsync = async () => ({ ok: false, code: 'PRIVATE_TOKEN' });
        if (mode === 'throw')
          runtime.configureSettings = () => {
            throw new Error('PRIVATE_TOKEN');
          };
        return runtime;
      },
    };
    await assert.rejects(runRuntimeBoundaryCase({ ...f, caseId: 'defaults-migration' }), safe);
  }
});

test('case tests are included by unified discovery', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-runtime-boundary-cases.test.js'
    )
  );
});

test('physical directory aliases are rejected before a case executes', async (t) => {
  const f = fixture(t);
  const alias = path.join(f.caseRoot, 'alias');
  fs.symlinkSync(f.caseRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    runRuntimeBoundaryCase({ ...f, caseRoot: alias, caseId: 'defaults-migration' }),
    safe
  );
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
});

test('defaults check rejects any file created by the supplied config loader', async (t) => {
  const f = fixture(t);
  f.configApi.loadConfig = () => {
    fs.writeFileSync(f.configApi.CONFIG_FILE, '{}');
    return {};
  };
  await assert.rejects(runRuntimeBoundaryCase({ ...f, caseId: 'defaults-migration' }), safe);
  assert.equal(fs.readFileSync(f.configApi.CONFIG_FILE, 'utf8'), '{}');
});
