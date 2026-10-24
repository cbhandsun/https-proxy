'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('PowerShell accepts backup and held-response cases and keeps malformed diagnostics closed', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
    $ErrorActionPreference = 'Stop'
    $module = Import-Module ./scripts/lib/nsis-runtime-boundary.psm1 -PassThru
    & $module {
      foreach ($casePhase in @(85, 86)) {
        foreach ($phase in @(85, 86, 254) + @(140..157)) {
          $bytes = [Text.Encoding]::UTF8.GetBytes("n09_owned_entry_rejected\`nn09_primary_phase=$phase\`nn09_case_phase=$casePhase\`n")
          if ((ConvertFrom-HpmOwnedFailurePhase $bytes) -ne $phase -or
              (ConvertFrom-HpmOwnedCasePhase $bytes) -ne $casePhase) { throw 'Finite backup or held-response phase rejected.' }
        }
      }
      foreach ($phase in @(139, 158, 159, 160, 161, 255)) {
        $bytes = [Text.Encoding]::UTF8.GetBytes("n09_owned_entry_rejected\`nn09_primary_phase=$phase\`nn09_case_phase=83\`n")
        if ($null -ne (ConvertFrom-HpmOwnedFailurePhase $bytes) -or
            $null -ne (ConvertFrom-HpmOwnedCasePhase $bytes)) { throw 'Unassigned ACK phase accepted.' }
      }
      foreach ($suffix in @("n09_case_phase=84\`n", "n09_case_phase=87\`n",
          "n09_case_phase=85\`nPRIVATE_SENTINEL", "n09_case_phase=85\`nn09_case_phase=82\`n")) {
        $bytes = [Text.Encoding]::UTF8.GetBytes("n09_owned_entry_rejected\`nn09_primary_phase=254\`n$suffix")
        if ($null -ne (ConvertFrom-HpmOwnedFailurePhase $bytes) -or
            $null -ne (ConvertFrom-HpmOwnedCasePhase $bytes)) { throw 'Invalid finite backup phase accepted.' }
      }
    }
    [Console]::Out.Write('backup_phase_checked')
  `,
    ],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 4096, shell: false, windowsHide: true }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), 'backup_phase_checked');
});
