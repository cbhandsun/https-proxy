'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { OWNED_STOP_PHASES } = require('../scripts/lib/nsis-client-owned-failure');
const root = path.resolve(__dirname, '..');
const pwsh = process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'pwsh';
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

test('actual PowerShell stop helpers preserve first failure and disclose only fixed controller stages', () => {
  const result = spawnSync(
    pwsh,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(__dirname, 'fixtures/nsis-client-owned-failure.ps1'),
      '-ScriptFile',
      path.join(root, 'scripts/lib/nsis-client-owned-process.ps1'),
    ],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { checks: 8, nativeCalls: 0, networkCalls: 0 });
});

test('actual PowerShell matrix phase parser matches every owned-stop enum and rejects other clients and unknown causes', (t) => {
  const owned = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'hpm-stop-phases-'));
  t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
  const valid = ['default', 'enhanced'].flatMap((mode) =>
    OWNED_STOP_PHASES.map((phase) => 'codex-' + mode + '-cli-' + phase)
  );
  const invalid = valid.map((phase) => phase.replace(/^codex-/, 'claude-'));
  invalid.push(
    'codex-default-cli-restart-stop-PRIVATE',
    'codex-default-cli-restart-stop-controller-unknown'
  );
  const values = [...valid, ...invalid];
  const script = `
    $ErrorActionPreference = 'Stop'
    Import-Module ${quote(path.join(root, 'scripts/lib/nsis-client-matrix-receipt.psm1'))} -Force
    $owned = ${quote(owned)}
    $values = ${quote(JSON.stringify(values))} | ConvertFrom-Json
    $index = 0
    foreach ($phase in $values) {
      $text = @{schemaVersion=1; phase=$phase; failed=$true} | ConvertTo-Json -Compress
      [IO.File]::WriteAllText((Join-Path $owned 'matrix-phase.json'), $text)
      $lines = @(Write-HpmInstalledClientPhase $owned 6>&1)
      $expected = if ($index -lt ${valid.length}) { $phase } else { 'unobserved' }
      if ($lines.Count -ne 1 -or [string]$lines[0] -cne ('hpm_installed_client_phase=' + $expected)) { throw 'phase_failed' }
      $index++
    }
    [Console]::Out.Write($index)
  `;
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(Number(result.stdout), values.length);
});
