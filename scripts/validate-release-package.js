'use strict';

const fs = require('fs');
const path = require('path');
const { assertSafeReleasePath, validateReleaseDirectory } = require('../lib/release/governance');
const { selectRuntimeDependencies } = require('../lib/release/layout');

const repoRoot = path.resolve(__dirname, '..');
const argumentIndex = process.argv.indexOf('--dir');
if (argumentIndex < 0 || !process.argv[argumentIndex + 1]) {
  throw new Error('Usage: node scripts/validate-release-package.js --dir <directory>');
}

const releaseDir = assertSafeReleasePath(
  repoRoot,
  path.resolve(repoRoot, process.argv[argumentIndex + 1])
);
const sourcePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const result = validateReleaseDirectory(releaseDir, selectRuntimeDependencies(sourcePackage), {
  requireExecutable: process.argv.includes('--runtime-only') === false,
});

if (!result.ok) {
  for (const error of result.errors) console.error(`[release-check] ${error}`);
  process.exit(1);
}

console.log(`[release-check] ok: ${path.relative(repoRoot, releaseDir)}`);
