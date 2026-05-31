param(
    [switch]$SkipBuild,
    [switch]$NoZip,
    [string]$OutputRoot = "dist\portable"
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $Root 'src-tauri\target\release'
$Exe = Join-Path $ReleaseDir 'https-proxy-manager.exe'
$PortableName = 'HTTPS Proxy Manager Portable'
$PortableDir = Join-Path $Root (Join-Path $OutputRoot $PortableName)
$RuntimeDir = Join-Path $PortableDir 'runtime'

function Copy-RequiredFile {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path $Source)) { throw "缺少文件: $Source" }
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

if (-not $SkipBuild) {
    Push-Location $Root
    try {
        npm run tauri:build
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $Exe)) {
    throw "未找到 release exe: $Exe。请先运行 npm run tauri:build，或去掉 -SkipBuild。"
}

if (Test-Path $PortableDir) { Remove-Item $PortableDir -Recurse -Force }
New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

Copy-RequiredFile $Exe (Join-Path $PortableDir 'https-proxy-manager.exe')
Copy-RequiredFile (Join-Path $Root 'openai-proxy.js') (Join-Path $PortableDir 'openai-proxy.js')
Copy-Item (Join-Path $Root 'lib') (Join-Path $PortableDir 'lib') -Recurse -Force
Copy-RequiredFile (Join-Path $Root 'proxy.ps1') (Join-Path $PortableDir 'proxy.ps1')
Copy-RequiredFile (Join-Path $Root 'proxy.config.json') (Join-Path $PortableDir 'proxy.config.json')
Copy-RequiredFile (Join-Path $Root 'tray-icon.ico') (Join-Path $PortableDir 'tray-icon.ico')
Copy-RequiredFile (Join-Path $Root 'proxy.bat') (Join-Path $PortableDir 'proxy.bat')
Copy-RequiredFile (Join-Path $Root '启动管理器.bat') (Join-Path $PortableDir '启动管理器.bat')
Copy-RequiredFile (Join-Path $Root '启动代理.bat') (Join-Path $PortableDir '启动代理.bat')

$nodeCopied = Copy-CommandBinary 'node' (Join-Path $RuntimeDir 'node')
$opensslCopied = Copy-CommandBinary 'openssl' (Join-Path $RuntimeDir 'openssl\bin')

$nodeStatus = if ($nodeCopied) { '已随包携带 runtime\node\node.exe' } else { '未检测到本机 node，目标机器需要自行安装 Node.js 并加入 PATH' }
$opensslStatus = if ($opensslCopied) { '已随包携带 runtime\openssl\bin\openssl.exe' } else { '未检测到本机 openssl，首次生成证书时目标机器需要自行安装 OpenSSL 并加入 PATH' }

$readme = @(
    'HTTPS Proxy Manager 便携版'
    ''
    '使用方式：'
    '1. 双击 启动管理器.bat，或直接运行 https-proxy-manager.exe。'
    '2. 配置、日志、证书会保存在当前便携目录内。'
    '3. 命令行管理可使用 proxy.bat start|stop|restart|status|logs。'
    ''
    '运行时状态：'
    "- Node.js: $nodeStatus"
    "- OpenSSL: $opensslStatus"
    '- PowerShell 7: 当前版本仍需要目标机器可执行 pwsh。'
    ''
    '注意：'
    '- proxy.config.json 可能包含 API Key，分发前请按需清理或改成默认配置。'
    '- 首次启动会生成 .certs 目录；如果客户端需要信任 HTTPS，请在界面中安装证书。'
) -join [Environment]::NewLine
Set-Content -Path (Join-Path $PortableDir 'README.txt') -Value $readme -Encoding UTF8

if (-not $NoZip) {
    $ZipPath = Join-Path $Root (Join-Path $OutputRoot 'HTTPS-Proxy-Manager-Portable.zip')
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Compress-Archive -Path $PortableDir -DestinationPath $ZipPath -Force
    Write-Host "便携版已生成: $PortableDir"
    Write-Host "压缩包已生成: $ZipPath"
} else {
    Write-Host "便携版已生成: $PortableDir"
}

if (-not $nodeCopied) { Write-Warning '未打包 Node.js：目标机器需要安装 Node.js。' }
if (-not $opensslCopied) { Write-Warning '未打包 OpenSSL：目标机器首次生成证书需要 OpenSSL。' }
