'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Execute only the actual bounded JSON consumer, never its OS/Job constructor.
test('all nine Job receipt consumers reject crossed groups and malformed scope without native calls', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../scripts/context-hosted/n09/owned-job.ps1'),
    'utf8'
  );
  const begin = source.indexOf('        $document = [Text.Json.JsonDocument]::Parse($output)');
  const end = source.indexOf('        } finally { $document.Dispose() }', begin);
  assert.ok(begin > 0 && end > begin);
  const body = source.slice(begin, end) + '        } finally { $document.Dispose() }';
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
    $ErrorActionPreference = 'Stop'
    function Read-Receipt([string]$output, [string]$PublicationGroup) {
      $treeEmpty = $true
      ${body}
    }
    $core = [ordered]@{ schemaVersion = 1; phase = 'n09_owned_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 10; n09Complete = $false }
    $sending = [ordered]@{ schemaVersion = 1; phase = 'n09_sending_ack_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 2; n09Complete = $false }
    $finished = [ordered]@{ schemaVersion = 1; phase = 'n09_finished_ack_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 2; n09Complete = $false }
    $withdrawn = [ordered]@{ schemaVersion = 1; phase = 'n09_withdrawn_ack_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 2; n09Complete = $false }
    $uncertain = [ordered]@{ schemaVersion = 1; phase = 'n09_uncertain_ack_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 2; n09Complete = $false }
    $sendingCommit = [ordered]@{ schemaVersion = 1; phase = 'n09_sending_commit_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 2; n09Complete = $false }
    $finishedCommit = [ordered]@{ schemaVersion = 1; phase = 'n09_finished_commit_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 2; n09Complete = $false }
    $withdrawnCommit = [ordered]@{ schemaVersion = 1; phase = 'n09_withdrawn_commit_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 2; n09Complete = $false }
    $uncertainCommit = [ordered]@{ schemaVersion = 1; phase = 'n09_uncertain_commit_scenario_closed'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; listenerOwned = $true; syntheticSocketsClosed = $true; cases = 2; n09Complete = $false }
    $pairs = @(@($core, 'original'), @($sending, 'sending-ack'), @($finished, 'finished-ack'), @($withdrawn, 'withdrawn-ack'), @($uncertain, 'uncertain-ack'), @($sendingCommit, 'sending-commit'), @($finishedCommit, 'finished-commit'), @($withdrawnCommit, 'withdrawn-commit'), @($uncertainCommit, 'uncertain-commit'))
    $rejected = 0
    foreach ($pair in $pairs) {
      $value = Read-Receipt ($pair[0] | ConvertTo-Json -Compress) $pair[1]
      if ($value.ownedTreeEmpty -ne $true -or $value.n09Complete -ne $false) { throw 'consumer_scope_lost' }
      foreach ($other in $pairs) {
        if ($pair[1] -ceq $other[1]) { continue }
        $failed = $false
        try { $null = Read-Receipt ($pair[0] | ConvertTo-Json -Compress) $other[1] } catch { $failed = $true }
        if (-not $failed) { throw 'crossed_group_accepted' }
        $rejected++
      }
    }
    foreach ($group in @('', 'unknown', 'UNCERTAIN-ACK')) {
      $failed = $false
      try { $null = Read-Receipt ($uncertain | ConvertTo-Json -Compress) $group } catch { $failed = $true }
      if (-not $failed) { throw 'invalid_group_accepted' }
      $rejected++
    }
    $wire = $sending | ConvertTo-Json -Compress
    foreach ($bad in @('{}', 'null', ($wire + '{}'), $wire.Replace('"cases":2', '"cases":10'), $wire.Replace('"n09Complete":false', '"n09Complete":true'), $wire.Replace('"tlsVerified":true', '"tlsVerified":false'), $wire.Replace('"cases":2', '"cases":"2"'), $wire.Replace('"cases":2', '"cases":2,"PRIVATE_SENTINEL":true'))) {
      $failed = $false
      try { $null = Read-Receipt $bad 'sending-ack' } catch { $failed = $true }
      if (-not $failed) { throw 'invalid_scope_accepted' }
      $rejected++
    }
    [Console]::Write('accepted=9; rejected=' + $rejected + '; nativeCalls=0')
  `,
    ],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 4096, shell: false, windowsHide: true }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'accepted=9; rejected=83; nativeCalls=0');
});
