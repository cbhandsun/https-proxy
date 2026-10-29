'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('installed NSIS payload executes install, verification, callback and conservative cleanup with mocked machine effects', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-installed-payload-unit-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace');
  const runner = path.join(temporary, 'runner');
  fs.mkdirSync(runner);
  for (const name of [
    'scripts/lib/nsis-installed-client-payload.psm1',
    'scripts/lib/nsis-lifecycle.psm1',
    'scripts/lib/nsis-runtime-boundary.psm1',
    'scripts/context-hosted/shared/hosted-materials.ps1',
    'scripts/fixtures/nsis-lifecycle-offline-config.json',
  ]) {
    const destination = path.join(workspace, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, name), destination);
  }
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(root, 'test/fixtures/context-hosted/installed-client-payload.ps1'),
      '-Repository',
      workspace,
      '-FixtureRoot',
      runner,
    ],
    {
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 16384,
      env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', RUNNER_OS: '', CI: '' },
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('private'), false);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 21);
  for (const row of rows) {
    if (row.mode === 'success') {
      assert.equal(row.error, null);
      assert.equal(row.receipt.installedClientQualified, false);
      assert.equal(row.installed, 1);
      assert.equal(row.uninstalled, 1);
      assert.equal(row.retained, false);
      assert.deepEqual(row.leaseOrder, [
        'dispose:payload',
        'uninstall',
        'dispose:hpm-installed-clients',
        'remove-root',
      ]);
      continue;
    }
    const cleanupFailure = [
      'partialinstall',
      'registration',
      'uninstallerchanged',
      'stop',
      'stoptype',
      'uninstall',
    ].includes(row.mode);
    assert.equal(
      row.error,
      cleanupFailure ? 'installed_payload_cleanup_failed' : 'installed_payload_rejected',
      row.mode
    );
    assert.equal(row.retained, cleanupFailure || row.mode === 'root', row.mode);
    if (
      ['sha', 'manifestsha', 'process', 'existing', 'data', 'root', 'setups'].includes(row.mode)
    ) {
      assert.equal(row.installed, 0, row.mode);
      assert.equal(row.stopped, false, row.mode);
    } else assert.equal(row.stopped, true, row.mode);
    if (
      ['partialinstall', 'registration', 'uninstallerchanged', 'stop', 'stoptype'].includes(
        row.mode
      )
    )
      assert.equal(row.uninstalled, 0, row.mode);
  }
});

test('payload installer process retains original 180 second boundary and contains only its owned timed-out tree', () => {
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = `
    $ErrorActionPreference = 'Stop'
    $module = Import-Module ${quote(path.join(root, 'scripts/lib/nsis-installed-client-payload.psm1'))} -Force -PassThru
    & $module {
      function script:Start-Process {
        param($FilePath,$ArgumentList,[switch]$PassThru,$WindowStyle)
        if ($FilePath -cne 'owned-synthetic-setup' -or $WindowStyle -cne 'Hidden') { throw 'fixture_invalid' }
        $process = [pscustomobject]@{ ExitCode = $(if ($global:Mode -eq 'exit') { 1 } else { 0 }) }
        $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
          param($milliseconds)
          $global:Waits += $milliseconds
          return -not ($global:Mode -eq 'timeout' -and $milliseconds -eq 180000)
        }
        $process | Add-Member -MemberType ScriptMethod -Name Kill -Value { param($tree) if (-not $tree) { throw 'fixture_invalid' }; $global:Killed = $true }
        $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $global:Disposed = $true }
        return $process
      }
      $rows = @()
      foreach ($global:Mode in @('success','timeout','exit')) {
        $global:Waits = @(); $global:Killed = $false; $global:Disposed = $false
        $failed = $false
        try { Invoke-HpmInstalledPayloadProcess 'owned-synthetic-setup' @('/S','/D=owned') } catch { $failed = $true }
        $rows += @{ mode = $global:Mode; failed = $failed; waits = $global:Waits; killed = $global:Killed; disposed = $global:Disposed }
      }
      $rows | ConvertTo-Json -Compress -Depth 3
    }
  `;
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 8192 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  for (const row of rows) {
    assert.equal(row.failed, row.mode !== 'success', row.mode);
    assert.equal(row.killed, row.mode === 'timeout', row.mode);
    assert.equal(row.disposed, true, row.mode);
    assert.deepEqual(row.waits, row.mode === 'timeout' ? [180000, 5000] : [180000], row.mode);
  }
});
