param([string]$Helper, [string]$Materials, [string]$FixtureRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. $Materials
. $Helper
function Initialize-HpmN08ArtifactLease {}
class HpmN08ArtifactLease {
    [string]$Path
    static [int]$Disposed
    HpmN08ArtifactLease([string]$path, [bool]$directory) { $this.Path = $path }
    [void]Verify([string]$path) { if ($path -cne $this.Path -or -not [IO.File]::Exists($path)) { throw 'private' } }
    [void]Dispose() { [HpmN08ArtifactLease]::Disposed++ }
}
class HpmHostedEgressLease {
    static [int]$Created
    static [int]$Disposed
    static [int]$FailAt
    static [bool]$FailDispose
    static [HpmHostedEgressLease]ForInstalledClient([string]$program) {
        [HpmHostedEgressLease]::Created++
        if ([HpmHostedEgressLease]::Created -eq [HpmHostedEgressLease]::FailAt) { throw 'private' }
        return [HpmHostedEgressLease]::new()
    }
    [void]Dispose() {
        [HpmHostedEgressLease]::Disposed++
        if ([HpmHostedEgressLease]::FailDispose) { throw 'private' }
    }
}
function Get-NetFirewallRule {
    param($Name, $ErrorAction)
    if ($global:mode -eq 'collision' -and $global:rules.Count -eq 1) { return @{ Enabled = 'False' } }
    if ($global:rules.ContainsKey($Name)) { return $global:rules[$Name] }
}
function New-NetFirewallRule {
    param($Name, $DisplayName, $Direction, $Action, $Enabled, $Profile, $Program, $RemoteAddress)
    if ($global:mode -eq 'create' -and $global:rules.Count -eq 1) { throw 'private' }
    if (($RemoteAddress -join ',') -cne '0.0.0.0-127.0.0.0,127.0.0.2-255.255.255.255,::/1,8000::/1') { throw 'fixture_invalid' }
    $global:rules[$Name] = [pscustomobject]@{ Enabled = 'True'; Action = 'Block'; Direction = 'Outbound'; Program = $Program }
}
function Get-NetFirewallApplicationFilter {
    param([Parameter(ValueFromPipeline)]$Rule)
    process { if ($global:mode -eq 'identity') { return @{ Program = 'wrong' } }; return @{ Program = $Rule.Program } }
}
function Remove-NetFirewallRule {
    param($Name, $ErrorAction)
    if ($global:mode -eq 'remove') { throw 'private' }
    $global:rules.Remove($Name)
}
$env:RUNNER_TEMP = $FixtureRoot
$owned = Join-Path $FixtureRoot 'hpm-installed-clients'
[IO.Directory]::CreateDirectory((Join-Path $owned 'payload/runtime/node')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $owned 'clients')) | Out-Null
foreach ($relative in @('payload/runtime/node/node.exe', 'clients/codex.exe', 'clients/claude.exe')) {
    [IO.File]::WriteAllText((Join-Path $owned $relative), 'synthetic binary')
}
$output = @()
foreach ($global:mode in @('success', 'nodehash', 'root', 'missing', 'collision', 'create', 'identity', 'wfp', 'changed', 'stop', 'dispose', 'remove')) {
    $global:rules = @{}
    [HpmHostedEgressLease]::Created = 0; [HpmHostedEgressLease]::Disposed = 0
    [HpmHostedEgressLease]::FailAt = $(if ($global:mode -eq 'wfp') { 2 } else { -1 })
    [HpmHostedEgressLease]::FailDispose = $global:mode -eq 'dispose'
    [HpmN08ArtifactLease]::Disposed = 0
    $state = @{ programs = @() }
    $failed = $false; $cleanupFailed = $false
    $root = $(if ($global:mode -eq 'root') { $FixtureRoot } else { $owned })
    $claude = Join-Path $owned 'clients/claude.exe'
    if ($global:mode -eq 'missing') { [IO.File]::Delete($claude) }
    try {
        $nodeHash = (Get-FileHash -LiteralPath (Join-Path $owned 'payload/runtime/node/node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($global:mode -eq 'nodehash') { $nodeHash = '0' * 64 }
        Initialize-HpmInstalledClientContainment $root ('a' * 32) $state $nodeHash
        if ($global:mode -eq 'changed') { [IO.File]::WriteAllText($claude, 'changed binary'); Assert-HpmInstalledClientContainment $state }
    } catch { $failed = $true }
    try { Remove-HpmInstalledClientContainment $state ($global:mode -ne 'stop') } catch { $cleanupFailed = $true }
    $output += @{ mode = $global:mode; failed = $failed; cleanupFailed = $cleanupFailed; leases = $state.programs.Count; rulesRetained = $global:rules.Count; wfpCreated = [HpmHostedEgressLease]::Created; wfpDisposed = [HpmHostedEgressLease]::Disposed; filesDisposed = [HpmN08ArtifactLease]::Disposed }
    [IO.File]::WriteAllText($claude, 'synthetic binary')
}
$output | ConvertTo-Json -Compress
