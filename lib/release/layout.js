'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertSafeReleasePath } = require('./governance');

const RUNTIME_DEPENDENCY_CONFIG_KEY = 'releaseRuntimeDependencies';
const ALLOWED_DIST_ENTRIES = new Set(['archive', 'artifacts', 'staging']);
const ALLOWED_STAGING_ENTRIES = new Set(['portable', 'runtime']);
const ALLOWED_ARTIFACT_ENTRIES = new Set(['installers', 'portable', 'sbom']);
const CHECKSUM_FILE_NAMES = new Set(['SHA256SUMS.json', 'SHA256SUMS.txt']);

function resolveReleaseLayout(repoRoot) {
  const root = path.resolve(repoRoot);
  const distRoot = path.join(root, 'dist');
  return Object.freeze({
    distRoot,
    stagingRoot: assertSafeReleasePath(root, path.join(distRoot, 'staging')),
    runtimeDir: assertSafeReleasePath(root, path.join(distRoot, 'staging', 'runtime')),
    portableStagingDir: assertSafeReleasePath(root, path.join(distRoot, 'staging', 'portable')),
    artifactsRoot: assertSafeReleasePath(root, path.join(distRoot, 'artifacts')),
    installersDir: assertSafeReleasePath(root, path.join(distRoot, 'artifacts', 'installers')),
    portableRoot: assertSafeReleasePath(root, path.join(distRoot, 'artifacts', 'portable')),
    sbomDir: assertSafeReleasePath(root, path.join(distRoot, 'artifacts', 'sbom')),
    archiveRoot: assertSafeReleasePath(root, path.join(distRoot, 'archive')),
  });
}

function selectRuntimeDependencies(packageDocument) {
  if (!packageDocument || typeof packageDocument !== 'object' || Array.isArray(packageDocument)) {
    throw new TypeError('package document must be an object');
  }
  const dependencyNames = packageDocument.hpm && packageDocument.hpm[RUNTIME_DEPENDENCY_CONFIG_KEY];
  if (
    !Array.isArray(dependencyNames) ||
    dependencyNames.length === 0 ||
    dependencyNames.some((name) => typeof name !== 'string' || name.trim() === '')
  ) {
    throw new Error(`package.json hpm.${RUNTIME_DEPENDENCY_CONFIG_KEY} must be a non-empty array`);
  }
  const uniqueNames = [...new Set(dependencyNames.map((name) => name.trim()))].sort();
  const declaredDependencies = packageDocument.dependencies || {};
  const missing = uniqueNames.filter(
    (name) => !Object.prototype.hasOwnProperty.call(declaredDependencies, name)
  );
  if (missing.length > 0) {
    throw new Error(`Release runtime dependencies are not declared: ${missing.join(', ')}`);
  }
  return Object.fromEntries(uniqueNames.map((name) => [name, declaredDependencies[name]]));
}

function createRuntimePackage(packageDocument) {
  return {
    name: packageDocument.name,
    version: packageDocument.version,
    private: true,
    dependencies: selectRuntimeDependencies(packageDocument),
  };
}

function createRuntimePackageLock(packageLock, runtimePackage) {
  if (!packageLock || typeof packageLock !== 'object' || Array.isArray(packageLock)) {
    throw new TypeError('package lock must be an object');
  }
  if (!packageLock.packages || !packageLock.packages['']) {
    throw new Error('package lock root package is missing');
  }
  const runtimeLock = JSON.parse(JSON.stringify(packageLock));
  runtimeLock.name = runtimePackage.name;
  runtimeLock.version = runtimePackage.version;
  runtimeLock.packages[''] = {
    name: runtimePackage.name,
    version: runtimePackage.version,
    dependencies: runtimePackage.dependencies,
  };
  return runtimeLock;
}

function validateGeneratedLayout(repoRoot) {
  const { distRoot, stagingRoot, artifactsRoot } = resolveReleaseLayout(repoRoot);
  const errors = [];
  const validateChildren = (directory, allowedNames, label) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        errors.push(`${label} must not contain symbolic links: ${entry.name}`);
      } else if (!entry.isDirectory()) {
        errors.push(`${label} must contain directories only: ${entry.name}`);
      } else if (!allowedNames.has(entry.name)) {
        errors.push(`${label} contains unsupported directory: ${entry.name}`);
      }
    }
  };
  const validateArtifactFiles = (directory, label, isAllowedFile) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        errors.push(`${label} must not contain symbolic links: ${entry.name}`);
      } else if (!entry.isFile()) {
        errors.push(`${label} must contain files only: ${entry.name}`);
      } else if (!isAllowedFile(entry.name)) {
        errors.push(`${label} contains unsupported file: ${entry.name}`);
      }
    }
  };
  validateChildren(distRoot, ALLOWED_DIST_ENTRIES, 'dist');
  validateChildren(stagingRoot, ALLOWED_STAGING_ENTRIES, 'dist/staging');
  validateChildren(artifactsRoot, ALLOWED_ARTIFACT_ENTRIES, 'dist/artifacts');
  validateArtifactFiles(
    path.join(artifactsRoot, 'installers'),
    'dist/artifacts/installers',
    (fileName) =>
      /\.(exe|msi|dmg|appimage|deb|rpm|tar\.gz)$/i.test(fileName) ||
      CHECKSUM_FILE_NAMES.has(fileName)
  );
  validateArtifactFiles(
    path.join(artifactsRoot, 'portable'),
    'dist/artifacts/portable',
    (fileName) => /\.zip$/i.test(fileName) || CHECKSUM_FILE_NAMES.has(fileName)
  );
  validateArtifactFiles(path.join(artifactsRoot, 'sbom'), 'dist/artifacts/sbom', (fileName) =>
    fileName.toLowerCase().endsWith('.json')
  );
  return errors;
}

module.exports = {
  ALLOWED_ARTIFACT_ENTRIES,
  ALLOWED_DIST_ENTRIES,
  ALLOWED_STAGING_ENTRIES,
  CHECKSUM_FILE_NAMES,
  RUNTIME_DEPENDENCY_CONFIG_KEY,
  createRuntimePackage,
  createRuntimePackageLock,
  resolveReleaseLayout,
  selectRuntimeDependencies,
  validateGeneratedLayout,
};
