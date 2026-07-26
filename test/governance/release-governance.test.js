'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertSafeReleasePath,
  findSensitiveReleaseEntries,
  isPathInside,
  validateReleaseDirectory,
} = require('../../lib/release/governance');
const {
  createRuntimePackage,
  createRuntimePackageLock,
  resolveReleaseLayout,
  selectRuntimeDependencies,
  validateGeneratedLayout,
} = require('../../lib/release/layout');
const { isInstallerFile, resolveCargoTargetDir } = require('../../scripts/collect-tauri-artifacts');
const {
  assertCleanCandidate,
  cleanGeneratedArtifacts,
  resolveCleanCandidates,
} = require('../../scripts/clean-generated-artifacts');

const repoRoot = path.resolve(__dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-release-governance-'));
const layoutTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-release-layout-'));
const dependencies = { alpha: '1.0.0', beta: '^2.0.0' };
const releaseRuntimeSource = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'prepare-release-runtime.js'),
  'utf8'
);
const portableBuildSource = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'build-portable.ps1'),
  'utf8'
);

function write(relative, content = '') {
  const target = path.join(tempRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

try {
  assert.strictEqual(
    isPathInside(path.join(repoRoot, 'dist'), path.join(repoRoot, 'dist', 'artifacts', 'portable')),
    true
  );
  assert.strictEqual(isPathInside(path.join(repoRoot, 'dist'), repoRoot), false);
  assert.throws(() => assertSafeReleasePath(repoRoot, repoRoot), /must stay inside/);
  assert.strictEqual(
    assertSafeReleasePath(repoRoot, path.join(repoRoot, 'dist', 'artifacts', 'portable')),
    path.join(repoRoot, 'dist', 'artifacts', 'portable')
  );
  const releaseLayout = resolveReleaseLayout(repoRoot);
  assert.strictEqual(releaseLayout.runtimeDir, path.join(repoRoot, 'dist', 'staging', 'runtime'));
  assert.strictEqual(
    releaseLayout.installersDir,
    path.join(repoRoot, 'dist', 'artifacts', 'installers')
  );
  fs.mkdirSync(path.join(layoutTempRoot, 'dist', 'staging', 'runtime'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(layoutTempRoot, 'dist', 'artifacts', 'installers'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(layoutTempRoot, 'dist', 'archive', 'legacy'), {
    recursive: true,
  });
  assert.deepStrictEqual(validateGeneratedLayout(layoutTempRoot), []);
  fs.mkdirSync(path.join(layoutTempRoot, 'dist', 'release-runtime'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(layoutTempRoot, 'dist', 'artifacts', 'installers-next'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(layoutTempRoot, 'dist', 'loose.zip'), '');
  const layoutErrors = validateGeneratedLayout(layoutTempRoot);
  assert.ok(layoutErrors.some((error) => error.includes('release-runtime')));
  assert.ok(layoutErrors.some((error) => error.includes('installers-next')));
  assert.ok(layoutErrors.some((error) => error.includes('loose.zip')));
  assert.strictEqual(isInstallerFile('HTTPS Proxy Manager_0.1.0_x64-setup.exe'), true);
  assert.strictEqual(isInstallerFile('debug.pdb'), false);
  assert.strictEqual(
    resolveCargoTargetDir(repoRoot, 'src-tauri/target-release'),
    path.join(repoRoot, 'src-tauri', 'target-release')
  );
  assert.deepStrictEqual(resolveCleanCandidates(tempRoot), [
    path.join(tempRoot, 'dist', 'staging'),
    path.join(tempRoot, 'dist', 'artifacts'),
    path.join(tempRoot, 'tauri-ui', 'dist'),
  ]);
  assert.deepStrictEqual(resolveCleanCandidates(tempRoot, { cargoOnly: true }), []);
  assert.deepStrictEqual(resolveCleanCandidates(tempRoot, { frontendOnly: true }), [
    path.join(tempRoot, 'tauri-ui', 'dist'),
    path.join(tempRoot, 'dist', 'tauri-ui'),
  ]);
  assert.deepStrictEqual(resolveCleanCandidates(tempRoot, { stagingOnly: true }), [
    path.join(tempRoot, 'dist', 'staging'),
  ]);
  assert.deepStrictEqual(resolveCleanCandidates(tempRoot, { artifactsOnly: true }), [
    path.join(tempRoot, 'dist', 'artifacts'),
  ]);
  assert.deepStrictEqual(resolveCleanCandidates(tempRoot, { coverageOnly: true }), [
    path.join(tempRoot, 'coverage'),
  ]);
  write('test/.mgmt-token-123');
  write('test/proxy.log.1');
  write('test/fixture.txt');
  fs.mkdirSync(path.join(tempRoot, 'test', '.certs'), { recursive: true });
  assert.deepStrictEqual(resolveCleanCandidates(tempRoot, { testOnly: true }), [
    path.join(tempRoot, 'test', '.certs'),
    path.join(tempRoot, 'test', '.mgmt-token-123'),
    path.join(tempRoot, 'test', 'proxy.log.1'),
  ]);
  assert.deepStrictEqual(cleanGeneratedArtifacts(tempRoot, { testOnly: true }), []);
  assert.strictEqual(fs.existsSync(path.join(tempRoot, 'test', 'fixture.txt')), true);
  assert.throws(
    () => resolveCleanCandidates(tempRoot, { cargoOnly: true, frontendOnly: true }),
    /cannot be combined/i
  );
  assert.throws(() => assertCleanCandidate(tempRoot, tempRoot), /outside workspace/);
  assert.throws(() => assertCleanCandidate(tempRoot, path.dirname(tempRoot)), /outside workspace/);
  assert.match(releaseRuntimeSource, /'--package-lock-only'/);
  assert.match(releaseRuntimeSource, /'--omit=dev'/);
  assert.match(releaseRuntimeSource, /'--ignore-scripts'/);
  assert.strictEqual(fs.existsSync(path.join(repoRoot, 'tray-icon.ico')), false);
  assert.strictEqual(fs.existsSync(path.join(repoRoot, 'lib', 'proxy', 'README.md')), false);
  assert.doesNotMatch(portableBuildSource, /tray-icon\.ico/);
  assert.match(portableBuildSource, /Join-Path \$Root 'lib\\proxy'/);
  assert.doesNotMatch(portableBuildSource, /Join-Path \$Root 'lib'\)/);

  const packageDocument = {
    name: 'example',
    version: '1.0.0',
    hpm: {
      releaseRuntimeDependencies: ['pino', 'node-forge', 'pino'],
    },
    dependencies: {
      'chart.js': '^4.0.0',
      'node-forge': '^1.0.0',
      pino: '^10.0.0',
    },
  };
  assert.deepStrictEqual(selectRuntimeDependencies(packageDocument), {
    'node-forge': '^1.0.0',
    pino: '^10.0.0',
  });
  assert.throws(() => selectRuntimeDependencies({ dependencies: {} }), /must be a non-empty array/);
  assert.throws(
    () =>
      selectRuntimeDependencies({
        hpm: { releaseRuntimeDependencies: ['missing'] },
        dependencies: {},
      }),
    /not declared: missing/
  );
  const runtimePackage = createRuntimePackage(packageDocument);
  const runtimeLock = createRuntimePackageLock(
    {
      name: 'example',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: packageDocument.dependencies,
          devDependencies: { eslint: '1.0.0' },
          hasInstallScript: true,
        },
        'node_modules/chart.js': { version: '4.0.0' },
        'node_modules/pino': { version: '10.0.0' },
      },
    },
    runtimePackage
  );
  assert.deepStrictEqual(runtimeLock.packages[''], {
    name: runtimePackage.name,
    version: runtimePackage.version,
    dependencies: runtimePackage.dependencies,
  });
  assert.strictEqual(runtimeLock.packages['node_modules/chart.js'].version, '4.0.0');

  write('openai-proxy.js');
  write('lib/proxy/config.js');
  write('proxy.bat');
  write('proxy.ps1');
  write('proxy.config.example.json', '{}');
  write('runtime/node/node.exe');
  write('https-proxy-manager.exe');
  write('node_modules/alpha/package.json', '{}');
  write('node_modules/beta/package.json', '{}');
  write('node_modules/alpha/.claude/settings.json', '{}');
  write('package.json', JSON.stringify({ private: true, dependencies }));

  let result = validateReleaseDirectory(tempRoot, dependencies);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);

  write('lib/test-runtime.js');
  result = validateReleaseDirectory(tempRoot, dependencies);
  assert.ok(
    result.errors.some((error) =>
      error.includes('Unexpected development library in release: lib/test-runtime.js')
    )
  );
  fs.rmSync(path.join(tempRoot, 'lib', 'test-runtime.js'));

  write('proxy.config.json', JSON.stringify({ profiles: [{ apiKey: 'secret' }] }));
  write('.hpm-runtime/.certs/proxy-key.pem', '-----BEGIN PRIVATE KEY-----\nsecret');
  const findings = findSensitiveReleaseEntries(tempRoot);
  assert.ok(findings.some((finding) => finding.path === 'proxy.config.json'));
  assert.ok(findings.some((finding) => finding.path.includes('.hpm-runtime')));
  assert.ok(findings.some((finding) => finding.path.endsWith('proxy-key.pem')));

  result = validateReleaseDirectory(tempRoot, dependencies);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('Unsafe release content')));

  fs.rmSync(path.join(tempRoot, '.hpm-runtime'), { recursive: true, force: true });
  fs.rmSync(path.join(tempRoot, 'proxy.config.json'), { force: true });
  write(
    'package.json',
    JSON.stringify({
      dependencies: { alpha: 'wrong', beta: '^2.0.0' },
      scripts: { postinstall: 'bad' },
    })
  );
  result = validateReleaseDirectory(tempRoot, dependencies);
  assert.ok(result.errors.some((error) => error.includes('dependency mismatch for alpha')));
  assert.ok(result.errors.some((error) => error.includes('must not contain lifecycle scripts')));

  console.log('[release-governance.test] ok');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(layoutTempRoot, { recursive: true, force: true });
}
