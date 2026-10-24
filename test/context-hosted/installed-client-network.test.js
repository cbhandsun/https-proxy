'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

test('installed client containment executes three fixed programs and closes partial failures with mocked Windows effects', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-installed-network-unit-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(root, 'test/fixtures/context-hosted/installed-client-network.ps1'),
      '-Helper',
      path.join(root, 'scripts/context-hosted/shared/installed-client-network.ps1'),
      '-Materials',
      path.join(root, 'scripts/context-hosted/shared/hosted-materials.ps1'),
      '-FixtureRoot',
      temporary,
    ],
    {
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 16384,
      env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', CI: '' },
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('private'), false);
  const rows = JSON.parse(result.stdout);
  for (const row of rows) {
    assert.equal(row.filesDisposed, row.leases, row.mode);
    assert.equal(
      row.failed,
      ['nodehash', 'root', 'missing', 'collision', 'create', 'identity', 'wfp', 'changed'].includes(
        row.mode
      ),
      row.mode
    );
    assert.equal(row.cleanupFailed, ['stop', 'dispose', 'remove'].includes(row.mode), row.mode);
    if (!['stop', 'remove'].includes(row.mode)) assert.equal(row.rulesRetained, 0, row.mode);
    if (row.mode === 'stop') {
      assert.equal(row.rulesRetained, 3);
      assert.equal(row.wfpDisposed, 0);
    }
    if (row.mode === 'success') {
      assert.equal(row.leases, 3);
      assert.equal(row.wfpCreated, 3);
      assert.equal(row.wfpDisposed, 3);
    }
    if (row.mode === 'wfp') {
      assert.equal(row.wfpCreated, 2);
      assert.equal(row.wfpDisposed, 1);
    }
  }
});

test('installed hosts mapping executes original mutation and byte restore with default names unchanged', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-installed-hosts-unit-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = fs.readFileSync(
    path.join(root, 'scripts/context-hosted/shared/hosted-network.ps1'),
    'utf8'
  );
  const mapping = source.slice(
    source.indexOf("        $networkStage = 'hosts_mapping'"),
    source.indexOf('        # Trusted harness callback')
  );
  const restore = source.slice(
    source.indexOf('        if ($hostsChanged) {'),
    source.indexOf('        # An unproved child tree')
  );
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = `
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    . ${quote(path.join(root, 'scripts/context-hosted/shared/installed-client-network.ps1'))}
    function Assert-Physical { param($Path,$Directory) if (-not [IO.File]::Exists($Path)) { throw 'fixture_invalid' } }
    function Clear-DnsClientCache {}
    function Hash-Bytes([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
    $env:SystemRoot = ${quote(temporary)}
    $directory = Join-Path $env:SystemRoot 'System32/drivers/etc'
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $file = Join-Path $directory 'hosts'
    $nonce = 'synthetic'
    $observed = @()
    $body = [scriptblock]::Create(${quote(mapping)})
    $restoreBody = [scriptblock]::Create(${quote(restore)})
    foreach ($InstalledClientMatrix in @($false, $true)) {
      foreach ($collision in @($false,$true)) {
        $original = [Text.Encoding]::UTF8.GetBytes($(if ($collision) { '127.0.0.1 api.anthropic.com' } else { '# synthetic original hosts' }))
        [IO.File]::WriteAllBytes($file,$original)
        $hostsChanged = $false
        $failed = $false
        try { . $body } catch { $failed = $true }
        if ($failed -ne ($InstalledClientMatrix -and $collision)) { throw 'fixture_invalid' }
        if ($hostsChanged) {
          $text = [IO.File]::ReadAllText($file)
          if ($text.Contains('api.anthropic.com #') -ne $InstalledClientMatrix) { throw 'fixture_invalid' }
          if ((Hash-Bytes ([IO.File]::ReadAllBytes($file))) -cne $hostsEditedHash) { throw 'fixture_invalid' }
          $restoreFailed = $false
          . $restoreBody
          if ($restoreFailed) { throw 'fixture_invalid' }
        }
        if ((Hash-Bytes ([IO.File]::ReadAllBytes($file))) -cne (Hash-Bytes $original)) { throw 'fixture_invalid' }
        $observed += @{ installed = $InstalledClientMatrix; collision = $collision; failed = $failed }
      }
    }
    if (((Get-HpmHostedNetworkNames $false) -join ',') -cne 'api.openai.com,n08-target.invalid') { throw 'fixture_invalid' }
    if (((Get-HpmHostedNetworkNames $true) -join ',') -cne 'api.openai.com,n08-target.invalid,api.anthropic.com') { throw 'fixture_invalid' }
    $observed | ConvertTo-Json -Compress
  `;
  const result = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 16384 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).length, 4);
});
