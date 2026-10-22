'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discoverTestFiles } = require('../lib/test-discovery');
test('installed matrix receipts fail closed before rollback and remain uniformly discovered', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'test/fixtures/nsis-installed-settings-receipt-mocks.ps1',
    ],
    { encoding: 'utf8', timeout: 45000, maxBuffer: 16384 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /installedSettingsReceiptRefusals=\d+; installerExecutions=0; helperExecutions=0; networkRequests=0/
  );
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_UNTRUSTED_CONTENT/);
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-installed-settings-receipt.test.js'
    )
  );
  const runner = fs.readFileSync('scripts/lib/nsis-lifecycle-runner.psm1', 'utf8');
  assert.match(
    runner,
    /Invoke-HpmPayloadSettingsMatrix \$root \$installDir \$manifestHashes.current/
  );
  assert.match(
    runner,
    /\$encryptedState.settingsMatrix = ConvertTo-HpmInstalledSettingsMatrixReceipt/
  );
  assert.match(
    runner,
    /Import-Module \(Join-Path \$PSScriptRoot 'nsis-settings-matrix\.psm1'\) -Force/
  );
  assert.match(runner, /NSIS_RUNTIME_BOUNDARIES=/);
});
