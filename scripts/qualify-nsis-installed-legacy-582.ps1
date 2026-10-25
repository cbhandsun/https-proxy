[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CurrentDirectory,
    [Parameter(Mandatory)][string]$CurrentRuntimeManifest,
    [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{40}\z')][string]$CurrentSha
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/nsis-installed-legacy-582.psm1') -Force
try {
    $receipt = Invoke-HpmInstalledLegacy582 @PSBoundParameters
    Write-Output ('NSIS_INSTALLED_LEGACY_582=' + ($receipt | ConvertTo-Json -Depth 8 -Compress))
} catch { throw 'installed_legacy_582_rejected' }
