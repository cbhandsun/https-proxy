Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
. (Join-Path $PSScriptRoot '../context-hosted/shared/hosted-materials.ps1')

function Assert-HpmClientPreparationHost {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:CI -cne 'true') { throw 'installed_client_preparation_rejected' }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'installed_client_preparation_rejected' }
}
function Read-HpmClientPreparation {
    param([string]$CurrentSha, [string]$ReceiptSha256)
    $file = Join-Path $env:RUNNER_TEMP 'hpm-installed-client-preparation.json'
    Assert-HpmN08MaterialPath $file $false
    if ($CurrentSha -cnotmatch '\A[a-f0-9]{40}\z' -or $ReceiptSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or
        (Get-Item -LiteralPath $file).Length -gt 4096 -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ReceiptSha256) { throw 'installed_client_preparation_rejected' }
    $doc = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($file))
    try {
        $item = $doc.RootElement
        $keys = @($item.EnumerateObject() | ForEach-Object { $_.Name })
        if ($keys.Count -ne 5 -or ($keys | Sort-Object) -join ',' -cne 'buildCompleted,candidateNpmCompleted,currentSha,schemaVersion,verificationCompleted' -or
            $item.GetProperty('schemaVersion').GetInt32() -ne 1 -or $item.GetProperty('currentSha').GetString() -cne $CurrentSha) { throw 'installed_client_preparation_rejected' }
        foreach ($key in @('buildCompleted', 'candidateNpmCompleted', 'verificationCompleted')) { if (-not $item.GetProperty($key).GetBoolean()) { throw 'installed_client_preparation_rejected' } }
    } finally { $doc.Dispose() }
}
function Assert-HpmClientToolsLock {
    param([string]$Tools)
    foreach ($pair in @(@('package.json', 'caaf4101cd3d6b0f84a8f91b8aa40f189dc6ffe82b6e558cb696707184cb36ec'), @('package-lock.json', '00c1c8ff023023b9b9a034adf8dc4a82a3694524f84d71ba3fcaac17d42219c1'))) {
        $file = Join-Path $Tools $pair[0]
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $file 'Leaf'
        if ((Get-Item -LiteralPath $file).Length -gt 16384) { throw 'installed_client_tools_rejected' }
        $text = [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($file)).Replace("`r`n","`n")
        $sourceHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
        if ($sourceHash -cne $pair[1]) { throw 'installed_client_tools_rejected' }
    }
    # Git LF-normalized bytes avoid checkout-only CRLF drift; content and SRI
    # stay exact. These lock bytes include both immutable registry URLs and SHA512 SRI.
    # npm ci verifies archive integrity; no platform override or lifecycle script.
}
function Invoke-HpmClientToolsNpm {
    param([string]$Tools)
    & npm ci --prefix $Tools --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'installed_client_npm_failed' }
}
function New-HpmClientFileLease {
    param([string]$File)
    Initialize-HpmN08ArtifactLease
    return [HpmN08ArtifactLease]::new($File, $false)
}
function Initialize-HpmInstalledClientTools {
    param([string]$CurrentSha, [string]$ReceiptSha256)
    Assert-HpmClientPreparationHost
    Read-HpmClientPreparation $CurrentSha $ReceiptSha256
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    if ((& git -C $repo rev-parse HEAD) -cne $CurrentSha -or $LASTEXITCODE -ne 0) { throw 'installed_client_preparation_rejected' }
    $tools = Join-Path $repo 'tools/nsis-clients'
    Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $tools 'Container'
    Assert-HpmClientToolsLock $tools
    Invoke-HpmClientToolsNpm $tools | Out-Host
    Assert-HpmClientToolsLock $tools
    return @{ tools = $tools; npmCompleted = $true; buildCompleted = $true; currentSha = $CurrentSha }
}
function Copy-HpmInstalledClientTools {
    param([string]$OwnedRoot, [hashtable]$Preparation, [hashtable]$State)
    if ($Preparation.npmCompleted -cne $true -or $Preparation.buildCompleted -cne $true) { throw 'installed_client_tools_rejected' }
    $directory = Join-Path $OwnedRoot 'clients'
    Assert-HpmLifecycleChildPath $OwnedRoot $directory
    if (Test-Path -LiteralPath $directory) { throw 'installed_client_tools_rejected' }
    New-Item -ItemType Directory -Path $directory | Out-Null
    $packages = @(
        @('codex', '@openai/codex-win32-x64', '@openai/codex', '0.160.1-win32-x64', 'vendor/x86_64-pc-windows-msvc/bin/codex.exe'),
        @('claude', '@anthropic-ai/claude-code-win32-x64', '@anthropic-ai/claude-code-win32-x64', '2.1.292', 'claude.exe')
    )
    foreach ($entry in $packages) {
        $package = Join-Path $Preparation.tools ('node_modules/' + $entry[1])
        $metadata = Join-Path $package 'package.json'
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $metadata 'Leaf'
        if ((Get-Item -LiteralPath $metadata).Length -gt 16384) { throw 'installed_client_tools_rejected' }
        $json = [IO.File]::ReadAllText($metadata) | ConvertFrom-Json -AsHashtable
        if ($json.name -cne $entry[2] -or $json.version -cne $entry[3]) { throw 'installed_client_tools_rejected' }
        $source = Join-Path $package $entry[4]
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $source 'Leaf'
        $destination = Join-Path $directory ($entry[0] + '.exe')
        Copy-Item -LiteralPath $source -Destination $destination
        Assert-HpmN08MaterialPath $destination $false
        $lease = New-HpmClientFileLease $destination
        $State.leases += $lease
        $lease.Verify($destination)
        $sha = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sha -cne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'installed_client_tools_rejected' }
        $State.hashes[$entry[0]] = $sha
    }
}
Export-ModuleMember -Function Initialize-HpmInstalledClientTools, Copy-HpmInstalledClientTools
