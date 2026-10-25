'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('installed 582 receipt enforces exact fields, types, source and qualification scope across PowerShell JSON', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(__dirname, 'helpers/installed-legacy-receipt-check.ps1'),
      '-ModulePath',
      path.join(__dirname, '../scripts/lib/nsis-installed-legacy-receipt.psm1'),
    ],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 4096, windowsHide: true }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { passedCases: 83 });
});
