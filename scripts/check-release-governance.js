'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const resources = tauriConfig.bundle && tauriConfig.bundle.resources;
const errors = [];

if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
  errors.push('Tauri bundle.resources must use an explicit source-to-target map');
} else {
  const serialized = JSON.stringify(resources);
  if (serialized.includes('dist/portable'))
    errors.push('Tauri resources must not depend on portable output');
  if (!serialized.includes('dist/release-runtime/runtime'))
    errors.push('Tauri resources must include staged Node runtime');
  if (!serialized.includes('dist/release-runtime/node_modules'))
    errors.push('Tauri resources must include staged production dependencies');
}

const beforeBuild = String((tauriConfig.build && tauriConfig.build.beforeBuildCommand) || '');
if (!beforeBuild.includes('prepare-release-runtime.js')) {
  errors.push('Tauri beforeBuildCommand must prepare a clean release runtime');
}

for (const scriptName of [
  'clean:release',
  'clean:release:cache',
  'release:prepare',
  'release:check',
  'release:portable',
]) {
  if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
    errors.push(`Missing package script: ${scriptName}`);
  }
}

const verifyScript = String((packageJson.scripts && packageJson.scripts.verify) || '');
const releasePrepareIndex = verifyScript.indexOf('npm run release:prepare');
const rustTestIndex = verifyScript.indexOf('npm run test:rust');
if (releasePrepareIndex < 0 || rustTestIndex < 0 || releasePrepareIndex > rustTestIndex) {
  errors.push('verify must prepare release runtime before running Rust tests');
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[release-governance] ${error}`);
  process.exit(1);
}

console.log('[release-governance] ok');
