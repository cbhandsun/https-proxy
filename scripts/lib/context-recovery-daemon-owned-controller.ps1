param([Parameter(Mandatory)][string]$OwnedRoot, [Parameter(Mandatory)][string]$InstallDirectory, [Parameter(Mandatory)][string]$ManifestSha256)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    Import-Module (Join-Path $PSScriptRoot 'context-recovery-daemon-owned-controller.psm1') -Force
    Invoke-HpmDaemonOwnedController $OwnedRoot $InstallDirectory $ManifestSha256
} catch {
    # No exception text, product output, paths or request data cross this channel.
    [Console]::Error.WriteLine('daemon_controller_failed')
    exit 1
}
