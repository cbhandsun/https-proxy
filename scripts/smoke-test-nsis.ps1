[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tauriConfigPath = Join-Path $repoRoot 'src-tauri\tauri.conf.json'
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$mainBinaryName = [string]$tauriConfig.mainBinaryName
if ([string]::IsNullOrWhiteSpace($mainBinaryName)) {
    throw "Tauri mainBinaryName must be configured: $tauriConfigPath"
}
$mainExecutable = "$mainBinaryName.exe"
$uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HTTPS Proxy Manager'
if (Test-Path -LiteralPath $uninstallRegistryPath) {
    $existingInstall = Get-ItemProperty -LiteralPath $uninstallRegistryPath -ErrorAction Stop
    throw "NSIS smoke test requires a clean disposable Windows environment. Existing installation: $($existingInstall.InstallLocation)"
}

$installerRoot = [System.IO.Path]::GetFullPath($InstallerDirectory)
$installer = Get-ChildItem -LiteralPath $installerRoot -File |
    Where-Object { $_.Name -match '-setup\.exe$' } |
    Select-Object -First 1
if (-not $installer) { throw "NSIS setup executable not found under $installerRoot" }

$tempRoot = [System.IO.Path]::GetFullPath(
    (Join-Path ([System.IO.Path]::GetTempPath()) "hpm-nsis-smoke-$PID")
)
$installDir = Join-Path $tempRoot 'HTTPS Proxy Manager'
$tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $tempRoot.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Smoke-test directory must stay under the system temp directory: $tempRoot"
}

function Invoke-HiddenProcess {
    param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 120)
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill($true) } catch {}
        throw "Process timed out after $TimeoutSeconds seconds: $FilePath"
    }
    if ($process.ExitCode -ne 0) {
        throw "Process failed with exit code $($process.ExitCode): $FilePath"
    }
}

function Get-ProcessesUnderDirectory {
    param([string]$Directory)

    $processRoot = [System.IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
    return @(
        Get-CimInstance Win32_Process |
            Where-Object {
                if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) { return $false }
                try {
                    return [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
                        $processRoot,
                        [System.StringComparison]::OrdinalIgnoreCase
                    )
                } catch {
                    return $false
                }
            }
    )
}

function Stop-ProcessesUnderDirectory {
    param(
        [string]$Directory,
        [ValidateRange(0, 60)]
        [int]$MinimumObservationSeconds = 0,
        [ValidateRange(5, 90)]
        [int]$TimeoutSeconds = 45
    )

    $startedAt = [DateTime]::UtcNow
    $minimumObservationEndsAt = $startedAt.AddSeconds($MinimumObservationSeconds)
    $deadline = $startedAt.AddSeconds($TimeoutSeconds)
    do {
        $processes = @(Get-ProcessesUnderDirectory $Directory)
        foreach ($process in $processes) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        }
        $remaining = @(Get-ProcessesUnderDirectory $Directory)
        if ($remaining.Count -eq 0 -and [DateTime]::UtcNow -ge $minimumObservationEndsAt) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    $remaining = @(Get-ProcessesUnderDirectory $Directory)
    $details = ($remaining | ForEach-Object {
        "PID=$($_.ProcessId) path=$($_.ExecutablePath)"
    }) -join '; '
    throw "Smoke-test process cleanup timed out under $Directory. Remaining: [$details]"
}

function Wait-ForUninstallRegistration {
    param(
        [bool]$ShouldExist,
        [string]$ExpectedInstallDirectory,
        [ValidateRange(5, 60)]
        [int]$TimeoutSeconds = 30
    )

    $expected = [System.IO.Path]::GetFullPath($ExpectedInstallDirectory).TrimEnd('\')
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $exists = Test-Path -LiteralPath $uninstallRegistryPath
        if (-not $ShouldExist -and -not $exists) { return }
        if ($ShouldExist -and $exists) {
            $registration = Get-ItemProperty -LiteralPath $uninstallRegistryPath -ErrorAction Stop
            $registered = [string]$registration.InstallLocation
            $registered = $registered.Trim().Trim('"')
            if (
                $registered -and
                [string]::Equals(
                    [System.IO.Path]::GetFullPath($registered).TrimEnd('\'),
                    $expected,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            ) {
                return
            }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    if ($ShouldExist) {
        throw "NSIS installation registration did not settle at $ExpectedInstallDirectory"
    }
    throw "NSIS uninstall registration was not removed: $uninstallRegistryPath"
}

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Invoke-HiddenProcess $installer.FullName @('/S', "/D=$installDir")
    Stop-ProcessesUnderDirectory $installDir -MinimumObservationSeconds 30 -TimeoutSeconds 45
    Wait-ForUninstallRegistration $true $installDir

    foreach ($relativePath in @(
        $mainExecutable,
        'openai-proxy.js',
        'lib\proxy\cert.js',
        'runtime\node\node.exe',
        'release-runtime-manifest.json'
    )) {
        $candidate = Join-Path $installDir $relativePath
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Installed release is missing required file: $relativePath"
        }
    }

    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw "Installed release is missing uninstaller: $uninstaller"
    }
    Invoke-HiddenProcess $uninstaller @('/S') 120
    Stop-ProcessesUnderDirectory $installDir -MinimumObservationSeconds 10 -TimeoutSeconds 30
    Wait-ForUninstallRegistration $false $installDir
    Write-Output "NSIS install/uninstall smoke test passed: $($installer.Name)"
} finally {
    Stop-ProcessesUnderDirectory $installDir -TimeoutSeconds 10
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
