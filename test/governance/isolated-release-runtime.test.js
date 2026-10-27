'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  PACKAGED_GATEWAY_FILES,
  PACKAGED_GATEWAY_INPUTS,
} = require('../../scripts/lib/evidence-gateway-release-artifact');
const {
  captureIsolatedRuntimeSources,
  createIsolatedRuntimeWorkspace,
  prepareIsolatedRuntime,
  verifyIsolatedRuntime,
} = require('../../lib/release/isolated-runtime');

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const RUNTIME = [
  'openai-proxy.js',
  'proxy.bat',
  'proxy.ps1',
  'proxy.config.example.json',
  'lib/proxy/config.js',
  ...PACKAGED_GATEWAY_FILES,
  'lib/proxy/context-compaction-envelope.js',
  'lib/proxy/context-compaction-byte-budget.js',
  'lib/proxy/context-evidence-utf8.js',
  'lib/proxy/context-call-id-lineage.js',
  'lib/proxy/context-compaction-lease.js',
];
const SCRIPT = [
  "const fs = require('fs'), path = require('path'), crypto = require('crypto');",
  "const root = path.resolve(__dirname, '..'), dir = path.join(root, 'dist/staging/runtime');",
  "for (const key of ['OPENAI_API_KEY','PROXY_CONFIG_DIR','PROXY_RUNTIME_DIR','CODEX_HOME']) { if (process.env[key]) throw new Error('private inherited environment'); }",
  "const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');",
  'const files = ' + JSON.stringify(RUNTIME) + ';',
  'for (const file of files) { const target = path.join(dir, file); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.copyFileSync(path.join(root, file), target); }',
  "fs.mkdirSync(path.join(dir, 'runtime/node'), {recursive:true});",
  "fs.copyFileSync(process.execPath, path.join(dir, 'runtime/node/node.exe'));",
  "fs.mkdirSync(path.join(dir, 'runtime/native'), {recursive:true});fs.writeFileSync(path.join(dir,'runtime/native/hpm-context-recovery-key.exe'),'synthetic-native-helper');",
  "fs.mkdirSync(path.join(dir, 'node_modules/alpha'), {recursive:true});",
  "fs.writeFileSync(path.join(dir, 'node_modules/alpha/package.json'), JSON.stringify({version:'1.0.0'}));",
  "fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({private:true,dependencies:{alpha:'1.0.0'}}));",
  "fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(dir, 'package-lock.json'));",
  "const gateway = JSON.parse(fs.readFileSync(path.join(root, 'runtime/evidence-gateway/manifest.json'))); const bundle = 'runtime/evidence-gateway/gateway-' + gateway.bundleSha256 + '.cjs'; fs.mkdirSync(path.join(dir,'runtime/evidence-gateway'),{recursive:true});fs.copyFileSync(path.join(root,bundle),path.join(dir,bundle));",
  "fs.writeFileSync(path.join(dir,'runtime/evidence-gateway/release-manifest.json'),JSON.stringify({schemaVersion:1,nodeMajor:Number(process.versions.node.split('.')[0]),bundleSha256:gateway.bundleSha256,files:" +
    JSON.stringify(PACKAGED_GATEWAY_INPUTS) +
    '.map(file=>({file,sha256:sha(path.join(dir,file))}))}));',
  "fs.writeFileSync(path.join(dir, 'release-runtime-manifest.json'), JSON.stringify({schemaVersion:2,applicationVersion:'1.0.0',nodeVersion:process.version,nodeSha256:sha(process.execPath),contextRecoveryNativeSha256:sha(path.join(dir,'runtime/native/hpm-context-recovery-key.exe')),evidenceGatewayBundleSha256:gateway.bundleSha256,packageLockSha256:sha(path.join(dir,'package-lock.json')),sourceSha256:Object.fromEntries(files.map(file=>[file,sha(path.join(dir,file))])),dependencies:{alpha:'1.0.0'}}));",
].join('\n');

function fixture(t, script = SCRIPT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-release-source-test-'));
  const write = (file, contents) => {
    const target = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  for (const file of [
    ...RUNTIME,
    'lib/release/dependency-metadata.js',
    'lib/release/governance.js',
    'lib/release/layout.js',
    'scripts/prepare-context-recovery-native.js',
    'scripts/prepare-evidence-gateway.js',
    'lib/release/evidence-gateway.js',
    'scripts/lib/evidence-gateway-runtime.js',
    'native/context-recovery-key/Cargo.toml',
    'native/context-recovery-key/Cargo.lock',
    'native/context-recovery-key/src/main.rs',
    'native/context-recovery-key/src/lib.rs',
    'native/context-recovery-key/src/anchor.rs',
    'native/context-recovery-key/src/anchor/diagnostic.rs',
    'native/context-recovery-key/src/anchor/lifetime.rs',
    'native/context-recovery-key/src/anchor/stream.rs',
    'native/context-recovery-key/src/private_path.rs',
    'native/context-recovery-key/src/profile_secret.rs',
  ])
    write(file, 'synthetic');
  write('scripts/prepare-release-runtime.js', script);
  write(
    'scripts/release-proxy-sources.json',
    JSON.stringify(RUNTIME.filter((file) => file.startsWith('lib/proxy/')))
  );
  write(
    'package.json',
    JSON.stringify({
      name: 'synthetic',
      version: '1.0.0',
      dependencies: { alpha: '1.0.0' },
      hpm: { releaseRuntimeDependencies: ['alpha'] },
    })
  );
  write(
    'package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/alpha': { version: '1.0.0', integrity: 'synthetic' } },
    })
  );
  write('proxy.config.json', 'private synthetic sentinel');
  const bundle = 'module.exports = {};';
  const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  write(`runtime/evidence-gateway/gateway-${bundleSha256}.cjs`, bundle);
  write(
    'runtime/evidence-gateway/manifest.json',
    JSON.stringify({
      schemaVersion: 1,
      nodeMajor: Number(process.versions.node.split('.')[0]),
      bundleSha256,
      inputs: ['package.json', 'package-lock.json', 'scripts/lib/evidence-gateway-runtime.js'].map(
        (file) => ({ file, sha256: hash(path.join(root, file)) })
      ),
    })
  );
  write('dist/staging/runtime/sentinel.txt', 'unchanged');
  write('.hpm-runtime/.certs/key.pem', 'private synthetic sentinel');
  let directory;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (directory) {
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.match(path.basename(directory), /^hpm-isolated-release-/);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    root,
    write,
    workspace() {
      const snapshot = captureIsolatedRuntimeSources(root);
      directory = createIsolatedRuntimeWorkspace(snapshot);
      return { snapshot, directory };
    },
  };
}

test('isolated release snapshot copies only declared files and preserves live staging/config sentinels', (t) => {
  const f = fixture(t);
  const { snapshot, directory } = f.workspace();
  assert.equal(snapshot.runtimeFiles.length, RUNTIME.length);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.files), true);
  assert.equal(fs.existsSync(path.join(directory, 'proxy.config.json')), false);
  assert.equal(fs.existsSync(path.join(directory, '.hpm-runtime')), false);
  assert.equal(fs.existsSync(path.join(directory, 'dist')), false);
  for (const row of snapshot.files) assert.equal(hash(path.join(directory, row.file)), row.sha256);
  assert.equal(
    fs.readFileSync(path.join(f.root, 'dist/staging/runtime/sentinel.txt'), 'utf8'),
    'unchanged'
  );
  assert.throws(() => createIsolatedRuntimeWorkspace(snapshot), {
    code: 'release_isolated_workspace_already_created',
  });
});

test('native ACL source is copied exactly and remains bound to the isolated build snapshot', async (t) => {
  const f = fixture(t);
  const file = 'native/context-recovery-key/src/private_path.rs';
  const { snapshot, directory } = f.workspace();
  const row = snapshot.files.find((entry) => entry.file === file);
  assert.ok(row, 'native ACL implementation must be a declared build input');
  assert.equal(hash(path.join(directory, file)), row.sha256);
  f.write(file, 'changed native ACL implementation');
  await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_source_changed',
  });
  assert.equal(fs.existsSync(path.join(directory, 'isolated-user')), false);
});

test('native profile encryption source remains pinned through isolated preparation', async (t) => {
  const f = fixture(t);
  const file = 'native/context-recovery-key/src/profile_secret.rs';
  const { snapshot, directory } = f.workspace();
  const row = snapshot.files.find((entry) => entry.file === file);
  assert.ok(row);
  assert.equal(hash(path.join(directory, file)), row.sha256);
  f.write(file, 'changed native profile encryption');
  await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_source_changed',
  });
  assert.equal(fs.existsSync(path.join(directory, 'isolated-user')), false);
});

test('isolated native build retains anchor modules and refuses changed build inputs', async (t) => {
  for (const file of [
    'native/context-recovery-key/src/anchor.rs',
    'native/context-recovery-key/src/anchor/diagnostic.rs',
    'native/context-recovery-key/src/anchor/lifetime.rs',
    'native/context-recovery-key/src/anchor/stream.rs',
  ]) {
    const f = fixture(t);
    const original = fs.readFileSync(path.resolve(__dirname, '../..', file));
    f.write(file, original);
    const { snapshot, directory } = f.workspace();
    assert.ok(fs.existsSync(path.join(directory, file)), 'Cargo module missing: ' + file);
    assert.deepEqual(fs.readFileSync(path.join(directory, file)), original);
    f.write(file, 'changed native anchor implementation');
    await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
      code: 'release_isolated_source_changed',
    });
    assert.equal(fs.existsSync(path.join(directory, 'isolated-user')), false);
  }
});

test('empty, invalid, extreme and traversing manifests refuse before workspace creation', (t) => {
  const f = fixture(t);
  for (const input of [
    null,
    [],
    {},
    '',
    ['lib/proxy/config.js', 'lib/proxy/config.js'],
    ['../config.js'],
    ['lib/proxy/../config.js'],
    ['lib\\proxy\\config.js'],
    ['C:/secrets.js'],
    ['lib/proxy/config.json'],
    [null],
    Array.from({ length: 4097 }, () => 'lib/proxy/config.js'),
  ]) {
    f.write('scripts/release-proxy-sources.json', JSON.stringify(input));
    assert.throws(() => captureIsolatedRuntimeSources(f.root), {
      code: 'release_isolated_manifest_invalid',
    });
  }
  f.write('scripts/release-proxy-sources.json', ' '.repeat(256 * 1024 + 1));
  assert.throws(() => captureIsolatedRuntimeSources(f.root), {
    code: 'release_isolated_manifest_invalid',
  });
  for (const root of [null, {}, [], '', 'relative', 'bad\0root'])
    assert.throws(() => captureIsolatedRuntimeSources(root), {
      code: 'release_isolated_root_invalid',
    });
});

test('opaque snapshots and minted destinations reject hostile objects without user hooks or writes', async (t) => {
  const f = fixture(t);
  let hooks = 0;
  const hostile = Object.defineProperty({}, 'files', {
    get() {
      hooks++;
      throw new Error('private');
    },
  });
  for (const value of [null, {}, [], hostile]) {
    assert.throws(() => createIsolatedRuntimeWorkspace(value), {
      code: 'release_isolated_snapshot_invalid',
    });
    assert.throws(() => verifyIsolatedRuntime(value, f.root), {
      code: 'release_isolated_snapshot_invalid',
    });
    await assert.rejects(prepareIsolatedRuntime(value, f.root), {
      code: 'release_isolated_snapshot_invalid',
    });
  }
  const { snapshot, directory } = f.workspace();
  for (const value of [f.root, path.dirname(directory), '', null, {}, directory + '-other'])
    await assert.rejects(prepareIsolatedRuntime(snapshot, value), {
      code: 'release_isolated_workspace_invalid',
    });
  assert.equal(hooks, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'isolated-user')), false);
});

test('symbolic-link parents and nonregular declared sources are rejected', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'linked-target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'file.js'), 'synthetic');
  fs.symlinkSync(
    target,
    path.join(f.root, 'lib/proxy/linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  f.write('scripts/release-proxy-sources.json', JSON.stringify(['lib/proxy/linked/file.js']));
  assert.throws(() => captureIsolatedRuntimeSources(f.root), {
    code: 'release_isolated_source_not_regular',
  });
  f.write('scripts/release-proxy-sources.json', JSON.stringify(['lib/proxy/config.js']));
  fs.unlinkSync(path.join(f.root, 'lib/proxy/config.js'));
  fs.mkdirSync(path.join(f.root, 'lib/proxy/config.js'));
  assert.throws(() => captureIsolatedRuntimeSources(f.root), {
    code: 'release_isolated_source_not_regular',
  });
});

test('source changes refuse before starting a preparation child', async (t) => {
  const f = fixture(t);
  const { snapshot, directory } = f.workspace();
  f.write('openai-proxy.js', 'changed synthetic');
  await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_source_changed',
  });
  assert.equal(fs.existsSync(path.join(directory, 'isolated-user')), false);
  assert.equal(fs.existsSync(path.join(directory, 'dist')), false);
});

test('preexisting output junctions cannot redirect release cleanup into prior staging', async (t) => {
  const f = fixture(t);
  const { snapshot, directory } = f.workspace();
  fs.symlinkSync(
    path.join(f.root, 'dist'),
    path.join(directory, 'dist'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_output_already_exists',
  });
  assert.equal(
    fs.readFileSync(path.join(f.root, 'dist/staging/runtime/sentinel.txt'), 'utf8'),
    'unchanged'
  );
  assert.equal(fs.existsSync(path.join(directory, 'isolated-user')), false);
});

test('preexisting isolated-user directories refuse before config/environment writes', async (t) => {
  const f = fixture(t);
  const { snapshot, directory } = f.workspace();
  fs.mkdirSync(path.join(directory, 'isolated-user'));
  fs.writeFileSync(path.join(directory, 'isolated-user/sentinel.txt'), 'unchanged');
  await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_output_already_exists',
  });
  assert.equal(
    fs.readFileSync(path.join(directory, 'isolated-user/sentinel.txt'), 'utf8'),
    'unchanged'
  );
  assert.equal(fs.existsSync(path.join(directory, 'dist')), false);
});

test('mock preparation uses clean child environment and exact source/lock/node identities, never installer acceptance', async (t) => {
  const f = fixture(t);
  const { snapshot, directory } = f.workspace();
  const result = await prepareIsolatedRuntime(snapshot, directory);
  assert.equal(result.runtimeSourcesMatched, RUNTIME.length);
  assert.equal(result.lockedPackages, 1);
  assert.equal(result.installedApplicationAcceptanceVerified, false);
  assert.equal(result.nativeHostAdoptionVerified, false);
  assert.equal(result.stagedDependenciesMatchOriginalLock, true);
  assert.equal(
    fs.readFileSync(path.join(f.root, 'dist/staging/runtime/sentinel.txt'), 'utf8'),
    'unchanged'
  );
  await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_preparation_already_started',
  });
  const runtime = result.runtimeDir;
  const manifestFile = path.join(runtime, 'release-runtime-manifest.json');
  const originalManifest = fs.readFileSync(manifestFile, 'utf8');
  for (const evidenceGatewayBundleSha256 of [null, '', '0'.repeat(64)]) {
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...JSON.parse(originalManifest), evidenceGatewayBundleSha256 })
    );
    assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
      code: 'release_isolated_gateway_identity_invalid',
    });
  }
  fs.writeFileSync(manifestFile, originalManifest);
  const bundleFile = path.join(runtime, snapshot.gatewayBundle);
  const originalBundle = fs.readFileSync(bundleFile);
  fs.writeFileSync(bundleFile, 'corrupt synthetic bundle');
  assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_gateway_identity_invalid',
  });
  fs.writeFileSync(bundleFile, originalBundle);
  const manifest = JSON.parse(originalManifest);
  manifest.sourceSha256['unexpected.js'] = 'a'.repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_runtime_manifest_invalid',
  });
  fs.writeFileSync(manifestFile, originalManifest);
  for (const patch of [
    { nodeSha256: '0'.repeat(64) },
    { packageLockSha256: '0'.repeat(64) },
    ...(process.platform === 'win32'
      ? [{ contextRecoveryNativeSha256: '0'.repeat(64) }, { contextRecoveryNativeSha256: null }]
      : []),
  ]) {
    fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), ...patch }));
    assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
      code: 'release_isolated_runtime_identity_invalid',
    });
  }
  for (const patch of [
    { applicationVersion: '2.0.0' },
    { nodeVersion: 'unexpected' },
    { dependencies: { alpha: '2.0.0' } },
  ]) {
    fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), ...patch }));
    assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
      code: 'release_isolated_runtime_manifest_invalid',
    });
  }
  fs.writeFileSync(manifestFile, originalManifest);
  fs.writeFileSync(path.join(runtime, 'openai-proxy.js'), 'tampered');
  assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_runtime_source_changed',
  });
  fs.copyFileSync(path.join(f.root, 'openai-proxy.js'), path.join(runtime, 'openai-proxy.js'));
  fs.writeFileSync(path.join(runtime, 'proxy.config.json'), 'private synthetic sentinel');
  assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_runtime_governance_failed',
  });
  fs.unlinkSync(path.join(runtime, 'proxy.config.json'));
  const lockFile = path.join(runtime, 'package-lock.json');
  const originalLock = fs.readFileSync(lockFile, 'utf8');
  const gatewayFile = path.join(runtime, 'runtime/evidence-gateway/release-manifest.json');
  const originalGateway = fs.readFileSync(gatewayFile, 'utf8');
  for (const patch of [
    {},
    { packages: {} },
    { packages: { '': {} } },
    { packages: { 'node_modules/alpha': { version: '2.0.0', integrity: 'synthetic' } } },
    { packages: { 'node_modules/alpha': { version: '1.0.0', integrity: 'changed' } } },
    { packages: { 'node_modules/unknown': { version: '1.0.0', integrity: 'synthetic' } } },
  ]) {
    fs.writeFileSync(lockFile, JSON.stringify(patch));
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        ...JSON.parse(originalManifest),
        packageLockSha256: hash(lockFile),
      })
    );
    const gatewayManifest = JSON.parse(originalGateway);
    gatewayManifest.files.find((row) => row.file === 'package-lock.json').sha256 = hash(lockFile);
    fs.writeFileSync(gatewayFile, JSON.stringify(gatewayManifest));
    assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
      code: 'release_isolated_dependency_identity_changed',
    });
  }
  fs.writeFileSync(lockFile, originalLock);
  fs.writeFileSync(gatewayFile, originalGateway);
  fs.writeFileSync(manifestFile, originalManifest);
  fs.writeFileSync(path.join(directory, 'scripts/prepare-release-runtime.js'), '// altered');
  assert.throws(() => verifyIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_source_changed',
  });
});

test('failed child has a fixed safe code, retained workspace and no implicit retry', async (t) => {
  const f = fixture(t, 'throw new Error("private credential exception");');
  const { snapshot, directory } = f.workspace();
  await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_preparation_failed',
  });
  assert.equal(fs.existsSync(directory), true);
  await assert.rejects(prepareIsolatedRuntime(snapshot, directory), {
    code: 'release_isolated_preparation_already_started',
  });
});

test('isolated CLI rejects implicit, arbitrary-output and additional arguments before staging', () => {
  for (const args of [[], ['--output-dir', 'C:/'], ['--prepare', 'extra'], ['--retry']]) {
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../../scripts/probe-isolated-release-runtime.js'), ...args],
      { encoding: 'utf8', timeout: 20000 }
    );
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      passed: false,
      failureCode: 'release_isolated_probe_refused',
    });
  }
});
