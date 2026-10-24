$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-installed-settings-receipt.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-encrypted-lifecycle.psm1') -Force
$sha = 'a' * 64
$valid = @('00', '01', '10', '11') | ForEach-Object {
    [pscustomobject]@{ schemaVersion = 1; combination = $_; manifestSha256 = $sha; scope = 'verified_payload_module_api'; dependencyIdentity = 'lock_only'; checks = @('policy_applied', 'storage_boundary', 'shutdown_acknowledged'); restartRetention = $false }
}

# A clean module reproduces the runner import scope before a synthetic callback.
# The real matrix command must resolve before its local test double is defined.
$moduleDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/lib'))
$composition = New-Module -ArgumentList $moduleDirectory -ScriptBlock {
    param($directory)
    Import-Module (Join-Path $directory 'nsis-settings-matrix.psm1') -Force
    Import-Module (Join-Path $directory 'nsis-installed-settings-receipt.psm1') -Force
    if ($null -eq (Get-Command Invoke-HpmPayloadSettingsMatrix -ErrorAction Stop)) { throw 'Matrix command missing in caller module scope.' }
    function Invoke-CompositionProbe {
        param($results, $sha)
        $script:matrixCalls = 0
        function Invoke-HpmPayloadSettingsMatrix {
            param($OwnedRoot, $InstallDirectory, $ManifestSha256)
            $script:matrixCalls++
            if ($OwnedRoot -cne 'synthetic-owned' -or $InstallDirectory -cne 'synthetic-install' -or $ManifestSha256 -cne $sha) { throw 'Synthetic composition arguments failed.' }
            return $results
        }
        $matrix = @(Invoke-HpmPayloadSettingsMatrix 'synthetic-owned' 'synthetic-install' $sha)
        $aggregate = ConvertTo-HpmInstalledSettingsMatrixReceipt $matrix $sha
        if ($script:matrixCalls -ne 1 -or $aggregate.combinations.Count -ne 4) { throw 'Module composition failed.' }
    }
    Export-ModuleMember -Function Invoke-CompositionProbe
}
try { & $composition { param($results, $sha) Invoke-CompositionProbe $results $sha } $valid $sha } finally { Remove-Module $composition -Force }
# Force imports in the isolated module can unload caller exports. Restore the
# fixture scope before the independent aggregate and sequence assertions.
Import-Module (Join-Path $moduleDirectory 'nsis-installed-settings-receipt.psm1') -Force
Import-Module (Join-Path $moduleDirectory 'nsis-encrypted-lifecycle.psm1') -Force

$receipt = ConvertTo-HpmInstalledSettingsMatrixReceipt $valid $sha
if ($receipt.phase -cne 'current_pre_rollback' -or $receipt.scope -cne 'installed_module_api' -or $receipt.restartRetention -or ($receipt.combinations.combination -join ',') -cne '00,01,10,11') { throw 'Normal receipt failed.' }
$refused = 0
function Refuse([scriptblock]$Work) {
    $failed = $false
    try { & $Work | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Expected refusal.' }
    $script:refused++
}
Refuse { ConvertTo-HpmInstalledSettingsMatrixReceipt @() $sha }
Refuse { ConvertTo-HpmInstalledSettingsMatrixReceipt @($valid[0], $valid[1], $valid[2]) $sha }
Refuse { ConvertTo-HpmInstalledSettingsMatrixReceipt @($valid[0], $valid[1], $valid[2], $valid[2]) $sha }
Refuse { ConvertTo-HpmInstalledSettingsMatrixReceipt @($valid[3], $valid[2], $valid[1], $valid[0]) $sha }
Refuse { ConvertTo-HpmInstalledSettingsMatrixReceipt $valid ('b' * 64) }
foreach ($field in @('schemaVersion', 'combination', 'manifestSha256', 'scope', 'dependencyIdentity', 'checks', 'restartRetention')) {
    $copy = $valid | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $copy[3].$field = 'PRIVATE_UNTRUSTED_CONTENT'
    Refuse { ConvertTo-HpmInstalledSettingsMatrixReceipt $copy $sha }
}
$events = [Collections.Generic.List[string]]::new()
$operations = @{
    Install = { param($phase) $events.Add('install:' + $phase) }
    Stop = { $events.Add('stop') }
    Inspect = { param($phase) if ($phase -eq 'baseline') { 'a' * 64 } else { 'b' * 64 } }
    Seed = { param($role) $events.Add('seed:' + $role) }
    Read = { param($phase, $role, $operation) $events.Add('read:' + $phase + ':' + $role + ':' + $operation) }
    RefuseLegacy = { $events.Add('refuse-legacy') }
    RefuseNewFormat = { $events.Add('refuse-new-format') }
    EnrollLegacy = { $events.Add('enroll-legacy') }
    CheckFixtures = { $events.Add('fixtures') }
    RuntimeBoundaries = { $events.Add('matrix'); ConvertTo-HpmInstalledSettingsMatrixReceipt @() $sha | Out-Null }
    Uninstall = { $events.Add('uninstall') }
    CheckRemoved = { $events.Add('removed') }
}
Refuse { Invoke-HpmEncryptedLifecycleSequence $operations }
if (@($events | Where-Object { $_ -eq 'install:baseline' }).Count -ne 1 -or $events.Contains('uninstall') -or -not $events.Contains('matrix')) { throw 'Matrix failure did not stop the lifecycle sequence.' }
$expected = 'install:baseline,stop,seed:legacy,install:current,stop,refuse-legacy,seed:anchored,read:current:anchored:read,read:current:anchored:resave,fixtures,matrix'
if (($events -join ',') -cne $expected) { throw 'Settings matrix lifecycle order failed.' }
Write-Output ('installedSettingsReceiptRefusals=' + $refused + '; installerExecutions=0; helperExecutions=0; networkRequests=0')
