Set-StrictMode -Version Latest

function Assert-HpmInstalledPayloadHost {
    if (-not $IsWindows -or $env:CI -cne 'true') { throw 'installed_payload_rejected' }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'installed_payload_rejected' }
}
function Get-HpmInstalledPayloadCommit {
    param([string]$Directory)
    $value = & git -C $Directory rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'installed_payload_rejected' }
    return $value
}
function Invoke-HpmInstalledPayloadProcess {
    param([string]$Program, [string[]]$Arguments)
    $process = Start-Process -FilePath $Program -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    try {
        if (-not $process.WaitForExit(180000)) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null; throw 'installed_payload_rejected' }
        if ($process.ExitCode -ne 0) { throw 'installed_payload_rejected' }
    } finally { $process.Dispose() }
}
function New-HpmInstalledPayloadLease {
    param([string]$Directory)
    Initialize-HpmN08ArtifactLease
    return [HpmN08ArtifactLease]::new($Directory, $true)
}
function Assert-HpmInstalledPayloadSources {
    param([string]$Payload, [string]$Manifest)
    $document = $null
    try {
        $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($Manifest))
        if ($document.RootElement.GetProperty('schemaVersion').GetInt32() -ne 2) { throw 'installed_payload_rejected' }
        $sources = @($document.RootElement.GetProperty('sourceSha256').EnumerateObject())
        if ($sources.Count -lt 1 -or $sources.Count -gt 4096) { throw 'installed_payload_rejected' }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $sources) {
            if ($entry.Name.Length -gt 512 -or -not $seen.Add($entry.Name) -or $entry.Value.GetString() -cnotmatch '\A[a-f0-9]{64}\z') { throw 'installed_payload_rejected' }
            $file = Join-Path $Payload $entry.Name
            Assert-HpmLifecycleArtifactPath $Payload $file 'Leaf'
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value.GetString()) { throw 'installed_payload_rejected' }
        }
        foreach ($pair in @(@('package-lock.json', 'packageLockSha256'), @('runtime/native/hpm-context-recovery-key.exe', 'contextRecoveryNativeSha256'), @(('runtime/evidence-gateway/gateway-' + $document.RootElement.GetProperty('evidenceGatewayBundleSha256').GetString() + '.cjs'), 'evidenceGatewayBundleSha256'))) {
            $file = Join-Path $Payload $pair[0]
            Assert-HpmLifecycleArtifactPath $Payload $file 'Leaf'
            $expected = $document.RootElement.GetProperty($pair[1]).GetString()
            if ($expected -cnotmatch '\A[a-f0-9]{64}\z' -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'installed_payload_rejected' }
        }
    } finally { if ($null -ne $document) { $document.Dispose() } }
}
function Get-HpmInstalledPayloadNode {
    param([string]$Root, [string]$Payload, [string]$ManifestSha256)
    $boundary = Get-Module nsis-runtime-boundary
    return & $boundary { param($r, $p, $h) Get-HpmRuntimeBoundaryNode $r $p $h } $Root $Payload $ManifestSha256
}
function Assert-HpmInstalledPayloadRegistration {
    param([string]$Registry, [string]$Payload, [bool]$CheckVersion = $true)
    $registration = Get-ItemProperty -LiteralPath $Registry -ErrorAction Stop
    $registered = [IO.Path]::GetFullPath(([string]$registration.InstallLocation).Trim().Trim('"')).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($registered -cne $Payload -or ($CheckVersion -and $registration.DisplayVersion -cne '0.1.1')) { throw 'installed_payload_rejected' }
}

function Invoke-HpmInstalledClientPayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$CurrentDirectory,
        [Parameter(Mandatory)][string]$CurrentRuntimeManifest,
        [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{40}\z')][string]$CurrentSha,
        [Parameter(Mandatory)][scriptblock]$RunOwnedScenario,
        [Parameter(Mandatory)][scriptblock]$StopOwnedScenario
    )
    $ErrorActionPreference = 'Stop'
    Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'nsis-runtime-boundary.psm1') -Force
    . (Join-Path $PSScriptRoot '../context-hosted/shared/hosted-materials.ps1')
    $registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HTTPS Proxy Manager'
    $machineRegistries = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HTTPS Proxy Manager', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\HTTPS Proxy Manager')
    $created = $false; $failed = $false; $cleanupFailed = $false; $leases = @(); $root = $null; $payload = $null; $uninstallerHash = $null
    try {
        Assert-HpmInstalledPayloadHost
        $existing = (Test-Path -LiteralPath $registry) -or @($machineRegistries | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
        $process = @(Get-Process -Name 'https-proxy-manager', 'app' -ErrorAction SilentlyContinue).Count -gt 0
        Assert-HpmLifecycleIsolation @{ GITHUB_ACTIONS = $env:GITHUB_ACTIONS; RUNNER_ENVIRONMENT = $env:RUNNER_ENVIRONMENT; RUNNER_OS = $env:RUNNER_OS } $existing $process
        foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'HTTPS Proxy Manager'), (Join-Path $env:LOCALAPPDATA 'com.efficiency.https-proxy-manager'), (Join-Path $env:APPDATA 'com.efficiency.https-proxy-manager'))) {
            if (Test-Path -LiteralPath $candidate) { throw 'installed_payload_rejected' }
        }
        Assert-HpmN08MaterialPath $env:RUNNER_TEMP $true
        Assert-HpmN08MaterialPath $env:GITHUB_WORKSPACE $true
        $root = Join-Path $env:RUNNER_TEMP 'hpm-installed-clients'
        Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $root
        if (Test-Path -LiteralPath $root) { throw 'installed_payload_rejected' }
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $CurrentDirectory 'Container'
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $CurrentRuntimeManifest 'Leaf'
        if ((Get-Item -LiteralPath $CurrentRuntimeManifest).Length -gt 4194304 -or
            (Get-HpmInstalledPayloadCommit $CurrentDirectory) -cne $CurrentSha -or
            (Get-HpmInstalledPayloadCommit ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($CurrentRuntimeManifest)))) -cne $CurrentSha) { throw 'installed_payload_rejected' }
        $setups = @(Get-ChildItem -LiteralPath $CurrentDirectory -File | Where-Object { $_.Name -match '-setup\.exe$' })
        if ($setups.Count -ne 1) { throw 'installed_payload_rejected' }
        $setup = $setups[0].FullName
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $setup 'Leaf'
        $setupHash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash
        $manifestHash = (Get-FileHash -LiteralPath $CurrentRuntimeManifest -Algorithm SHA256).Hash.ToLowerInvariant()
        New-Item -ItemType Directory -Path $root | Out-Null
        $created = $true
        $leases += New-HpmInstalledPayloadLease $root
        $payload = Join-Path $root 'payload'
        New-Item -ItemType Directory -Path $payload | Out-Null
        $leases += New-HpmInstalledPayloadLease $payload
        $offline = Join-Path $PSScriptRoot '../fixtures/nsis-lifecycle-offline-config.json'
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $offline 'Leaf'
        Copy-Item -LiteralPath $offline -Destination (Join-Path $payload 'proxy.config.json')
        $offlineHash = (Get-FileHash -LiteralPath $offline -Algorithm SHA256).Hash
        Invoke-HpmInstalledPayloadProcess $setup @('/S', "/D=$payload")
        $knownUninstaller = Join-Path $payload 'uninstall.exe'
        Assert-HpmLifecycleArtifactPath $root $knownUninstaller 'Leaf'
        $uninstallerHash = (Get-FileHash -LiteralPath $knownUninstaller -Algorithm SHA256).Hash
        Assert-HpmInstalledPayloadRegistration $registry $payload
        foreach ($relative in @('https-proxy-manager.exe', 'uninstall.exe', 'openai-proxy.js', 'lib/proxy/cert.js')) { Assert-HpmLifecycleArtifactPath $root (Join-Path $payload $relative) 'Leaf' }
        $node = Get-HpmInstalledPayloadNode $root $payload $manifestHash
        Assert-HpmInstalledPayloadSources $payload (Join-Path $payload 'release-runtime-manifest.json')
        if ((Get-FileHash -LiteralPath (Join-Path $payload 'proxy.config.json') -Algorithm SHA256).Hash -cne $offlineHash) { throw 'installed_payload_rejected' }
        if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -cne $setupHash -or (Get-FileHash -LiteralPath $CurrentRuntimeManifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifestHash) { throw 'installed_payload_rejected' }
        $leases[0].Verify($root); $leases[1].Verify($payload)
        $result = & $RunOwnedScenario ([pscustomobject]@{ ownedRoot = $root; payload = $payload; node = $node; currentSha = $CurrentSha; manifestSha256 = $manifestHash; nodeSha256 = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant(); setupSha256 = $setupHash.ToLowerInvariant() })
        if ($null -eq $result -or $result.passed -isnot [bool] -or $result.passed -cne $true) { throw 'installed_payload_rejected' }
        $leases[0].Verify($root); $leases[1].Verify($payload)
    } catch { $failed = $true }
    finally {
        if ($created) {
            try {
                $stopped = & $StopOwnedScenario
                if ($null -eq $stopped -or $stopped.treeEmpty -isnot [bool] -or $stopped.treeEmpty -cne $true) { throw 'installed_payload_cleanup_failed' }
                $leases[0].Verify($root)
                Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $root
                if (@($machineRegistries | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0) { throw 'installed_payload_cleanup_failed' }
                if (Test-Path -LiteralPath $registry) { Assert-HpmInstalledPayloadRegistration $registry $payload $false }
                if ($leases.Count -gt 1) { $leases[1].Verify($payload); $leases[1].Dispose() }
                $uninstaller = Join-Path $payload 'uninstall.exe'
                if (Test-Path -LiteralPath $uninstaller) {
                    Assert-HpmLifecycleArtifactPath $root $uninstaller 'Leaf'
                    if ($null -eq $uninstallerHash -or (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash -cne $uninstallerHash) { throw 'installed_payload_cleanup_failed' }
                    Invoke-HpmInstalledPayloadProcess $uninstaller @('/S', "_?=$payload")
                }
                if ((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath (Join-Path $payload 'https-proxy-manager.exe'))) { throw 'installed_payload_cleanup_failed' }
                $leases[0].Verify($root)
                $leases[0].Dispose()
                Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $root
                Remove-Item -LiteralPath $root -Recurse -Force
            } catch { $cleanupFailed = $true }
        }
        foreach ($lease in $leases) { try { $lease.Dispose() } catch { $cleanupFailed = $true } }
    }
    if ($cleanupFailed) { throw 'installed_payload_cleanup_failed' }
    if ($failed) { throw 'installed_payload_rejected' }
    return @{ phase = 'installed_payload_finished'; installedClientQualified = $false; ownedTreeEmpty = $true; uninstalled = $true; sourceSha = $CurrentSha }
}
Export-ModuleMember -Function Invoke-HpmInstalledClientPayload
