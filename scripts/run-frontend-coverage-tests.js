'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const testFiles = [
  'test/frontend/configuration-model.test.js',
  'test/frontend/context-recovery-status.test.js',
  'test/frontend/context-policy-controls.test.js',
  'test/frontend/context-recovery-controls.test.js',
  'test/frontend/context-recovery-clear-client.test.js',
  'test/frontend/profile-save.test.js',
  'test/frontend/proxy-command.test.js',
  'test/frontend/runtime.test.js',
];

for (const testFile of testFiles) {
  const result = spawnSync(process.execPath, [testFile], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Frontend coverage test failed: ${testFile}`);
  }
}

console.log(`[frontend-coverage] ok: ${testFiles.length}/${testFiles.length}`);
