[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BaselineDirectory,
    [Parameter(Mandatory = $true)][string]$CurrentDirectory,
    [string]$BaselineSha,
    [Parameter(Mandatory = $true)][string]$CurrentSha,
    [switch]$EncryptedRecovery,
    [string]$CurrentRuntimeManifest
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/nsis-lifecycle-runner.psm1') -Force
Invoke-HpmNsisQualification @PSBoundParameters
