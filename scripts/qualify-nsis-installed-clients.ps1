[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CurrentDirectory,
    [Parameter(Mandatory)][string]$CurrentRuntimeManifest,
    [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{40}\z')][string]$CurrentSha,
    [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$PreparationReceiptSha256
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/nsis-client-orchestration.psm1') -Force
$result = Invoke-HpmNsisInstalledClients @PSBoundParameters
Write-Output ('NSIS_INSTALLED_CLIENTS=' + ($result | ConvertTo-Json -Depth 8 -Compress))
