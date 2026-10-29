[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CurrentDirectory,
    [Parameter(Mandatory)][string]$CurrentRuntimeManifest,
    [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{40}\z')][string]$CurrentSha
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/nsis-installed-publication.psm1') -Force
$result=Invoke-HpmInstalledPublication @PSBoundParameters
Write-Output ('NSIS_INSTALLED_PUBLICATION=' + ($result | ConvertTo-Json -Depth 5 -Compress))
