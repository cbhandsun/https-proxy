'use strict';

const fs = require('fs');
const path = require('path');
const { selectRuntimeDependencies, validateGeneratedLayout } = require('../lib/release/layout');

const repoRoot = path.resolve(__dirname, '..');
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const releaseRuntimeSource = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'prepare-release-runtime.js'),
  'utf8'
);
const declaredProxySources = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'scripts', 'release-proxy-sources.json'), 'utf8')
);
const resources = tauriConfig.bundle && tauriConfig.bundle.resources;
const errors = [];
errors.push(...validateGeneratedLayout(repoRoot));

function discoverProxySources(directoryPath, result = []) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`Proxy source tree must not contain symbolic links: ${absolutePath}`);
    } else if (entry.isDirectory()) {
      discoverProxySources(absolutePath, result);
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.js') {
      result.push(path.relative(repoRoot, absolutePath).replaceAll('\\', '/'));
    }
  }
  return result;
}

if (
  !Array.isArray(declaredProxySources) ||
  declaredProxySources.some((entry) => typeof entry !== 'string')
) {
  errors.push('scripts/release-proxy-sources.json must contain a string array');
} else {
  const declared = [...new Set(declaredProxySources)].sort();
  const discovered = discoverProxySources(path.join(repoRoot, 'lib', 'proxy')).sort();
  if (declared.length !== declaredProxySources.length) {
    errors.push('Release proxy source manifest must not contain duplicate entries');
  }
  const missing = discovered.filter((entry) => !declared.includes(entry));
  const stale = declared.filter((entry) => !discovered.includes(entry));
  if (missing.length > 0) errors.push(`Undeclared proxy runtime sources: ${missing.join(', ')}`);
  if (stale.length > 0) errors.push(`Missing declared proxy runtime sources: ${stale.join(', ')}`);
}

if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
  errors.push('Tauri bundle.resources must use an explicit source-to-target map');
} else {
  const serialized = JSON.stringify(resources);
  if (serialized.includes('dist/artifacts'))
    errors.push('Tauri resources must not depend on final artifact output');
  if (serialized.includes('dist/release-runtime') || serialized.includes('dist/release/')) {
    errors.push('Tauri resources must not use legacy release output paths');
  }
  if (!serialized.includes('dist/staging/runtime/runtime'))
    errors.push('Tauri resources must include staged Node runtime');
  if (!serialized.includes('dist/staging/runtime/node_modules'))
    errors.push('Tauri resources must include staged production dependencies');
  if (!serialized.includes('dist/staging/runtime/lib/proxy'))
    errors.push('Tauri resources must include staged proxy sources');
  if (serialized.includes('../lib/proxy'))
    errors.push('Tauri resources must not bundle proxy sources directly from the working tree');
}

try {
  const runtimeDependencies = selectRuntimeDependencies(packageJson);
  if (Object.prototype.hasOwnProperty.call(runtimeDependencies, 'chart.js')) {
    errors.push('Frontend-only chart.js must not be staged in the Node release runtime');
  }
} catch (error) {
  errors.push(error.message);
}

const beforeBuild = String((tauriConfig.build && tauriConfig.build.beforeBuildCommand) || '');
if (packageJson.version !== tauriConfig.version) {
  errors.push(
    `package.json and Tauri versions must match: ${packageJson.version} != ${tauriConfig.version}`
  );
}
const releasePrepareScript = String(
  (packageJson.scripts && packageJson.scripts['release:prepare']) || ''
);
const preparesReleaseRuntimeDirectly = beforeBuild.includes('prepare-release-runtime.js');
const preparesReleaseRuntimeViaPackageScript =
  beforeBuild.includes('npm run release:prepare') &&
  releasePrepareScript.includes('prepare-release-runtime.js');
if (!preparesReleaseRuntimeDirectly && !preparesReleaseRuntimeViaPackageScript) {
  errors.push('Tauri beforeBuildCommand must prepare a clean release runtime');
}
if (!releaseRuntimeSource.includes("'--package-lock-only'")) {
  errors.push('Release runtime preparation must prune its package lock');
}
for (const requiredFlag of ["'--omit=dev'", "'--ignore-scripts'"]) {
  if (!releaseRuntimeSource.includes(requiredFlag)) {
    errors.push(`Release runtime preparation must use ${requiredFlag}`);
  }
}
if (
  !releaseRuntimeSource.includes('release-proxy-sources.json') ||
  !releaseRuntimeSource.includes('sourceSha256')
) {
  errors.push('Release runtime preparation must use and hash the exact proxy source manifest');
}

for (const scriptName of [
  'clean:frontend',
  'clean:coverage',
  'clean:staging',
  'clean:artifacts',
  'clean:release',
  'clean:release:cache',
  'release:prepare',
  'release:check',
  'release:portable',
  'release:portable:from-build',
]) {
  if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
    errors.push(`Missing package script: ${scriptName}`);
  }
}

const verifyScript = String((packageJson.scripts && packageJson.scripts.verify) || '');
const rustTestScript = String((packageJson.scripts && packageJson.scripts['test:rust']) || '');
if (!verifyScript.includes('npm run test:rust')) {
  errors.push('verify must run the self-contained Rust test gate');
}
if (!verifyScript.includes('npm run test:frontend:coverage')) {
  errors.push('verify must run the frontend runtime/model coverage gate');
}
if (!rustTestScript.includes('npm run release:prepare')) {
  errors.push('test:rust must prepare release runtime before invoking cargo');
}
if (!rustTestScript.includes('cargo test --manifest-path src-tauri/Cargo.toml')) {
  errors.push('test:rust must run the Tauri Rust test suite');
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[release-governance] ${error}`);
  process.exit(1);
}

console.log('[release-governance] ok');
