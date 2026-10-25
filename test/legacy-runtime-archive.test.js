'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
test('real ZIP extraction validates bounded manifests, paths, byte identities, shapes and failure cases', (t) => {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'hpm-582-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(__dirname, 'helpers/legacy-runtime-archive-check.ps1'),
      '-ModulePath',
      path.join(__dirname, '../scripts/lib/legacy-runtime-archive.psm1'),
      '-Root',
      root,
    ],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 4096, windowsHide: true }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { passedCases: 16 });
});
