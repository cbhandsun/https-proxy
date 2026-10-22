function Invoke-HpmNsisQualification {
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
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -Force
if ($EncryptedRecovery) {
    if ($BaselineSha -or $CurrentSha -cnotmatch '\A[a-f0-9]{40}\z') { throw 'Encrypted lifecycle requires an artifact baseline and full current commit.' }
    Import-Module (Join-Path $PSScriptRoot 'nsis-encrypted-lifecycle.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'nsis-runtime-boundary.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'nsis-settings-matrix.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'nsis-installed-settings-receipt.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'nsis-installed-daemon-http.psm1') -Force
    Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $CurrentRuntimeManifest 'Leaf'
} else { Assert-HpmLifecycleCommitPair $BaselineSha $CurrentSha }
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
if ($EncryptedRecovery -and (Get-FileHash -LiteralPath $installers.baseline -Algorithm SHA256).Hash -ine 'e7dc2ec976df82c2679eb45b336312253caec2f7cf8e7629cc4940e147b85ce6') { throw 'Encrypted baseline installer identity mismatch.' }
$manifestHashes = @{}
if ($EncryptedRecovery) {
    $manifestHashes.baseline = '32157042cb8988a035f29c9f94261f0b18ad055670214d3daf33095a70b1f62d'
    $manifestHashes.current = (Get-FileHash -LiteralPath $CurrentRuntimeManifest -Algorithm SHA256).Hash.ToLowerInvariant()
}
$root = Join-Path $env:RUNNER_TEMP ('hpm-lifecycle-' + [Guid]::NewGuid().ToString('N'))
Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $root
$installDir = Join-Path $root 'HTTPS Proxy Manager'
$executable = Join-Path $installDir 'https-proxy-manager.exe'
$uninstaller = Join-Path $installDir 'uninstall.exe'
$fixturePaths = @('proxy.config.json', '.hpm-runtime\lifecycle-synthetic.json')
$fixtureHashes = @{}
$encryptedState = @{}
$encryptedStore = Join-Path $root 'synthetic-encrypted-store'

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
    $version = if ($EncryptedRecovery) { if ($Phase -eq 'baseline') { '0.1.0' } else { '0.1.1' } } else { if ($Phase -eq 'baseline') { '0.0.1' } else { '0.0.2' } }
    if ($registration.DisplayVersion -cne $version) { throw 'Installed lifecycle version does not match the build phase.' }
    foreach ($relative in @('https-proxy-manager.exe', 'openai-proxy.js', 'lib\proxy\cert.js', 'runtime\node\node.exe', 'release-runtime-manifest.json', 'uninstall.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installDir $relative) -PathType Leaf)) { throw 'Installed lifecycle payload is incomplete.' }
    }
    if ($EncryptedRecovery -and (Get-FileHash -LiteralPath (Join-Path $installDir 'release-runtime-manifest.json') -Algorithm SHA256).Hash -ine $manifestHashes[$Phase]) { throw 'Installed encrypted runtime manifest mismatch.' }
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
    $operations = @{
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
    if ($EncryptedRecovery) {
        $plainSeed = $operations.Seed
        $operations.Seed = {
            & $plainSeed
            Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $encryptedStore
            New-Item -ItemType Directory -Path $encryptedStore -ErrorAction Stop | Out-Null
            $encryptedState.baseline = Invoke-HpmInstalledRecoveryFixture $installDir $encryptedStore $manifestHashes.baseline 'seed'
        }
        $operations.Read = {
            param($phase, $operation)
            Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $encryptedStore
            $next = Invoke-HpmInstalledRecoveryFixture $installDir $encryptedStore $manifestHashes[$phase] $operation
            Compare-HpmEncryptedReceipt $encryptedState.baseline $next
        }
        $operations.RuntimeBoundaries = {
            foreach ($caseId in @('defaults-migration', 'initialization-failure', 'reopen-clear')) {
                Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $root
                $result = Invoke-HpmInstalledRuntimeBoundary $root $installDir $manifestHashes.current $caseId
                Write-Information -MessageData ('Runtime boundary scope=installed_module_api case=' + $result.caseId + ' complete=' + $result.complete + ' dependencyIdentity=lock_only; HTTP/GUI and full migration unqualified.') -InformationAction Continue
            }
            # Current package is still installed and its manifest has been
            # inspected. The matrix uses four fresh sibling config/data roots.
            $matrix = @(Invoke-HpmPayloadSettingsMatrix $root $installDir $manifestHashes.current)
            $encryptedState.settingsMatrix = ConvertTo-HpmInstalledSettingsMatrixReceipt $matrix $manifestHashes.current
            $encryptedState.httpMatrix = Invoke-HpmInstalledDaemonHttpMatrix $root $installDir $manifestHashes.current
        }
        Invoke-HpmEncryptedLifecycleSequence $operations
    } else { Invoke-HpmLifecycleSequence $operations }
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
if ($EncryptedRecovery) {
    if (-not $encryptedState.ContainsKey('settingsMatrix')) { throw 'Installed settings matrix receipt missing.' }
    $installedMatrix = ConvertTo-HpmInstalledSettingsMatrixReceipt $encryptedState.settingsMatrix.combinations $manifestHashes.current
    if (-not $encryptedState.ContainsKey('httpMatrix')) { throw 'installed_daemon_http_receipt_missing' }
    $httpReceipt = ConvertFrom-HpmInstalledDaemonHttpReceipt ($encryptedState.httpMatrix | ConvertTo-Json -Depth 8 -Compress) $manifestHashes.current
    Write-Output ('NSIS_RUNTIME_BOUNDARIES=' + ($installedMatrix | ConvertTo-Json -Depth 10 -Compress))
    Write-Output ('NSIS_DAEMON_HTTP=' + ($httpReceipt | ConvertTo-Json -Depth 8 -Compress))
    Write-Output 'Hosted synthetic same-user DPAPI and same-format installed-reader upgrade/rollback/reopen passed. Old-layout migration, capacity, providers and production remain unqualified.'
} else { Write-Output 'NSIS install/upgrade/rollback/uninstall and synthetic file preservation passed. Encrypted recovery and 24-hour capacity were not qualified.' }

}
Export-ModuleMember -Function Invoke-HpmNsisQualification
