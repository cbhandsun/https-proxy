param(
    [switch]$SkipBuild,
    [switch]$NoZip,
    [string]$OutputRoot = "dist\staging\portable",
    [string]$CargoTargetDir = $env:CARGO_TARGET_DIR
)

$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$DistRoot = [System.IO.Path]::GetFullPath((Join-Path $Root 'dist'))
$StagingRoot = [System.IO.Path]::GetFullPath((Join-Path $DistRoot 'staging'))
$ArtifactPortableRoot = [System.IO.Path]::GetFullPath((Join-Path $DistRoot 'artifacts\portable'))
$ResolvedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $Root $OutputRoot))
$PortableName = 'HTTPS Proxy Manager Portable'
$PortableDir = Join-Path $ResolvedOutputRoot $PortableName
$ReleaseRuntimeDir = Join-Path $DistRoot 'staging\runtime'

function Assert-PathInside {
    param(
        [string]$Parent,
        [string]$Candidate,
        [string]$Label
    )
    $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    if (-not $candidatePath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must stay inside $Parent`: $candidatePath"
    }
    return $candidatePath
}

function Copy-RequiredFile {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Missing file: $Source" }
    $destinationParent = Split-Path -Parent $Destination
    if ($destinationParent) { New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Remove-PortableMetadataDirectories {
    $nodeModulesDir = Join-Path $PortableDir 'node_modules'
    if (-not (Test-Path -LiteralPath $nodeModulesDir -PathType Container)) { return }
    $metadataDirectories = @(
        Get-ChildItem -LiteralPath $nodeModulesDir -Recurse -Force -Directory |
            Where-Object { $_.Name -in @('.claude', '.github') }
    )
    foreach ($directory in $metadataDirectories) {
        if (-not (Test-Path -LiteralPath $directory.FullName -PathType Container)) { continue }
        $safeDirectory = Assert-PathInside $PortableDir $directory.FullName 'Portable dependency metadata cleanup target'
        Remove-Item -LiteralPath $safeDirectory -Recurse -Force
    }
}

$ResolvedOutputRoot = Assert-PathInside $StagingRoot $ResolvedOutputRoot 'Portable staging output root'
$PortableDir = Assert-PathInside $ResolvedOutputRoot $PortableDir 'Portable directory'
$ArtifactPortableRoot = Assert-PathInside $DistRoot $ArtifactPortableRoot 'Portable artifact root'

Push-Location $Root
try {
    if (-not $SkipBuild) {
        npm run tauri:build
        if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
    } else {
        npm run release:prepare
        if ($LASTEXITCODE -ne 0) { throw "Release runtime preparation failed with exit code $LASTEXITCODE" }
    }
} finally {
    Pop-Location
}

$ResolvedCargoTarget = if ([string]::IsNullOrWhiteSpace($CargoTargetDir)) {
    Join-Path $Root 'src-tauri\target'
} elseif ([System.IO.Path]::IsPathRooted($CargoTargetDir)) {
    [System.IO.Path]::GetFullPath($CargoTargetDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $Root $CargoTargetDir))
}
$ReleaseDir = Join-Path $ResolvedCargoTarget 'release'
$PreferredExe = Join-Path $ReleaseDir 'https-proxy-manager.exe'
$FallbackExe = Join-Path $ReleaseDir 'app.exe'
$Exe = if (Test-Path -LiteralPath $PreferredExe -PathType Leaf) { $PreferredExe } else { $FallbackExe }

if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
    throw "Release executable not found under $ReleaseDir. Build first or pass -CargoTargetDir."
}
if (-not (Test-Path -LiteralPath $ReleaseRuntimeDir -PathType Container)) {
    throw "Release runtime not found: $ReleaseRuntimeDir"
}

# Release output is always rebuilt from a clean directory. Local config, logs,
# tokens, and certificates are deliberately never carried forward.
if (Test-Path -LiteralPath $PortableDir) {
    $safePortableDir = Assert-PathInside $ResolvedOutputRoot $PortableDir 'Portable cleanup target'
    Remove-Item -LiteralPath $safePortableDir -Recurse -Force
}
New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null

# Use the exact staged closure, including gateway scripts and its lockfile.
# The helper verifies all recorded source/binary hashes before and after copying.
node (Join-Path $Root 'lib\release\portable-runtime.js') $ReleaseRuntimeDir $PortableDir
if ($LASTEXITCODE -ne 0) { throw 'Portable runtime integrity or copy failed' }
Copy-RequiredFile $Exe (Join-Path $PortableDir 'https-proxy-manager.exe')
Remove-PortableMetadataDirectories

$readme = @(
    'HTTPS Proxy Manager Portable',
    '',
    'Usage:',
    '1. Double-click https-proxy-manager.exe to start the manager and local proxy.',
    '2. Config, logs, and certificates are created locally in this portable folder.',
    '3. Optional CLI maintenance: proxy.bat start|stop|restart|status|logs.',
    '',
    'Security:',
    '- This release is stateless and contains no proxy.config.json, API keys, tokens, logs, or certificates.',
    '- First start creates proxy.config.json from proxy.config.example.json.',
    '- Do not redistribute the folder after adding credentials or generating certificates.',
    '',
    'Runtime:',
    '- Node.js and all production npm dependencies are bundled.',
    '- OpenSSL is not required for local certificate generation.'
) -join [Environment]::NewLine
Set-Content -Path (Join-Path $PortableDir 'README.txt') -Value $readme -Encoding UTF8

Push-Location $Root
try {
    node scripts/validate-release-package.js --dir $PortableDir
    if ($LASTEXITCODE -ne 0) { throw "Portable release validation failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$ZipPath = Assert-PathInside $ArtifactPortableRoot (Join-Path $ArtifactPortableRoot 'HTTPS-Proxy-Manager-Portable.zip') 'Portable zip path'
$PortableManifestJson = Assert-PathInside $ArtifactPortableRoot (Join-Path $ArtifactPortableRoot 'SHA256SUMS.json') 'Portable manifest path'
$PortableManifestText = Assert-PathInside $ArtifactPortableRoot (Join-Path $ArtifactPortableRoot 'SHA256SUMS.txt') 'Portable manifest path'
New-Item -ItemType Directory -Path $ArtifactPortableRoot -Force | Out-Null
foreach ($StaleArtifact in @($ZipPath, $PortableManifestJson, $PortableManifestText)) {
    if (Test-Path -LiteralPath $StaleArtifact) { Remove-Item -LiteralPath $StaleArtifact -Force }
}

if (-not $NoZip) {
    Compress-Archive -Path $PortableDir -DestinationPath $ZipPath -Force
    Push-Location $Root
    try {
        node scripts/write-portable-artifact-manifest.js
        if ($LASTEXITCODE -ne 0) { throw "Portable manifest generation failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    Write-Host "Portable package generated: $PortableDir"
    Write-Host "Zip generated: $ZipPath"
} else {
    Write-Host "Portable package generated: $PortableDir"
}
