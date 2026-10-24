param([string]$Repository, [string]$FixtureRoot, [string]$ReceiptFile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:GITHUB_WORKSPACE = $Repository
$env:RUNNER_TEMP = $FixtureRoot
$env:GITHUB_ACTIONS = ''; $env:RUNNER_ENVIRONMENT = ''; $env:CI = ''
$inputs = Import-Module (Join-Path $Repository 'scripts/lib/nsis-client-inputs.psm1') -Force -PassThru
& $inputs {
    function script:Assert-HpmClientPreparationHost {}
    function script:git { param($C,$Directory,$Command,$Head) $global:LASTEXITCODE = 0; return 'a' * 40 }
    function script:Invoke-HpmClientToolsNpm {
        param($Tools)
        $global:NpmCalls++
        if ($global:Mode -eq 'npm') { throw 'private' }
        foreach ($item in @(@('node_modules/@openai/codex-win32-x64','@openai/codex','0.160.1-win32-x64','vendor/x86_64-pc-windows-msvc/bin/codex.exe'), @('node_modules/@anthropic-ai/claude-code-win32-x64','@anthropic-ai/claude-code-win32-x64','2.1.292','claude.exe'))) {
            $package = Join-Path $Tools $item[0]
            [IO.Directory]::CreateDirectory($package) | Out-Null
            $name = $item[1]
            if ($global:Mode -eq 'package' -and $name.StartsWith('@anthropic-ai')) { $name = 'wrong' }
            @{ name = $name; version = $item[2] } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $package 'package.json') -Encoding utf8
            $binary = Join-Path $package $item[3]
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($binary)) | Out-Null
            [IO.File]::WriteAllText($binary, 'synthetic executable')
        }
        if ($global:Mode -eq 'drift') { [IO.File]::AppendAllText((Join-Path $Tools 'package-lock.json'), ' ') }
    }
    function script:New-HpmClientFileLease {
        param($File)
        $lease = [pscustomobject]@{ file = $File; disposed = $false }
        $lease | Add-Member -MemberType ScriptMethod -Name Verify -Value { param($file) if ($file -cne $this.file -or $this.disposed) { throw 'private' } }
        $lease | Add-Member -MemberType ScriptMethod -Name Dispose -Value { if (-not $this.disposed) { $global:LeasesDisposed++; $this.disposed = $true } }
        return $lease
    }
}
$orchestration = Import-Module (Join-Path $Repository 'scripts/lib/nsis-client-orchestration.psm1') -Force -PassThru
& $orchestration {
    function script:Invoke-HpmInstalledClientPayload {
        param($CurrentDirectory,$CurrentRuntimeManifest,$CurrentSha,$RunOwnedScenario,$StopOwnedScenario)
        $global:PayloadCalls++
        $root = Join-Path $env:RUNNER_TEMP 'hpm-installed-clients'
        $payload = Join-Path $root 'payload'
        [IO.Directory]::CreateDirectory((Join-Path $payload 'runtime/node')) | Out-Null
        $node = Join-Path $payload 'runtime/node/node.exe'
        [IO.File]::WriteAllText($node, 'synthetic node')
        try {
            $result = & $RunOwnedScenario ([pscustomobject]@{ ownedRoot = $root; payload = $payload; node = $node; currentSha = $CurrentSha; manifestSha256 = ('3' * 64); nodeSha256 = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant(); setupSha256 = ('4' * 64) })
            if (-not $result.passed) { throw 'private' }
        } finally {
            $global:PayloadStopped = (& $StopOwnedScenario).treeEmpty
            if ($global:PayloadStopped) { Remove-Item -LiteralPath $root -Recurse -Force }
        }
        return @{ phase = 'installed_payload_finished'; ownedTreeEmpty = $true }
    }
    function script:Invoke-HpmN08HostedNetwork {
        param($OwnedRoot,$BuildReceiptSha256,[switch]$InstalledClientMatrix,$RunOwnedScenario,$StopOwnedScenario)
        $global:NetworkCalls++
        if (-not $InstalledClientMatrix) { throw 'fixture_invalid' }
        $file = Join-Path $OwnedRoot 'build-and-npm.json'
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $BuildReceiptSha256) { throw 'fixture_invalid' }
        $receipt = [IO.File]::ReadAllText($file) | ConvertFrom-Json
        if (-not $receipt.buildCompleted -or -not $receipt.npmCompleted -or $receipt.phase -cne 'build_and_npm_ready') { throw 'fixture_invalid' }
        try { $result = & $RunOwnedScenario ([pscustomobject]@{ networkRoot = (Join-Path $OwnedRoot 'n08-hosted-network'); caSha256 = ('1' * 64); leafSha256 = ('2' * 64) }) }
        finally { $global:NetworkStopped = & $StopOwnedScenario }
        if (-not $result.ownedTreeEmpty) { throw 'private' }
        return @{ phase = 'hosted_network_finished'; ownedTreeEmpty = $true }
    }
    function script:Invoke-HpmClientMatrixProcess {
        param($StartInfo)
        $global:DriverCalls++
        if ($StartInfo.ArgumentList.Count -ne 9 -or -not $StartInfo.RedirectStandardInput -or $StartInfo.Environment.ContainsKey('NODE_OPTIONS')) { throw 'fixture_invalid' }
        if ($StartInfo.ArgumentList[5] -cne ('1' * 64) -or $StartInfo.ArgumentList[6] -cne ('2' * 64)) { throw 'fixture_invalid' }
        foreach ($pair in @(@(7,'codex'),@(8,'claude'))) {
            if ((Get-FileHash -LiteralPath (Join-Path $StartInfo.ArgumentList[1] ('clients/' + $pair[1] + '.exe')) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $StartInfo.ArgumentList[$pair[0]]) { throw 'fixture_invalid' }
        }
        if ($global:Mode -eq 'cleanup') { throw 'installed_daemon_http_process_failed:cause=exit_failed;cleanup=failed' }
        if ($global:Mode -eq 'confirmed') { throw 'installed_daemon_http_process_failed:cause=exit_failed;cleanup=confirmed' }
        $text = [IO.File]::ReadAllText($global:ReceiptFile)
        if ($global:Mode -eq 'duplicate') { $text = $text.Replace('"passed":true','"passed":true,"passed":true') }
        if ($global:Mode -eq 'badcase') { $text = $text.Replace('"compactions":3','"compactions":2') }
        return $text
    }
}
$global:ReceiptFile = $ReceiptFile
$tools = Join-Path $Repository 'tools/nsis-clients'
$lockFile = Join-Path $tools 'package-lock.json'
$originalLock = [IO.File]::ReadAllBytes($lockFile)
$proof = Join-Path $FixtureRoot 'hpm-installed-client-preparation.json'
$observed = @()
foreach ($global:Mode in @('success','crlf','proof','proofhash','proofduplicate','lock','npm','drift','package','duplicate','badcase','confirmed','cleanup')) {
    $global:NpmCalls = 0; $global:PayloadCalls = 0; $global:NetworkCalls = 0; $global:DriverCalls = 0; $global:LeasesDisposed = 0
    $global:NetworkStopped = $null; $global:PayloadStopped = $null
    [IO.File]::WriteAllBytes($lockFile, $originalLock)
    @{ schemaVersion = 1; currentSha = ('a' * 40); buildCompleted = $true; candidateNpmCompleted = ($global:Mode -ne 'proof'); verificationCompleted = $true } | ConvertTo-Json -Compress | Set-Content -LiteralPath $proof -Encoding utf8
    if ($global:Mode -eq 'crlf') { [IO.File]::WriteAllText($lockFile, ([Text.Encoding]::UTF8.GetString($originalLock)).Replace("`n","`r`n"), [Text.UTF8Encoding]::new($false)) }
    if ($global:Mode -eq 'proofduplicate') { [IO.File]::WriteAllText($proof, ([IO.File]::ReadAllText($proof)).Replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'), [Text.UTF8Encoding]::new($false)) }
    $proofSha = (Get-FileHash -LiteralPath $proof -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($global:Mode -eq 'proofhash') { $proofSha = '0' * 64 }
    if ($global:Mode -eq 'lock') { [IO.File]::AppendAllText($lockFile, ' ') }
    $errorCode = $null; $receipt = $null
    try {
        $receipt = Invoke-HpmNsisInstalledClients -CurrentDirectory 'unused-in-mock' -CurrentRuntimeManifest 'unused-in-mock' -CurrentSha ('a' * 40) -PreparationReceiptSha256 $proofSha 6>$null
    } catch { $errorCode = $_.Exception.Message }
    $observed += @{ mode = $global:Mode; error = $errorCode; npm = $global:NpmCalls; payload = $global:PayloadCalls; network = $global:NetworkCalls; driver = $global:DriverCalls; leasesDisposed = $global:LeasesDisposed; networkStopped = $global:NetworkStopped; payloadStopped = $global:PayloadStopped; receipt = $receipt }
    $owned = Join-Path $FixtureRoot 'hpm-installed-clients'
    if ([IO.Directory]::Exists($owned)) { Remove-Item -LiteralPath $owned -Recurse -Force }
}
$observed | ConvertTo-Json -Compress -Depth 8
