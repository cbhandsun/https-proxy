[CmdletBinding()]
param(
    [string]$InstallDir = '',

    [string]$FallbackInstallDir = '',

    [ValidateRange(5, 60)]
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

function Resolve-NormalizedPath {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    try {
        $fullPath = [System.IO.Path]::GetFullPath($Value)
        $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
        # Keep a filesystem root as C:\, never C:. On Windows, C: is relative
        # to that drive's current directory. NSIS sets its working directory to
        # $INSTDIR, so trimming the slash can make a normal install directory
        # compare equal to the filesystem root.
        if (
            $pathRoot -and
            [string]::Equals(
                $fullPath,
                $pathRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            return $pathRoot
        }
        $trimCharacters = [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
        return $fullPath.TrimEnd($trimCharacters)
    } catch {
        return ''
    }
}

function Test-PathEquals {
    param([string]$Left, [string]$Right)
    $leftPath = Resolve-NormalizedPath $Left
    $rightPath = Resolve-NormalizedPath $Right
    return $leftPath -and $rightPath -and [string]::Equals(
        $leftPath,
        $rightPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

$requestedInstallDir = $InstallDir
if ([string]::IsNullOrWhiteSpace($requestedInstallDir)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is unavailable and InstallDir was not supplied'
    }
    $requestedInstallDir = Join-Path $env:LOCALAPPDATA 'HTTPS Proxy Manager'
}

$resolvedInstallDir = Resolve-NormalizedPath $requestedInstallDir
if (-not $resolvedInstallDir) { throw 'InstallDir must be a valid absolute path' }
$installRoot = Resolve-NormalizedPath ([System.IO.Path]::GetPathRoot($resolvedInstallDir))
if (Test-PathEquals $resolvedInstallDir $installRoot) {
    $resolvedFallbackInstallDir = Resolve-NormalizedPath $FallbackInstallDir
    $fallbackRoot = if ($resolvedFallbackInstallDir) {
        Resolve-NormalizedPath ([System.IO.Path]::GetPathRoot($resolvedFallbackInstallDir))
    } else {
        ''
    }
    if (
        -not $resolvedFallbackInstallDir -or
        (Test-PathEquals $resolvedFallbackInstallDir $fallbackRoot)
    ) {
        throw "InstallDir must not be a filesystem root. Received=[$requestedInstallDir]."
    }
    Write-Output "Installer supplied filesystem root [$resolvedInstallDir]; using validated fallback [$resolvedFallbackInstallDir]."
    $resolvedInstallDir = $resolvedFallbackInstallDir
}
Write-Output "Process cleanup install directory: [$resolvedInstallDir]."
if (-not (Test-Path -LiteralPath $resolvedInstallDir -PathType Container)) {
    Write-Output 'Installed application directory is absent; no process cleanup is required.'
    exit 0
}

$expectedExecutablePaths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
)
@(
    (Join-Path $resolvedInstallDir 'app.exe'),
    (Join-Path $resolvedInstallDir 'HTTPS Proxy Manager.exe'),
    (Join-Path $resolvedInstallDir 'https-proxy-manager.exe'),
    (Join-Path $resolvedInstallDir 'runtime\node\node.exe')
) | ForEach-Object {
    $normalized = Resolve-NormalizedPath $_
    if ($normalized) { [void]$expectedExecutablePaths.Add($normalized) }
}

function Test-OwnedExecutablePath {
    param([string]$ExecutablePath)
    $normalized = Resolve-NormalizedPath $ExecutablePath
    return $normalized -and $expectedExecutablePaths.Contains($normalized)
}

function Get-ProcessExecutablePath {
    param($Process)
    if (-not $Process) { return '' }
    try {
        $candidate = [string]$Process.Path
        if ($candidate) { return $candidate }
    } catch {}
    try {
        return [string]$Process.MainModule.FileName
    } catch {
        return ''
    }
}

function Get-OwnedProcesses {
    $ownedByPid = @{}
    $candidateNames = @('app', 'HTTPS Proxy Manager', 'https-proxy-manager', 'node')

    foreach ($process in @(Get-Process -Name $candidateNames -ErrorAction SilentlyContinue)) {
        $executablePath = Get-ProcessExecutablePath $process
        if (Test-OwnedExecutablePath $executablePath) {
            $ownedByPid[[int]$process.Id] = [pscustomobject]@{
                ProcessId = [int]$process.Id
                Name = [string]$process.ProcessName
                ExecutablePath = Resolve-NormalizedPath $executablePath
                Process = $process
            }
        }
    }

    # Process.Path can be unavailable for a process that is exiting or when a
    # 32-bit installer inspects a 64-bit process. A narrow CIM query is a safe
    # fallback and never makes cleanup depend on enumerating unrelated processes.
    try {
        $filter = "Name='app.exe' OR Name='HTTPS Proxy Manager.exe' OR Name='https-proxy-manager.exe' OR Name='node.exe'"
        foreach ($process in @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)) {
            $executablePath = [string]$process.ExecutablePath
            if (Test-OwnedExecutablePath $executablePath) {
                $pidValue = [int]$process.ProcessId
                if (-not $ownedByPid.ContainsKey($pidValue)) {
                    $ownedByPid[$pidValue] = [pscustomobject]@{
                        ProcessId = $pidValue
                        Name = [string]$process.Name
                        ExecutablePath = Resolve-NormalizedPath $executablePath
                        Process = $null
                    }
                }
            }
        }
    } catch {
        Write-Output "CIM process lookup unavailable; using process-path lookup: $($_.Exception.Message)"
    }

    return @($ownedByPid.Values | Sort-Object ProcessId)
}

function Get-OwnedProcessById {
    param([int]$ProcessId)
    return @(Get-OwnedProcesses | Where-Object { $_.ProcessId -eq $ProcessId } | Select-Object -First 1)
}

function Request-GracefulExit {
    param($OwnedProcess)
    if (-not $OwnedProcess -or $OwnedProcess.Name -eq 'node') { return $false }
    try {
        $process = if ($OwnedProcess.Process) {
            $OwnedProcess.Process
        } else {
            Get-Process -Id $OwnedProcess.ProcessId -ErrorAction Stop
        }
        if ($process.MainWindowHandle -ne 0 -and $process.CloseMainWindow()) {
            Write-Output "Requested graceful exit for PID $($OwnedProcess.ProcessId)."
            return $true
        }
    } catch {
        # Exiting between discovery and notification is a successful race.
    }
    return $false
}

function Stop-OwnedProcessTree {
    param($OwnedProcess)
    if (-not $OwnedProcess) { return }
    $stillOwned = @(Get-OwnedProcessById $OwnedProcess.ProcessId)
    if ($stillOwned.Count -eq 0) { return }

    $taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    try {
        $taskkillOutput = & $taskkillPath /PID $OwnedProcess.ProcessId /T /F 2>&1
        $taskkillExitCode = $LASTEXITCODE
        if ($taskkillOutput) {
            Write-Output (($taskkillOutput | ForEach-Object { [string]$_ }) -join ' ')
        }
        if ($taskkillExitCode -eq 0) { return }
    } catch {
        Write-Output "taskkill failed for PID $($OwnedProcess.ProcessId): $($_.Exception.Message)"
    }

    # taskkill may report a benign race after the target already exited. Only
    # fall back to Stop-Process when the same owned executable still has the PID.
    if (@(Get-OwnedProcessById $OwnedProcess.ProcessId).Count -eq 0) { return }
    try {
        Stop-Process -Id $OwnedProcess.ProcessId -Force -ErrorAction Stop
        Write-Output "Force-stopped installed process PID $($OwnedProcess.ProcessId)."
    } catch {
        if (@(Get-OwnedProcessById $OwnedProcess.ProcessId).Count -gt 0) {
            Write-Output "Stop-Process failed for PID $($OwnedProcess.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Get-LockedInstalledExecutables {
    $locked = @()
    foreach ($candidate in $expectedExecutablePaths) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $stream = $null
        try {
            $stream = [System.IO.File]::Open(
                $candidate,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        } catch {
            $locked += $candidate
        } finally {
            if ($stream) { $stream.Dispose() }
        }
    }
    return @($locked)
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$gracefulExitAttempted = [System.Collections.Generic.HashSet[int]]::new()

do {
    $ownedProcesses = @(Get-OwnedProcesses)
    $lockedExecutables = @(Get-LockedInstalledExecutables)
    if ($ownedProcesses.Count -eq 0 -and $lockedExecutables.Count -eq 0) {
        Write-Output 'Installed HTTPS Proxy Manager processes stopped and executable locks released.'
        exit 0
    }

    $requestedGracefulExit = $false
    foreach ($ownedProcess in $ownedProcesses) {
        if ($gracefulExitAttempted.Add([int]$ownedProcess.ProcessId)) {
            if (Request-GracefulExit $ownedProcess) { $requestedGracefulExit = $true }
        }
    }
    if ($requestedGracefulExit) { Start-Sleep -Milliseconds 750 }

    foreach ($ownedProcess in @(Get-OwnedProcesses)) {
        Stop-OwnedProcessTree $ownedProcess
    }
    Start-Sleep -Milliseconds 150
} while ((Get-Date) -lt $deadline)

$remainingProcesses = @(Get-OwnedProcesses)
$remainingLocks = @(Get-LockedInstalledExecutables)
$processDetails = ($remainingProcesses | ForEach-Object {
    "PID=$($_.ProcessId) path=$($_.ExecutablePath)"
}) -join '; '
$lockDetails = $remainingLocks -join '; '
throw "Cleanup timed out after $TimeoutSeconds seconds. Remaining processes: [$processDetails]. Locked executables: [$lockDetails]."
