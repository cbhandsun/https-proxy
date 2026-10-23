'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { selectRuntimeDependencies } = require('./layout');
const { validateReleaseDirectory } = require('./governance');
const {
  readEvidenceGatewayArtifact,
  ARTIFACT_DIRECTORY,
} = require('../../scripts/lib/evidence-gateway-artifact');
const {
  PACKAGED_GATEWAY_FILES,
  readPackagedEvidenceGateway,
} = require('../../scripts/lib/evidence-gateway-release-artifact');

const RUNTIME_FILES = [
  'openai-proxy.js',
  'proxy.bat',
  'proxy.ps1',
  'proxy.config.example.json',
  ...PACKAGED_GATEWAY_FILES,
];
const BUILD_FILES = [
  'scripts/prepare-release-runtime.js',
  'scripts/prepare-context-recovery-native.js',
  'scripts/prepare-evidence-gateway.js',
  'lib/release/evidence-gateway.js',
  'native/context-recovery-key/Cargo.toml',
  'native/context-recovery-key/Cargo.lock',
  'native/context-recovery-key/src/main.rs',
  'native/context-recovery-key/src/lib.rs',
  'native/context-recovery-key/src/private_path.rs',
  'native/context-recovery-key/src/profile_secret.rs',
  'scripts/release-proxy-sources.json',
  'lib/release/dependency-metadata.js',
  'lib/release/governance.js',
  'lib/release/layout.js',
  'package.json',
  'package-lock.json',
];
const fail = (code) => Object.assign(new Error('Isolated release runtime gate failed'), { code });
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SNAPSHOTS = new WeakSet();
const WORKSPACES = new WeakMap();

function requireSnapshot(snapshot) {
  if (!SNAPSHOTS.has(snapshot)) throw fail('release_isolated_snapshot_invalid');
}

function requireWorkspace(snapshot, directory) {
  requireSnapshot(snapshot);
  if (
    typeof directory !== 'string' ||
    WORKSPACES.get(snapshot)?.directory !== directory ||
    path.dirname(directory) !== os.tmpdir() ||
    !/^hpm-isolated-release-[a-zA-Z0-9]+$/.test(path.basename(directory))
  )
    throw fail('release_isolated_workspace_invalid');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw fail('release_isolated_workspace_invalid');
}

function verifySourceCopies(snapshot, directory) {
  requireWorkspace(snapshot, directory);
  for (const row of snapshot.files) {
    if (
      hash(regularSource(snapshot.root, row.file)) !== row.sha256 ||
      hash(regularSource(directory, row.file)) !== row.sha256
    )
      throw fail('release_isolated_source_changed');
  }
}

function requireAbsent(directory, name) {
  try {
    fs.lstatSync(path.join(directory, name));
  } catch (problem) {
    if (problem.code === 'ENOENT') return;
    throw fail('release_isolated_output_unavailable');
  }
  throw fail('release_isolated_output_already_exists');
}

function regularSource(root, relative) {
  let candidate = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    candidate = path.join(candidate, parts[index]);
    const stat = fs.lstatSync(candidate);
    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
    )
      throw fail('release_isolated_source_not_regular');
  }
  return candidate;
}

function captureIsolatedRuntimeSources(repoRoot) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || repoRoot.includes('\0'))
    throw fail('release_isolated_root_invalid');
  const root = path.resolve(repoRoot);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('release_isolated_root_invalid');
  const manifestPath = regularSource(root, 'scripts/release-proxy-sources.json');
  if (fs.statSync(manifestPath).size > 256 * 1024) throw fail('release_isolated_manifest_invalid');
  const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    !Array.isArray(declared) ||
    declared.length === 0 ||
    declared.length > 4096 ||
    declared.some(
      (file) =>
        typeof file !== 'string' ||
        !/^lib\/proxy\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.js$/.test(file) ||
        file.split('/').some((part) => part === '..' || part === '.')
    ) ||
    new Set(declared).size !== declared.length
  )
    throw fail('release_isolated_manifest_invalid');
  let gateway;
  try {
    gateway = readEvidenceGatewayArtifact(root);
  } catch {
    throw fail('release_isolated_gateway_artifact_invalid');
  }
  const gatewayBundle = `${ARTIFACT_DIRECTORY}/gateway-${gateway.manifest.bundleSha256}.cjs`;
  const files = [
    ...new Set([
      ...BUILD_FILES,
      ...RUNTIME_FILES,
      ...declared,
      ...gateway.manifest.inputs.map((row) => row.file),
      `${ARTIFACT_DIRECTORY}/manifest.json`,
      gatewayBundle,
    ]),
  ].sort();
  const rows = files.map((file) =>
    Object.freeze({ file, sha256: hash(regularSource(root, file)) })
  );
  const snapshot = Object.freeze({
    root,
    files: Object.freeze(rows),
    runtimeFiles: Object.freeze([...RUNTIME_FILES, ...declared].sort()),
    nodeSha256: hash(process.execPath),
    gatewayBundle,
    gatewaySha256: gateway.manifest.bundleSha256,
  });
  SNAPSHOTS.add(snapshot);
  return snapshot;
}

function createIsolatedRuntimeWorkspace(snapshot) {
  requireSnapshot(snapshot);
  if (WORKSPACES.has(snapshot)) throw fail('release_isolated_workspace_already_created');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-isolated-release-'));
  WORKSPACES.set(snapshot, { directory, preparationStarted: false });
  for (const row of snapshot.files) {
    const source = regularSource(snapshot.root, row.file);
    if (hash(source) !== row.sha256) throw fail('release_isolated_source_changed');
    const target = path.join(directory, ...row.file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    if (hash(target) !== row.sha256) throw fail('release_isolated_copy_changed');
  }
  return directory;
}

function verifyIsolatedRuntime(snapshot, directory) {
  verifySourceCopies(snapshot, directory);
  const runtimeDir = path.join(directory, 'dist', 'staging', 'runtime');
  const manifest = JSON.parse(
    fs.readFileSync(
      regularSource(directory, 'dist/staging/runtime/release-runtime-manifest.json'),
      'utf8'
    )
  );
  if (
    manifest?.schemaVersion !== 2 ||
    !manifest.sourceSha256 ||
    Object.keys(manifest.sourceSha256).sort().join('\n') !== snapshot.runtimeFiles.join('\n')
  )
    throw fail('release_isolated_runtime_manifest_invalid');
  for (const file of snapshot.runtimeFiles) {
    const original = snapshot.files.find((row) => row.file === file);
    if (
      manifest.sourceSha256[file] !== original.sha256 ||
      hash(regularSource(runtimeDir, file)) !== original.sha256
    )
      throw fail('release_isolated_runtime_source_changed');
  }
  if (
    manifest.nodeSha256 !== snapshot.nodeSha256 ||
    hash(regularSource(runtimeDir, 'runtime/node/node.exe')) !== snapshot.nodeSha256 ||
    hash(regularSource(runtimeDir, 'package-lock.json')) !== manifest.packageLockSha256
  )
    throw fail('release_isolated_runtime_identity_invalid');
  if (
    process.platform === 'win32' &&
    (typeof manifest.contextRecoveryNativeSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.contextRecoveryNativeSha256) ||
      hash(regularSource(runtimeDir, 'runtime/native/hpm-context-recovery-key.exe')) !==
        manifest.contextRecoveryNativeSha256)
  )
    throw fail('release_isolated_runtime_identity_invalid');
  let gateway;
  try {
    gateway = readPackagedEvidenceGateway(runtimeDir);
  } catch {
    throw fail('release_isolated_gateway_identity_invalid');
  }
  if (
    manifest.evidenceGatewayBundleSha256 !== snapshot.gatewaySha256 ||
    gateway.manifest.bundleSha256 !== snapshot.gatewaySha256 ||
    hash(regularSource(runtimeDir, snapshot.gatewayBundle)) !== snapshot.gatewaySha256
  )
    throw fail('release_isolated_gateway_identity_invalid');
  const originalPackage = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const expectedDependencies = selectRuntimeDependencies(originalPackage);
  if (
    manifest.applicationVersion !== originalPackage.version ||
    manifest.nodeVersion !== process.version ||
    JSON.stringify(manifest.dependencies) !== JSON.stringify(expectedDependencies)
  )
    throw fail('release_isolated_runtime_manifest_invalid');
  const validation = validateReleaseDirectory(runtimeDir, expectedDependencies, {
    requireExecutable: false,
  });
  if (!validation.ok) throw fail('release_isolated_runtime_governance_failed');
  const originalLock = JSON.parse(
    fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8')
  );
  const runtimeLock = JSON.parse(
    fs.readFileSync(path.join(runtimeDir, 'package-lock.json'), 'utf8')
  );
  let lockedPackages = 0;
  for (const [key, value] of Object.entries(runtimeLock.packages ?? {})) {
    if (key === '') continue;
    const prior = originalLock.packages?.[key];
    if (!prior || value.version !== prior.version || value.integrity !== prior.integrity)
      throw fail('release_isolated_dependency_identity_changed');
    lockedPackages++;
  }
  if (lockedPackages === 0) throw fail('release_isolated_dependency_identity_changed');
  return {
    runtimeDir,
    runtimeSourcesMatched: snapshot.runtimeFiles.length,
    copiedBuildSourcesMatched: snapshot.files.length,
    lockedPackages,
    manifestSha256: hash(path.join(runtimeDir, 'release-runtime-manifest.json')),
    packageLockSha256: manifest.packageLockSha256,
    nodeSha256: snapshot.nodeSha256,
    sourceSnapshotUnchanged: true,
    releaseDirectoryGovernancePassed: true,
    stagedDependenciesMatchOriginalLock: true,
    installedApplicationAcceptanceVerified: false,
    nativeHostAdoptionVerified: false,
  };
}

async function prepareIsolatedRuntime(snapshot, directory) {
  verifySourceCopies(snapshot, directory);
  const workspace = WORKSPACES.get(snapshot);
  if (workspace.preparationStarted) throw fail('release_isolated_preparation_already_started');
  // The inherited release script removes its output recursively. Never let
  // a preexisting directory or junction redirect that cleanup outside the
  // minted workspace, including dangling links hidden by existsSync.
  requireAbsent(directory, 'dist');
  requireAbsent(directory, 'isolated-user');
  workspace.preparationStarted = true;
  // No provider credentials or installed-client environment reach the child.
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT']
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]])
  );
  fs.mkdirSync(path.join(directory, 'isolated-user'));
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    env[name] = path.join(directory, 'isolated-user', name.toLowerCase());
    fs.mkdirSync(env[name]);
  }
  const npmConfig = path.join(directory, 'isolated-user', 'npm-empty-config');
  const npmGlobalConfig = path.join(directory, 'isolated-user', 'npm-empty-global-config');
  fs.writeFileSync(npmConfig, '', { flag: 'wx' });
  fs.writeFileSync(npmGlobalConfig, '', { flag: 'wx' });
  Object.assign(env, {
    // Reuse only installed compiler toolchains; registry config/credentials and
    // package downloads remain in a new isolated Cargo home.
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), '.rustup'),
    CARGO_HOME: path.join(directory, 'isolated-user', 'cargo'),
    npm_config_userconfig: npmConfig,
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_cache: path.join(directory, 'isolated-user', 'npm-cache'),
  });
  const cli = path.join(directory, 'scripts', 'prepare-release-runtime.js');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli], {
      cwd: directory,
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', () => reject(fail('release_isolated_spawn_failed')));
    child.once('exit', (status) => resolve(status));
  });
  if (code !== 0) throw fail('release_isolated_preparation_failed');
  return verifyIsolatedRuntime(snapshot, directory);
}

module.exports = {
  captureIsolatedRuntimeSources,
  createIsolatedRuntimeWorkspace,
  prepareIsolatedRuntime,
  verifyIsolatedRuntime,
};
