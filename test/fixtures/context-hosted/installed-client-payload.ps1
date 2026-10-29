param([string]$Repository, [string]$FixtureRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:GITHUB_WORKSPACE = $Repository
$env:RUNNER_TEMP = $FixtureRoot
$env:LOCALAPPDATA = Join-Path $FixtureRoot 'local'
$env:APPDATA = Join-Path $FixtureRoot 'roaming'
$env:GITHUB_ACTIONS = 'true'; $env:RUNNER_ENVIRONMENT = 'github-hosted'; $env:RUNNER_OS = 'Windows'
$module = Import-Module (Join-Path $Repository 'scripts/lib/nsis-installed-client-payload.psm1') -Force -PassThru
& $module {
    function script:Assert-HpmInstalledPayloadHost {}
    function script:Get-HpmInstalledPayloadCommit { param($Directory) if ($global:Mode -eq 'sha' -or ($global:Mode -eq 'manifestsha' -and [IO.Path]::GetFileName($Directory) -ceq 'manifest-root')) { return 'b' * 40 }; return 'a' * 40 }
    function script:Get-Process { param($Name,$ErrorAction) if ($global:Mode -eq 'process') { return @{ Id = 1 } } }
    function script:Test-Path {
        param($LiteralPath,$PathType)
        if ($LiteralPath -like 'HK*:*') {
            if ($LiteralPath -like 'HKLM*') { return $false }
            return $global:Registered
        }
        if ($PathType) { return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType }
        return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
    }
    function script:Get-ItemProperty { param($LiteralPath,$ErrorAction)
        return @{ InstallLocation = $(if ($global:Mode -eq 'registration') { Join-Path $env:RUNNER_TEMP 'unrelated' } else { Join-Path $env:RUNNER_TEMP 'hpm-installed-clients/payload' }); DisplayVersion = $(if ($global:Mode -eq 'version') { '0.1.0' } else { '0.1.1' }) }
    }
    function script:New-HpmInstalledPayloadLease { param($Directory)
        $lease = [pscustomobject]@{ Path = $Directory; Disposed = $false }
        $global:Leases[$Directory] = $lease
        $lease | Add-Member -MemberType ScriptMethod -Name Verify -Value { param($value) if ($this.Disposed -or $this.Path -cne $value -or -not [IO.Directory]::Exists($value)) { throw 'private' } }
        $lease | Add-Member -MemberType ScriptMethod -Name Dispose -Value { if (-not $this.Disposed) { $global:LeaseOrder += ('dispose:' + [IO.Path]::GetFileName($this.Path)); $this.Disposed = $true } }
        return $lease
    }
    function script:Remove-Item {
        param($LiteralPath,[switch]$Recurse,[switch]$Force)
        if (-not $global:Leases[$LiteralPath].Disposed) { throw 'fixture_invalid' }
        $global:LeaseOrder += 'remove-root'
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force
    }
    function script:Get-HpmInstalledPayloadNode { param($Root,$Payload,$ManifestSha256)
        if ($global:Mode -eq 'node') { throw 'private' }
        $actual = (Get-FileHash (Join-Path $Payload 'release-runtime-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -cne $ManifestSha256) { throw 'private' }
        return Join-Path $Payload 'runtime/node/node.exe'
    }
    function script:Invoke-HpmInstalledPayloadProcess { param($Program,$Arguments)
        if ($Program.EndsWith('uninstall.exe')) {
            $global:Uninstalls++
            if (-not $global:Leases[$global:Payload].Disposed -or $global:Leases[(Join-Path $env:RUNNER_TEMP 'hpm-installed-clients')].Disposed) { throw 'fixture_invalid' }
            $global:LeaseOrder += 'uninstall'
            if (-not $global:Stopped -or $Arguments[0] -cne '/S' -or $Arguments[1] -cne ('_?=' + $global:Payload)) { throw 'fixture_invalid' }
            if ($global:Mode -eq 'uninstall') { throw 'private' }
            $global:Registered = $false
            [IO.File]::Delete((Join-Path $global:Payload 'https-proxy-manager.exe'))
            return
        }
        $global:Installs++
        $global:Payload = Join-Path $env:RUNNER_TEMP 'hpm-installed-clients/payload'
        if ($Arguments[0] -cne '/S' -or $Arguments[1] -cne ('/D=' + $global:Payload)) { throw 'fixture_invalid' }
        if (-not [IO.File]::Exists((Join-Path $global:Payload 'proxy.config.json'))) { throw 'fixture_invalid' }
        if ($global:Mode -eq 'install') { throw 'private' }
        if ($global:Mode -eq 'partialinstall') { [IO.File]::WriteAllText((Join-Path $global:Payload 'uninstall.exe'), 'not-pinned-uninstaller'); $global:Registered = $true; throw 'private' }
        $global:Registered = $true
        foreach ($relative in @('runtime/node/node.exe','runtime/native/hpm-context-recovery-key.exe',('runtime/evidence-gateway/gateway-' + $global:Digest + '.cjs'),'lib/proxy/cert.js','openai-proxy.js','package-lock.json','https-proxy-manager.exe','uninstall.exe')) {
            $file = Join-Path $global:Payload $relative
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
            [IO.File]::WriteAllText($file, 'synthetic')
        }
        Copy-Item -LiteralPath $global:Manifest -Destination (Join-Path $global:Payload 'release-runtime-manifest.json')
        if ($global:Mode -eq 'offline') { [IO.File]::WriteAllText((Join-Path $global:Payload 'proxy.config.json'), 'tampered') }
        if ($global:Mode -eq 'sources') { [IO.File]::WriteAllText((Join-Path $global:Payload 'openai-proxy.js'), 'tampered') }
    }
}
$artifacts = Join-Path $Repository 'test/fixtures/context-hosted/payload-generated'
# This directory exists only in the copied synthetic repository used by this fixture.
[IO.Directory]::CreateDirectory($artifacts) | Out-Null
[IO.File]::WriteAllText((Join-Path $artifacts 'candidate-setup.exe'), 'synthetic setup')
$global:Digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('synthetic'))).ToLowerInvariant()
$manifestRoot = Join-Path $artifacts 'manifest-root'
[IO.Directory]::CreateDirectory($manifestRoot) | Out-Null
$global:Manifest = Join-Path $manifestRoot 'manifest.json'
@{ schemaVersion = 2; nodeSha256 = $global:Digest; contextRecoveryNativeSha256 = $global:Digest; packageLockSha256 = $global:Digest; evidenceGatewayBundleSha256 = $global:Digest; sourceSha256 = @{ 'openai-proxy.js' = $global:Digest; 'lib/proxy/cert.js' = $global:Digest } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $global:Manifest -Encoding utf8
$observed = @()
foreach ($global:Mode in @('success','sha','manifestsha','process','existing','data','root','setups','install','partialinstall','registration','version','node','sources','offline','callback','callbacktype','uninstallerchanged','stop','stoptype','uninstall')) {
    $global:Registered = $global:Mode -eq 'existing'
    $global:Leases = @{}; $global:LeaseOrder = @()
    $global:Stopped = $false; $global:Installs = 0; $global:Uninstalls = 0
    $root = Join-Path $env:RUNNER_TEMP 'hpm-installed-clients'
    $data = Join-Path $env:LOCALAPPDATA 'HTTPS Proxy Manager'
    if ($global:Mode -eq 'root') { [IO.Directory]::CreateDirectory($root) | Out-Null }
    $extraSetup = Join-Path $artifacts 'other-setup.exe'
    if ($global:Mode -eq 'setups') { [IO.File]::WriteAllText($extraSetup, 'other') }
    if ($global:Mode -eq 'data') { [IO.Directory]::CreateDirectory($data) | Out-Null }
    $failure = $null; $receipt = $null
    try {
        $receipt = Invoke-HpmInstalledClientPayload -CurrentDirectory $artifacts -CurrentRuntimeManifest $global:Manifest -CurrentSha ('a' * 40) -RunOwnedScenario {
            param($material)
            if ($material.currentSha -cne ('a' * 40) -or (Test-Path (Join-Path $material.ownedRoot 'build-and-npm.json'))) { throw 'fixture_invalid' }
            if ($global:Mode -eq 'callback') { throw 'private' }
            if ($global:Mode -eq 'uninstallerchanged') { [IO.File]::WriteAllText((Join-Path $material.payload 'uninstall.exe'), 'unexpected uninstaller') }
            return @{ passed = $(if ($global:Mode -eq 'callbacktype') { 'True' } else { $true }) }
        } -StopOwnedScenario { $global:Stopped = $true; return @{ treeEmpty = $(if ($global:Mode -eq 'stoptype') { 'True' } else { $global:Mode -ne 'stop' }) } }
    } catch { $failure = $_.Exception.Message }
    $observed += @{ mode = $global:Mode; error = $failure; installed = $global:Installs; uninstalled = $global:Uninstalls; retained = [IO.Directory]::Exists($root); stopped = $global:Stopped; leaseOrder = $global:LeaseOrder; receipt = $receipt }
    if ([IO.File]::Exists($extraSetup)) { [IO.File]::Delete($extraSetup) }
    if ([IO.Directory]::Exists($root)) { Remove-Item -LiteralPath $root -Recurse -Force }
    if ([IO.Directory]::Exists($data)) { Remove-Item -LiteralPath $data -Recurse -Force }
}
$observed | ConvertTo-Json -Compress -Depth 4
