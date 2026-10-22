$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-settings-matrix.psm1') -Force
$owned = $env:HPM_MATRIX_TEST_ROOT
$sha = $env:HPM_MATRIX_TEST_SHA
$install = Join-Path $owned 'installed'
$refusals = 0
function Refuse([scriptblock]$Work) {
    $failed = $false
    try { & $Work | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Expected safe refusal.' }
    $script:refusals++
}
$valid = '{"schemaVersion":1,"combination":"00","manifestSha256":"' + $sha + '","scope":"verified_payload_module_api","dependencyIdentity":"lock_only","checks":["policy_applied","storage_boundary","shutdown_acknowledged"],"restartRetention":false}'
ConvertFrom-HpmSettingsMatrixResult $valid '00' $sha | Out-Null
foreach ($bad in @('', 'null', '{}', ('x' * 4097), $valid.Replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), $valid.Replace('"00"', '"11"'), $valid.Replace('false', 'true'), $valid.Replace('shutdown_acknowledged', 'PRIVATE_UNTRUSTED'), $valid.Replace('"lock_only"', '"complete"'))) {
    Refuse { ConvertFrom-HpmSettingsMatrixResult $bad '00' $sha }
}
Refuse { Invoke-HpmPayloadSettingsMatrix $owned $install ('0' * 64) }
if (@(Get-ChildItem -LiteralPath $owned -Directory | Where-Object Name -like 'settings-*').Count -ne 0) { throw 'Preflight created cases.' }
$helper = Join-Path $install 'runtime/native/hpm-context-recovery-key.exe'
$bytes = [IO.File]::ReadAllBytes($helper)
try {
    [IO.File]::WriteAllText($helper, 'mutated-never-executed-helper')
    Refuse { Invoke-HpmPayloadSettingsMatrix $owned $install $sha }
    if (@(Get-ChildItem -LiteralPath $owned -Directory | Where-Object Name -like 'settings-*').Count -ne 0) { throw 'Helper preflight created cases.' }
} finally { [IO.File]::WriteAllBytes($helper, $bytes) }
$results = @(Invoke-HpmPayloadSettingsMatrix $owned $install $sha)
if ($results.Count -ne 4 -or ($results.combination -join ',') -cne '00,01,10,11') { throw 'Matrix failed.' }
Write-Output ('syntheticCombinations=4; schemaAndIdentityRefusals=' + $refusals + '; nativeExecutions=0; networkRequests=0')
