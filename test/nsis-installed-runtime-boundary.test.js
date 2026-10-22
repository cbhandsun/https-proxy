'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Script } = require('node:vm');
const { discoverTestFiles } = require('../lib/test-discovery');
const driver = path.resolve(__dirname, '../scripts/lib/nsis-installed-runtime-boundary.cjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
let root,
  install,
  node,
  manifest,
  sequence = 0;

function seal() {
  fs.writeFileSync(path.join(install, 'release-runtime-manifest.json'), JSON.stringify(manifest));
  return hash(fs.readFileSync(path.join(install, 'release-runtime-manifest.json')));
}
function source(name, content) {
  // Generated fixtures must parse before a child process tests their behavior.
  new Script(content, { filename: name });
  const file = path.join(install, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  manifest.sourceSha256[name] = hash(content);
}
function run(caseId, options = {}) {
  const caseRoot = path.join(root, 'case-' + sequence++);
  fs.mkdirSync(caseRoot);
  fs.mkdirSync(path.join(caseRoot, 'config'));
  fs.mkdirSync(path.join(caseRoot, 'data'));
  if (options.nonempty) fs.writeFileSync(path.join(caseRoot, 'config', 'existing'), 'retained');
  const sha = seal();
  const result = spawnSync(
    options.node || node,
    [driver, caseId, install, caseRoot, options.hash || sha],
    {
      encoding: 'utf8',
      input: options.input,
      // Matches the controller's execution budget. This tests identity/isolation,
      // not first-launch performance of a newly copied executable on Windows.
      timeout: 120000,
      maxBuffer: 16384,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        PROXY_CONFIG_DIR: 'PRIVATE_DAILY_CONFIG_SENTINEL',
        PROXY_RUNTIME_DIR: 'PRIVATE_DAILY_RUNTIME_SENTINEL',
        HPM_NSIS_BOUNDARY_OWNED_ROOT: options.ownedRoot || root,
        ...(options.gate ? { HPM_NSIS_BOUNDARY_START_GATE: '1' } : {}),
      },
    }
  );
  assert.equal(result.error, undefined);
  return { ...result, caseRoot, sha };
}
function failed(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'nsis_installed_runtime_boundary_failed\n');
}

test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-installed-boundary-'));
  install = path.join(root, 'installed');
  fs.mkdirSync(path.join(install, 'runtime/node'), { recursive: true });
  fs.mkdirSync(path.join(install, 'runtime/native'), { recursive: true });
  node = path.join(install, 'runtime/node/node.exe');
  fs.copyFileSync(process.execPath, node);
  fs.writeFileSync(
    path.join(install, 'runtime/native/hpm-context-recovery-key.exe'),
    'never-executed-native-placeholder'
  );
  fs.writeFileSync(path.join(install, 'package-lock.json'), '{}');
  manifest = {
    schemaVersion: 2,
    sourceSha256: {},
    nodeSha256: hash(fs.readFileSync(node)),
    contextRecoveryNativeSha256: hash('never-executed-native-placeholder'),
    packageLockSha256: hash('{}'),
  };
  source(
    'lib/proxy/config.js',
    `const path=require('node:path'); module.exports={CONFIG_DIR:process.env.PROXY_CONFIG_DIR,DATA_DIR:process.env.PROXY_RUNTIME_DIR,CONFIG_FILE:path.join(process.env.PROXY_CONFIG_DIR,'proxy.config.json'),loadConfig(){return {}}};`
  );
  source(
    'lib/proxy/context-recovery-runtime.js',
    `module.exports={recoveryStorageSettings(){return {enabled:false,persistent:false}},createContextRecoveryRuntime(){let closed=false;return {configureSettings(){},ready:async()=>({ok:true}),inspect(){return {requestedEnabled:false,requestedPersistence:false,appliedEnabled:false,appliedPersistence:false,storage:'memory',state:closed?'closed':'disabled',restartRetention:false}},shutdownAsync:async()=>{closed=true;return {ok:true}}}}};`
  );
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('synthetic installed default modules run in separate bundled Node and retain incomplete scope', () => {
  const originalConfig = process.env.PROXY_CONFIG_DIR;
  const originalRuntime = process.env.PROXY_RUNTIME_DIR;
  const result = run('defaults-migration');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    caseId: 'defaults-migration',
    manifestSha256: result.sha,
    scope: 'installed_module_api',
    complete: false,
    dependencyIdentity: 'lock_only',
    checks: [
      'empty_config_directory',
      'default_policy_disabled',
      'runtime_disabled',
      'shutdown_acknowledged',
    ],
  });
  assert.equal(process.env.PROXY_CONFIG_DIR, originalConfig);
  assert.equal(process.env.PROXY_RUNTIME_DIR, originalRuntime);
  assert.deepEqual(fs.readdirSync(path.join(result.caseRoot, 'data')), []);
});

test('unsupported matrix, wrong manifest, foreign ownership and wrong executable fail safely', () => {
  failed(run('settings-matrix'));
  failed(run('defaults-migration', { hash: '0'.repeat(64) }));
  failed(run('defaults-migration', { ownedRoot: install }));
  failed(run('defaults-migration', { node: process.execPath }));
});

test('undeclared installed source and workspace resolution cannot be used as fallbacks', () => {
  const relative = 'lib/proxy/config.js';
  const original = fs.readFileSync(path.join(install, relative), 'utf8');
  const extra = path.join(install, 'lib/proxy/undeclared.js');
  fs.writeFileSync(extra, 'module.exports={};');
  try {
    source(relative, "require('./undeclared'); module.exports={};");
    failed(run('defaults-migration'));
    source(
      relative,
      'require(' +
        JSON.stringify(path.resolve(__dirname, '../lib/proxy/config.js')) +
        '); module.exports={};'
    );
    failed(run('defaults-migration'));
  } finally {
    source(relative, original);
    fs.unlinkSync(extra);
  }
});

test('source mutation after manifest sealing is rejected without raw module errors', () => {
  const relative = 'lib/proxy/config.js';
  const file = path.join(install, relative);
  const original = fs.readFileSync(file, 'utf8');
  try {
    fs.writeFileSync(file, "throw new Error('PRIVATE_NATIVE_TOKEN');");
    failed(run('defaults-migration'));
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('synthetic installed failure API observes the exclusive file blocker and returns scoped checks', () => {
  const relative = 'lib/proxy/context-recovery-runtime.js';
  const original = fs.readFileSync(path.join(install, relative), 'utf8');
  try {
    source(
      relative,
      `const fs=require('node:fs'),path=require('node:path'); module.exports={recoveryStorageSettings(){return {enabled:false,persistent:false}},createContextRecoveryRuntime(options){const blocked=fs.lstatSync(path.join(options.dataDirectory,'context-recovery-v1')).isFile();return {configureSettings(){},ready:async()=>({ok:false,code:blocked?'context_recovery_storage_unavailable':'wrong_failure'}),inspect(){return {requestedEnabled:true,requestedPersistence:true,appliedEnabled:false,appliedPersistence:true,storage:'persistent',state:'failed',restartRetention:false}},shutdownAsync:async()=>({ok:false,code:'context_recovery_storage_unavailable'})}}};`
    );
    const result = run('initialization-failure');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      caseId: 'initialization-failure',
      manifestSha256: result.sha,
      scope: 'installed_module_api',
      complete: true,
      dependencyIdentity: 'lock_only',
      checks: [
        'storage_directory_blocked',
        'initialization_failed_closed',
        'reenable_rejected',
        'shutdown_failure_acknowledged',
      ],
    });
    const blocker = path.join(result.caseRoot, 'data/context-recovery-v1');
    assert.equal(fs.lstatSync(blocker).isFile(), true);
    assert.equal(fs.statSync(blocker).size, 0);
  } finally {
    source(relative, original);
  }
});

test('importing entry does not permit in-process environment/cache isolation', async () => {
  const original = process.env.PROXY_CONFIG_DIR;
  const { run: importedRun } = require('../scripts/lib/nsis-installed-runtime-boundary.cjs');
  await assert.rejects(importedRun([], root), (error) => {
    assert.equal(error.message, 'nsis_installed_runtime_boundary_failed');
    return true;
  });
  assert.equal(process.env.PROXY_CONFIG_DIR, original);
});

test('entry point is discovered by unified tests', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-installed-runtime-boundary.test.js'
    )
  );
});

test('fixed installed reopen driver uses only declared synthetic APIs and reports orderly scope', () => {
  const runtime = 'lib/proxy/context-recovery-runtime.js';
  const storage = 'lib/proxy/context-recovery-storage.js';
  const originalRuntime = fs.readFileSync(path.join(install, runtime), 'utf8');
  const originalConfig = fs.readFileSync(path.join(install, 'lib/proxy/config.js'), 'utf8');
  try {
    // Synthetic installed exports exercise the real fixed driver and loader.
    // They do not establish DPAPI, installation delivery or crash qualification.
    source(
      storage,
      `const states=new Map(); module.exports={states,async openContextRecoveryStorage({directory}){const state=states.get(require('node:path').dirname(directory));return {async execute(request){return request.operation==='inspect'?{records:state.records,bytes:0}:null},async close(){}}}};`
    );
    source(
      runtime,
      `const {states}=require('./context-recovery-storage'); const original=${JSON.stringify('synthetic-runtime-reopen\r\nélève🙂')}; module.exports={createContextRecoveryRuntime({dataDirectory}){const state=states.get(dataDirectory)||{records:0,owners:0};states.set(dataDirectory,state);const reopened=state.owners++>0;let begins=0;const view={ok:true,async replyAsync(name){if(!state.records)return {ok:false};return {ok:true,text:JSON.stringify(name.includes('list')?{sources:[{sourceId:'synthetic',digest:'a'.repeat(64)}]}:{page:{text:original}})}}};return {configureSettings(){},ready:async()=>({ok:true}),inspect:()=>({storage:'persistent',appliedEnabled:true,appliedPersistence:true,restartRetention:false}),sessions:{async beginAsync(){if(reopened)return {ok:false};if(++begins>2)return view;return {ok:true,snapshotId:'synthetic',async completeObservedAsync(){state.records=1;return {ok:true}}}},async revokeAsync(){state.records=0;return {ok:true}}},async clearAsync(){state.records=0;return {ok:true}},async shutdownAsync(){return {ok:true}}}}};`
    );
    const result = run('reopen-clear');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      caseId: 'reopen-clear',
      manifestSha256: result.sha,
      scope: 'installed_module_api',
      complete: true,
      dependencyIdentity: 'lock_only',
      checks: [
        'persistent_runtime_read',
        'principal_revoke_acknowledged',
        'principal_reopen_denied',
        'clear_acknowledged',
        'clear_reopen_denied',
        'all_owners_closed',
      ],
    });
    const syntheticRuntime = fs.readFileSync(path.join(install, runtime), 'utf8');
    const syntheticStorage = fs.readFileSync(path.join(install, storage), 'utf8');
    // Declared runtime/storage are mandatory before any product module runs.
    const storageHash = manifest.sourceSha256[storage];
    delete manifest.sourceSha256[storage];
    source('lib/proxy/config.js', `throw new Error('PRIVATE_PRODUCT_MUST_NOT_LOAD');`);
    failed(run('reopen-clear'));
    manifest.sourceSha256[storage] = storageHash;
    source('lib/proxy/config.js', originalConfig);
    // Accessors and proxies must be rejected without exposing native errors.
    for (const content of [
      `module.exports={get openContextRecoveryStorage(){throw new Error('PRIVATE_GETTER')}};`,
      `module.exports=new Proxy({}, {get(){throw new Error('PRIVATE_PROXY')}});`,
      `module.exports={openContextRecoveryStorage:null};`,
      `require(${JSON.stringify(path.resolve(__dirname, '../lib/proxy/context-recovery-storage.js'))});module.exports={};`,
    ]) {
      source(storage, content);
      failed(run('reopen-clear'));
    }
    source(storage, syntheticStorage);
    for (const content of [
      `module.exports={get createContextRecoveryRuntime(){throw new Error('PRIVATE_RUNTIME_GETTER')}};`,
      `module.exports=new Proxy({}, {get(){throw new Error('PRIVATE_RUNTIME_PROXY')}});`,
      `module.exports={createContextRecoveryRuntime:null};`,
      syntheticRuntime.replace(
        'async shutdownAsync(){return {ok:true}}',
        'async shutdownAsync(){return {ok:false}}'
      ),
      syntheticRuntime.replace(
        'async shutdownAsync(){return {ok:true}}',
        "async shutdownAsync(){require('node:fs').appendFileSync(__filename,'\\n// changed');return {ok:true}}"
      ),
    ]) {
      source(runtime, content);
      failed(run('reopen-clear'));
    }
  } finally {
    source(runtime, originalRuntime);
    source('lib/proxy/config.js', originalConfig);
    delete manifest.sourceSha256[storage];
    fs.rmSync(path.join(install, storage), { force: true });
  }
});

test('explicit parent gate preserves direct calls and requires exact signal before product loading', () => {
  const positive = run('defaults-migration', { gate: true, input: '1' });
  assert.equal(positive.status, 0, positive.stderr);
  assert.equal(JSON.parse(positive.stdout).complete, false);
  const relative = 'lib/proxy/config.js';
  const original = fs.readFileSync(path.join(install, relative), 'utf8');
  try {
    source(
      relative,
      `require('node:fs').writeFileSync(require('node:path').join(process.env.PROXY_CONFIG_DIR,'gate-executed'),'unsafe');module.exports={};`
    );
    for (const input of ['', '2', '11']) {
      const result = run('defaults-migration', { gate: true, input });
      failed(result);
      assert.deepEqual(fs.readdirSync(path.join(result.caseRoot, 'config')), []);
    }
  } finally {
    source(relative, original);
  }
});

test('PowerShell exported wrapper supervises bundled Node and accepts only scoped synthetic default result', () => {
  const sha = seal();
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Import-Module $env:HPM_TEST_RUNTIME_MODULE -Force; Invoke-HpmInstalledRuntimeBoundary $env:HPM_TEST_OWNED_ROOT $env:HPM_TEST_INSTALL $env:HPM_TEST_MANIFEST 'defaults-migration' | ConvertTo-Json -Compress",
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16384,
      env: {
        ...process.env,
        NODE_OPTIONS: '--require PRIVATE_CHILD_SENTINEL',
        NODE_PATH: 'PRIVATE_CHILD_SENTINEL',
        HPM_TEST_RUNTIME_MODULE: path.resolve(
          __dirname,
          '../scripts/lib/nsis-runtime-boundary.psm1'
        ),
        HPM_TEST_OWNED_ROOT: root,
        HPM_TEST_INSTALL: install,
        HPM_TEST_MANIFEST: sha,
      },
    }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.scope, 'installed_module_api');
  assert.equal(value.caseId, 'defaults-migration');
  assert.equal(value.complete, false);
  assert.equal(value.manifestSha256, sha);
  assert.equal(value.dependencyIdentity, 'lock_only');
  assert.deepEqual(value.checks, [
    'empty_config_directory',
    'default_policy_disabled',
    'runtime_disabled',
    'shutdown_acknowledged',
  ]);
});

test('nonempty configuration is rejected before installed module initialization can write', () => {
  const relative = 'lib/proxy/config.js';
  const original = fs.readFileSync(path.join(install, relative), 'utf8');
  try {
    source(
      relative,
      `require('node:fs').writeFileSync(require('node:path').join(process.env.PROXY_CONFIG_DIR,'executed'),'unsafe');module.exports={};`
    );
    const result = run('defaults-migration', { nonempty: true });
    failed(result);
    assert.deepEqual(fs.readdirSync(path.join(result.caseRoot, 'config')), ['existing']);
    assert.equal(
      fs.readFileSync(path.join(result.caseRoot, 'config/existing'), 'utf8'),
      'retained'
    );
  } finally {
    source(relative, original);
  }
});
