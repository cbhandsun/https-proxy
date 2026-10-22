Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-settings-matrix.psm1')

function ConvertTo-HpmInstalledSettingsMatrixReceipt {
    param([object[]]$Results, [string]$ManifestSha256)
    try {
        if ($ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $Results.Count -ne 4) { throw 'invalid' }
        $expected = @('00', '01', '10', '11')
        $normalized = @()
        for ($index = 0; $index -lt 4; $index++) {
            # Reuses strict primitive/field/check/duplicate validation, rather
            # than accepting a generic passed flag or a loose PS object.
            $json = $Results[$index] | ConvertTo-Json -Depth 8 -Compress
            $normalized += ConvertFrom-HpmSettingsMatrixResult $json $expected[$index] $ManifestSha256
        }
        return [pscustomobject]@{
            schemaVersion = 1
            caseId = 'settings-matrix'
            phase = 'current_pre_rollback'
            manifestSha256 = $ManifestSha256
            scope = 'installed_module_api'
            dependencyIdentity = 'lock_only'
            restartRetention = $false
            combinations = $normalized
        }
    } catch { throw 'Installed settings matrix receipt rejected.' }
}
Export-ModuleMember -Function ConvertTo-HpmInstalledSettingsMatrixReceipt
