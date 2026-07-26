'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const testFiles = [
  'test/frontend/frontend-build-governance.test.js',
  'test/frontend/dependencies.test.js',
  'test/frontend/domain-boundaries.test.js',
  'test/frontend/configuration-model.test.js',
  'test/frontend/runtime.test.js',
  'test/frontend/app-ux.test.js',
  'test/frontend/app-bridge.test.js',
  'test/frontend/app-audit.test.js',
  'test/frontend/app-diagnostics.test.js',
  'test/frontend/app-cli.test.js',
];

for (const testFile of testFiles) {
  const result = spawnSync(process.execPath, [testFile], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    const detail = result.error && result.error.message ? `: ${result.error.message}` : '';
    throw new Error(`Frontend test failed: ${testFile}${detail}`);
  }
}

console.log(`[frontend-tests] ok: ${testFiles.length}/${testFiles.length}`);
