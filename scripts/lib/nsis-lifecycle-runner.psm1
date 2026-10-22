function Invoke-HpmNsisQualification {
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BaselineDirectory,
    [Parameter(Mandatory = $true)][string]$CurrentDirectory,
    [Parameter(Mandatory = $true)][string]$BaselineSha,
    [Parameter(Mandatory = $true)][string]$CurrentSha
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -Force
Assert-HpmLifecycleCommitPair $BaselineSha $CurrentSha
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HTTPS Proxy Manager'
$machineRegistryPaths = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HTTPS Proxy Manager',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\HTTPS Proxy Manager'
)
$existing = (Test-Path -LiteralPath $registryPath) -or @($machineRegistryPaths | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
$existingProcess = @(Get-Process -Name 'https-proxy-manager', 'app' -ErrorAction SilentlyContinue).Count -gt 0
Assert-HpmLifecycleIsolation @{
    GITHUB_ACTIONS = $env:GITHUB_ACTIONS
    RUNNER_ENVIRONMENT = $env:RUNNER_ENVIRONMENT
    RUNNER_OS = $env:RUNNER_OS
} $existing $existingProcess
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'Runner temp directory is required.'
}
foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA 'HTTPS Proxy Manager'),
    (Join-Path $env:LOCALAPPDATA 'com.efficiency.https-proxy-manager'),
    (Join-Path $env:APPDATA 'com.efficiency.https-proxy-manager')
)) {
    if (Test-Path -LiteralPath $candidate) { throw 'Existing application data prevents clean lifecycle qualification.' }
}
$installers = @{}
foreach ($entry in @(@('baseline', $BaselineDirectory), @('current', $CurrentDirectory))) {
    Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $entry[1] 'Container'
    $files = @(Get-ChildItem -LiteralPath $entry[1] -File | Where-Object { $_.Name -match '-setup\.exe$' })
    if ($files.Count -ne 1) { throw 'Each lifecycle build must provide exactly one NSIS setup executable.' }
    Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $files[0].FullName 'Leaf'
    $installers[$entry[0]] = $files[0].FullName
}
if ((Get-FileHash -LiteralPath $installers.baseline).Hash -eq (Get-FileHash -LiteralPath $installers.current).Hash) {
    throw 'Baseline and current setup artifacts must differ.'
}
$root = Join-Path $env:RUNNER_TEMP ('hpm-lifecycle-' + [Guid]::NewGuid().ToString('N'))
Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $root
$installDir = Join-Path $root 'HTTPS Proxy Manager'
$executable = Join-Path $installDir 'https-proxy-manager.exe'
$uninstaller = Join-Path $installDir 'uninstall.exe'
$fixturePaths = @('proxy.config.json', '.hpm-runtime\lifecycle-synthetic.json')
$fixtureHashes = @{}

function Invoke-LifecycleProcess {
    param([string]$FilePath, [string[]]$Arguments)
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(180000)) {
        $process.Kill($true)
        throw 'Lifecycle installer process timed out.'
    }
    if ($process.ExitCode -ne 0) { throw "Lifecycle installer failed with exit code $($process.ExitCode)." }
}

function Invoke-LifecycleUninstall {
    # NSIS _?= must be last and unquoted: run in place instead of spawning a temporary copy.
    # This keeps WaitForExit attached to the actual uninstaller; disposable cleanup removes its remaining file.
    Invoke-LifecycleProcess $uninstaller @('/S', "_?=$installDir")
}

function Stop-LifecycleProcesses {
    param([ValidateRange(10, 45)][int]$ObservationSeconds = 30)
    Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $root
    $prefix = [IO.Path]::GetFullPath($installDir).TrimEnd('\') + '\'
    $started = [DateTime]::UtcNow
    do {
        $processes = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
        })
        foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $started.AddSeconds($ObservationSeconds))
    $remaining = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($remaining.Count -ne 0) { throw 'Lifecycle application processes did not stop.' }
}

function Assert-LifecycleRegistration {
    param([string]$Phase)
    $registration = Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop
    $registered = [IO.Path]::GetFullPath(([string]$registration.InstallLocation).Trim().Trim('"')).TrimEnd('\')
    if ($registered -ine [IO.Path]::GetFullPath($installDir).TrimEnd('\')) { throw 'Lifecycle registration points outside the install directory.' }
    $version = if ($Phase -eq 'baseline') { '0.0.1' } else { '0.0.2' }
    if ($registration.DisplayVersion -cne $version) { throw 'Installed lifecycle version does not match the build phase.' }
    foreach ($relative in @('https-proxy-manager.exe', 'openai-proxy.js', 'lib\proxy\cert.js', 'runtime\node\node.exe', 'release-runtime-manifest.json', 'uninstall.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installDir $relative) -PathType Leaf)) { throw 'Installed lifecycle payload is incomplete.' }
    }
    $hash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
    Write-Information -MessageData "Lifecycle phase=$Phase version=$version installedAppSha256=$hash" -InformationAction Continue
    return $hash
}

function Assert-LifecycleFixtures {
    foreach ($relative in $fixturePaths) {
        $fixture = Join-Path $installDir $relative
        if (-not (Test-Path -LiteralPath $fixture -PathType Leaf) -or (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -cne $fixtureHashes[$relative]) {
            throw 'Synthetic lifecycle configuration/data or its fixed expiry was changed or removed.'
        }
    }
}

$failure = $null
$cleanupFailure = $null
try {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    # No provider configuration or credentials. Disable automatic proxy startup even if an installer launches the UI.
    $offlineFixture = Join-Path $PSScriptRoot '../fixtures/nsis-lifecycle-offline-config.json'
    Copy-Item -LiteralPath $offlineFixture -Destination (Join-Path $installDir 'proxy.config.json')
    $fixtureHashes[$fixturePaths[0]] = (Get-FileHash -LiteralPath $offlineFixture -Algorithm SHA256).Hash
    Invoke-HpmLifecycleSequence @{
        Install = { param($phase) Invoke-LifecycleProcess $installers[$phase] @('/S', "/D=$installDir") }
        Stop = { Stop-LifecycleProcesses }
        Inspect = { param($phase) Assert-LifecycleRegistration $phase }
        Seed = {
            if ((Get-FileHash -LiteralPath (Join-Path $installDir 'proxy.config.json') -Algorithm SHA256).Hash -cne $fixtureHashes[$fixturePaths[0]]) {
                throw 'Baseline install changed the offline synthetic configuration.'
            }
            New-Item -ItemType Directory -Path (Join-Path $installDir '.hpm-runtime') -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $installDir $fixturePaths[1]), '{"synthetic":true,"createdAt":"2026-01-01T00:00:00Z","expiresAt":"2026-01-02T00:00:00Z","marker":"lifecycle-only"}')
            foreach ($relative in $fixturePaths) { $fixtureHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $installDir $relative) -Algorithm SHA256).Hash }
        }
        CheckFixtures = { Assert-LifecycleFixtures }
        Uninstall = { Invoke-LifecycleUninstall }
        CheckRemoved = {
            if (Test-Path -LiteralPath $registryPath) { throw 'Uninstall registration remains after uninstall.' }
            if (Test-Path -LiteralPath $executable) { throw 'Application binary remains after uninstall.' }
        }
    }
} catch {
    $failure = $_
} finally {
    try {
        Stop-LifecycleProcesses -ObservationSeconds 10
        if (Test-Path -LiteralPath $registryPath) {
            # Never execute or remove another installation after an unexpected registration change.
            $registered = Get-ItemProperty -LiteralPath $registryPath
            $registeredPath = [IO.Path]::GetFullPath(([string]$registered.InstallLocation).Trim().Trim('"')).TrimEnd('\')
            if ($registeredPath -ine [IO.Path]::GetFullPath($installDir).TrimEnd('\')) { throw 'Cleanup refused unexpected installation registration.' }
            if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Cleanup requires the disposable installation uninstaller.' }
            Invoke-LifecycleUninstall
            Stop-LifecycleProcesses -ObservationSeconds 10
            if (Test-Path -LiteralPath $registryPath) { throw 'Cleanup uninstall registration remains.' }
        }
        Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $root
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    } catch { $cleanupFailure = $_ }
}
if ($failure -or $cleanupFailure) {
    if ($failure) { Write-Error -Message ('Lifecycle qualification failed: ' + $failure.Exception.Message) -ErrorAction Continue }
    if ($cleanupFailure) { Write-Error -Message ('Lifecycle cleanup failed: ' + $cleanupFailure.Exception.Message) -ErrorAction Continue }
    throw 'NSIS lifecycle qualification failed; see bounded diagnostics above.'
}
Write-Output 'NSIS install/upgrade/rollback/uninstall and synthetic file preservation passed. Encrypted recovery and 24-hour capacity were not qualified.'

}
Export-ModuleMember -Function Invoke-HpmNsisQualification
