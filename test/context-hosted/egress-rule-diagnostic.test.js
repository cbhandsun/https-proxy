'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

test('egress diagnosis is independent and cannot replace the original qualification gates', () => {
  const workflow = fs
    .readFileSync(path.join(root, '.github/workflows/windows-context-recovery-hosted.yml'), 'utf8')
    .replaceAll('\r\n', '\n');
  const diagnostic = workflow.slice(workflow.indexOf('  egress-diagnostic:'));
  assert.match(diagnostic, /timeout-minutes: 5/);
  assert.match(diagnostic, /persist-credentials: false/);
  assert.match(diagnostic, /ref: \$\{\{ github.sha \}\}/);
  assert.match(diagnostic, /run: \.\/scripts\/context-hosted\/shared\/egress-rule-diagnostic.ps1/);
  assert.doesNotMatch(
    diagnostic,
    /needs:|continue-on-error:|upload-artifact|download-artifact|secrets\./
  );
  assert.match(workflow, /context-recovery:\s+needs: source-gates/);
  const script = fs.readFileSync(
    path.join(root, 'scripts/context-hosted/shared/egress-rule-diagnostic.ps1'),
    'utf8'
  );
  assert.doesNotMatch(script, /Start-Process|Set-NetFirewallProfile|Remove-Item[^\r\n]*-Recurse/);
  assert.match(script, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
  assert.match(script, /if \(\$created -and/);
});

test(
  'fixed egress probes isolate native errors and reclaim partial creates with mocked commands',
  { skip: process.platform !== 'win32', timeout: 30000 },
  () => {
    const sentinel = 'synthetic-private-input-must-not-be-logged';
    const helper = path.join(root, 'scripts/context-hosted/shared/egress-rule-diagnostic.ps1');
    const script = `
    . ${quote(helper)}
    function Get-NetFirewallRule {
      param($Name, $ErrorAction, $ErrorVariable)
      if ($mode -eq 'query_before' -or ($mode -eq 'query_cleanup' -and $script:exists -and $ErrorAction -eq 'SilentlyContinue')) { throw ${quote(sentinel)} }
      if ($script:exists) { [pscustomobject]@{ Enabled = 'True'; Action = 'Block'; Direction = 'Outbound' } }
    }
    function New-NetFirewallRule {
      param($Name, $DisplayName, $Direction, $Action, $Enabled, $Profile, $Program, $RemoteAddress, $ErrorAction)
      $script:calls++
      $script:addressCount = $RemoteAddress.Count
      if ($mode -eq 'create') { throw [ArgumentException]::new(${quote(sentinel)}) }
      $script:exists = $true
      if ($mode -eq 'partial') { throw [ArgumentException]::new(${quote(sentinel)}) }
    }
    function Get-NetFirewallApplicationFilter {
      param($ErrorAction)
      [pscustomobject]@{ Program = $(if ($mode -eq 'identity') { 'wrong' } else { ${quote(sentinel)} }) }
    }
    function Remove-NetFirewallRule {
      param($Name, $ErrorAction)
      $script:removes++
      if ($mode -eq 'cleanup') { throw ${quote(sentinel)} }
      $script:exists = $false
    }
    foreach ($mode in @('success', 'create', 'partial', 'identity', 'cleanup', 'collision', 'query_before', 'query_cleanup')) {
      $cases = if ($mode -eq 'success') { @('original', 'ipv4', 'ipv6', 'ipv6_split', 'full_split') } else { @('original') }
      foreach ($case in $cases) {
        $script:exists = $mode -eq 'collision'
        $script:calls = 0; $script:removes = 0; $script:addressCount = 0
        $result = Invoke-HpmEgressRuleProbe -Case $case -Name ('HPM-EGRESS-DIAG-' + ('a' * 32)) -Program ${quote(sentinel)}
        @{ mode = $mode; result = $result; calls = $script:calls; removes = $script:removes; addressCount = $script:addressCount } | ConvertTo-Json -Depth 3 -Compress
      }
    }
    $script:calls = 0
    try { Invoke-HpmEgressRuleProbe -Case invalid -Name ('HPM-EGRESS-DIAG-' + ('a' * 32)) -Program ${quote(sentinel)} }
    catch { @{ rejected = $true; calls = $script:calls } | ConvertTo-Json -Compress }
  `;
    const execution = spawnSync(
      'C:/Program Files/PowerShell/7/pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 8192 }
    );
    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 0);
    assert.equal(execution.stderr, '');
    assert.equal(execution.stdout.includes(sentinel), false);
    const rows = execution.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 13);
    assert.deepEqual(
      rows.slice(0, 5).map((row) => row.addressCount),
      [3, 2, 1, 2, 4]
    );
    for (const row of rows.slice(0, 5)) {
      assert.equal(row.result.created, true);
      assert.equal(row.result.verified, true);
      assert.equal(row.result.cleaned, true);
      assert.equal(row.removes, 1);
      assert.equal(row.result.category, null);
    }
    for (const row of rows.slice(5, 9)) {
      assert.equal(typeof row.result.category === 'number' || row.mode === 'cleanup', true);
      assert.equal(row.result.cleaned, row.mode !== 'cleanup');
    }
    assert.equal(rows[6].removes, 1);
    assert.equal(rows[7].result.stage, 'verify');
    assert.equal(rows[8].result.stage, 'cleanup');
    assert.equal(rows[9].result.stage, 'collision');
    assert.equal(rows[9].removes, 0);
    assert.equal(rows[10].result.stage, 'collision');
    assert.equal(rows[10].calls, 0);
    assert.equal(rows[10].result.cleaned, false);
    assert.equal(rows[11].result.stage, 'cleanup');
    assert.equal(rows[11].result.cleaned, false);
    assert.deepEqual(rows[12], { calls: 0, rejected: true });
  }
);
