param(
    [switch]$SkipBuild,
    [switch]$NoZip,
    [string]$OutputRoot = "dist\portable"
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $Root 'src-tauri\target\release'
$PreferredExe = Join-Path $ReleaseDir 'https-proxy-manager.exe'
$FallbackExe = Join-Path $ReleaseDir 'app.exe'
$Exe = if (Test-Path $PreferredExe) { $PreferredExe } elseif (Test-Path $FallbackExe) { $FallbackExe } else { $PreferredExe }
$PortableName = 'HTTPS Proxy Manager Portable'
$PortableDir = Join-Path $Root (Join-Path $OutputRoot $PortableName)
$RuntimeDir = Join-Path $PortableDir 'runtime'
$StateBackupDir = Join-Path ([System.IO.Path]::GetTempPath()) ("hpm-portable-state-" + [guid]::NewGuid().ToString('N'))

function Copy-RequiredFile {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path $Source)) { throw "Missing file: $Source" }
    Copy-Item $Source $Destination -Force
}

function Copy-CommandBinary {
    param([string]$CommandName, [string]$DestinationDir)
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if (-not $command -or -not $command.Source -or -not (Test-Path $command.Source)) { return $false }
    New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
    Copy-Item $command.Source (Join-Path $DestinationDir (Split-Path -Leaf $command.Source)) -Force
    return $true
}

function Copy-NodeRuntimeModule {
    param([string]$ModuleName)
    $source = Join-Path $Root "node_modules\$ModuleName"
    if (-not (Test-Path $source)) { throw "Missing runtime module: $ModuleName. Run npm install first." }
    $destination = Join-Path $PortableDir "node_modules\$ModuleName"
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item (Join-Path $source 'lib') (Join-Path $destination 'lib') -Recurse -Force
    Copy-Item (Join-Path $source 'package.json') (Join-Path $destination 'package.json') -Force
    Copy-Item (Join-Path $source 'LICENSE') (Join-Path $destination 'LICENSE') -Force
}

function Write-RuntimePackageJson {
    $sourcePackage = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
    $runtimePackage = [ordered]@{
        name = $sourcePackage.name
        version = $sourcePackage.version
        private = $true
        dependencies = [ordered]@{
            'node-forge' = $sourcePackage.dependencies.'node-forge'
        }
    }
    $runtimePackage | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $PortableDir 'package.json') -Encoding UTF8
}

function Assert-PortableFileMatches {
    param([string]$RelativePath)
    $source = Join-Path $Root $RelativePath
    $destination = Join-Path $PortableDir $RelativePath
    if (-not (Test-Path $source)) { throw "Missing source file for portable verification: $source" }
    if (-not (Test-Path $destination)) { throw "Missing portable file after copy: $destination" }
    $sourceHash = (Get-FileHash $source -Algorithm SHA256).Hash
    $destinationHash = (Get-FileHash $destination -Algorithm SHA256).Hash
    if ($sourceHash -ne $destinationHash) {
        throw "Portable backend mismatch: $RelativePath"
    }
}

function Test-ExampleProxyConfig {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $false }
    try {
        $json = Get-Content $Path -Raw | ConvertFrom-Json
        if ($json.activeProfile -and ([string]$json.activeProfile).StartsWith('example-', [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
        if ($json.profiles) {
            foreach ($profile in @($json.profiles)) {
                if ($profile.id -eq 'example-openai' -or ([string]$profile.targetUrl) -like '*api.example.com*') {
                    return $true
                }
            }
        }
    } catch {}
    return $false
}

function Get-JsonConfig {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        return Get-Content $Path -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Test-ConfigHasEntryAuth {
    param([object]$Config)
    if (-not $Config -or -not $Config.entryAuth) { return $false }
    if ($Config.entryAuth.enabled -ne $true) { return $false }
    return @($Config.entryAuth.keys).Count -gt 0
}

function Copy-EntryAuthFromRootConfig {
    param([string]$TargetConfig)
    $RootConfigPath = Join-Path $Root 'proxy.config.json'
    $RootConfig = Get-JsonConfig $RootConfigPath
    if (-not (Test-ConfigHasEntryAuth $RootConfig)) { return $false }

    $Target = Get-JsonConfig $TargetConfig
    if (-not $Target) {
        Copy-Item $RootConfigPath $TargetConfig -Force
        return $true
    }
    if (Test-ConfigHasEntryAuth $Target) { return $false }

    $Target | Add-Member -NotePropertyName 'entryAuth' -NotePropertyValue $RootConfig.entryAuth -Force
    $Target | ConvertTo-Json -Depth 20 | Set-Content -Path $TargetConfig -Encoding UTF8
    return $true
}

function Copy-PortableConfigBackup {
    param(
        [string]$ExistingConfig,
        [string]$BackupConfig
    )
    $RootConfig = Join-Path $Root 'proxy.config.json'
    if ((Test-ExampleProxyConfig $ExistingConfig) -and (Test-Path $RootConfig) -and -not (Test-ExampleProxyConfig $RootConfig)) {
        Copy-Item $RootConfig $BackupConfig -Force
        return
    }
    if (Test-Path $ExistingConfig) {
        Copy-Item $ExistingConfig $BackupConfig -Force
        Copy-EntryAuthFromRootConfig $BackupConfig | Out-Null
    }
}

function Clear-PortableGeneratedFiles {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    $stateNames = @('.hpm-runtime', 'proxy.config.json')
    Get-ChildItem -LiteralPath $Path -Force | ForEach-Object {
        if ($stateNames -contains $_.Name) { return }
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}

if (-not $SkipBuild) {
    Push-Location $Root
    try {
        npm run tauri:build
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $Exe)) {
    throw "Release exe not found: $Exe. Run npm run tauri:build first, or remove -SkipBuild."
}

New-Item -ItemType Directory -Path $StateBackupDir -Force | Out-Null
$ExistingConfig = Join-Path $PortableDir 'proxy.config.json'
$ExistingCertDir = Join-Path $PortableDir '.hpm-runtime\.certs'
Copy-PortableConfigBackup $ExistingConfig (Join-Path $StateBackupDir 'proxy.config.json')
if (Test-Path $ExistingCertDir) {
    Copy-Item $ExistingCertDir (Join-Path $StateBackupDir '.certs') -Recurse -Force
    $NestedCertBackup = Join-Path $StateBackupDir '.certs\.certs'
    if (Test-Path $NestedCertBackup) { Remove-Item $NestedCertBackup -Recurse -Force }
}

Clear-PortableGeneratedFiles $PortableDir
New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

Copy-RequiredFile $Exe (Join-Path $PortableDir 'https-proxy-manager.exe')
Copy-RequiredFile (Join-Path $Root 'openai-proxy.js') (Join-Path $PortableDir 'openai-proxy.js')
Write-RuntimePackageJson
Copy-Item (Join-Path $Root 'lib') (Join-Path $PortableDir 'lib') -Recurse -Force
Copy-NodeRuntimeModule 'node-forge'
Copy-RequiredFile (Join-Path $Root 'proxy.ps1') (Join-Path $PortableDir 'proxy.ps1')
Copy-RequiredFile (Join-Path $Root 'proxy.config.example.json') (Join-Path $PortableDir 'proxy.config.example.json')
Copy-RequiredFile (Join-Path $Root 'tray-icon.ico') (Join-Path $PortableDir 'tray-icon.ico')
Copy-RequiredFile (Join-Path $Root 'proxy.bat') (Join-Path $PortableDir 'proxy.bat')

Assert-PortableFileMatches 'openai-proxy.js'
Assert-PortableFileMatches 'lib\proxy\cert.js'
Assert-PortableFileMatches 'lib\proxy\cert-management.js'

$BackedUpConfig = Join-Path $StateBackupDir 'proxy.config.json'
$BackedUpCertDir = Join-Path $StateBackupDir '.certs'
if (Test-Path $BackedUpConfig) {
    Copy-Item $BackedUpConfig (Join-Path $PortableDir 'proxy.config.json') -Force
} else {
    Copy-Item (Join-Path $PortableDir 'proxy.config.example.json') (Join-Path $PortableDir 'proxy.config.json') -Force
}
if (Test-Path $BackedUpCertDir) {
    $PortableRuntimeDir = Join-Path $PortableDir '.hpm-runtime'
    $PortableCertDir = Join-Path $PortableRuntimeDir '.certs'
    New-Item -ItemType Directory -Path $PortableRuntimeDir -Force | Out-Null
    if (Test-Path $PortableCertDir) { Remove-Item $PortableCertDir -Recurse -Force }
    Copy-Item $BackedUpCertDir $PortableCertDir -Recurse -Force
}

$nodeCopied = Copy-CommandBinary 'node' (Join-Path $RuntimeDir 'node')

$nodeStatus = if ($nodeCopied) { 'Bundled runtime\node\node.exe' } else { 'Node.js not found locally; target machine must install Node.js and add it to PATH' }
$modulesStatus = 'Bundled runtime module: node-forge'

$readme = @(
    'HTTPS Proxy Manager Portable',
    '',
    'Usage:',
    '1. Double-click https-proxy-manager.exe to start the manager and local proxy.',
    '2. Config, logs, and certificates are stored in this portable folder.',
    '3. Optional CLI maintenance: proxy.bat start|stop|restart|status|logs.',
    '',
    'Runtime:',
    "- Node.js: $nodeStatus",
    "- Node modules: $modulesStatus",
    '- PowerShell: uses pwsh when available; otherwise falls back to Windows PowerShell.',
    '- Certificates: generated with bundled Node.js dependencies; OpenSSL is not required.',
    '',
    'Notes:',
    '- First proxy start creates proxy.config.json from proxy.config.example.json.',
    '- proxy.config.json is local user state and may contain API keys; do not redistribute it.',
    '- First run creates .hpm-runtime/.certs. Install the certificate from the UI if clients need trusted HTTPS.'
) -join [Environment]::NewLine
Set-Content -Path (Join-Path $PortableDir 'README.txt') -Value $readme -Encoding UTF8

if (-not $NoZip) {
    $ZipPath = Join-Path $Root (Join-Path $OutputRoot 'HTTPS-Proxy-Manager-Portable.zip')
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Compress-Archive -Path $PortableDir -DestinationPath $ZipPath -Force
    Write-Host "Portable package generated: $PortableDir"
    Write-Host "Zip generated: $ZipPath"
} else {
    Write-Host "Portable package generated: $PortableDir"
}

if (-not $nodeCopied) { Write-Warning 'Node.js was not bundled; target machine must install Node.js.' }

Remove-Item $StateBackupDir -Recurse -Force -ErrorAction SilentlyContinue
