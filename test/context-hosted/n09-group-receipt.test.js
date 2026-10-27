'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Execute only the actual bounded JSON consumer, never its OS/Job constructor.
test('original and sending Job receipt consumers reject crossed groups and malformed scope without native calls', () => {
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
    foreach ($pair in @(@($core, 'original'), @($sending, 'sending-ack'))) {
      $value = Read-Receipt ($pair[0] | ConvertTo-Json -Compress) $pair[1]
      if ($value.ownedTreeEmpty -ne $true -or $value.n09Complete -ne $false) { throw 'consumer_scope_lost' }
    }
    $rejected = 0
    foreach ($pair in @(@($core, 'sending-ack'), @($sending, 'original'))) {
      $failed = $false
      try { $null = Read-Receipt ($pair[0] | ConvertTo-Json -Compress) $pair[1] } catch { $failed = $true }
      if (-not $failed) { throw 'crossed_group_accepted' }
      $rejected++
    }
    $wire = $sending | ConvertTo-Json -Compress
    foreach ($bad in @('{}', 'null', ($wire + '{}'), $wire.Replace('"cases":2', '"cases":10'), $wire.Replace('"n09Complete":false', '"n09Complete":true'), $wire.Replace('"tlsVerified":true', '"tlsVerified":false'), $wire.Replace('"cases":2', '"cases":"2"'), $wire.Replace('"cases":2', '"cases":2,"PRIVATE_SENTINEL":true'))) {
      $failed = $false
      try { $null = Read-Receipt $bad 'sending-ack' } catch { $failed = $true }
      if (-not $failed) { throw 'invalid_scope_accepted' }
      $rejected++
    }
    [Console]::Write('accepted=2; rejected=' + $rejected + '; nativeCalls=0')
  `,
    ],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 4096, shell: false, windowsHide: true }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'accepted=2; rejected=10; nativeCalls=0');
});
