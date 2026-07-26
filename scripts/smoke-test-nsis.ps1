[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerDirectory
)

$ErrorActionPreference = 'Stop'
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

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Invoke-HiddenProcess $installer.FullName @('/S', "/D=$installDir")

    foreach ($relativePath in @(
        'HTTPS Proxy Manager.exe',
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
    Write-Output "NSIS install/uninstall smoke test passed: $($installer.Name)"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
