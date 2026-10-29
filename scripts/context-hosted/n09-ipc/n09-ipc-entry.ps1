param(
    # Trusted launcher arguments, fixed once before any IPC is read. IPC callers
    # cannot select these values, executable, config, token, port or launch args.
    [Parameter(Mandatory)][string]$OwnedRoot,
    [Parameter(Mandatory)][string]$InstallDirectory,
    [Parameter(Mandatory)][string]$ManifestSha256,
    [Parameter(Mandatory)][int]$ParentPid
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    # Dedicated one-use bootstrap environment, not normal JSONL/CLI. Remove it
    # before module loading or daemon launch; only the private captured value lives.
    $token = [Environment]::GetEnvironmentVariable('HPM_N09_BOOTSTRAP_TOKEN', 'Process')
    [Environment]::SetEnvironmentVariable('HPM_N09_BOOTSTRAP_TOKEN', $null, 'Process')
    if ($token -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
    Import-Module (Join-Path $PSScriptRoot 'same-directory-ipc.psm1') -ErrorAction Stop
    $trusted = @{ OwnedRoot = $OwnedRoot; InstallDirectory = $InstallDirectory; ManifestSha256 = $ManifestSha256 }
    Invoke-HpmN09IpcController -TrustedLaunch $trusted -ParentPid $ParentPid -SyntheticToken $token
} catch {
    # No exception text, native output, headers, paths, tokens or user data.
    [Console]::Error.WriteLine('n09_ipc_failed')
    exit 1
} finally { $token = $null }
