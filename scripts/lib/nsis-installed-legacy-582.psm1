Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-installed-legacy-receipt.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-installed-client-payload.psm1')
$script:processModule = Import-Module (Join-Path $PSScriptRoot 'nsis-installed-daemon-http.psm1') -PassThru
function Invoke-HpmInstalledLegacy582Scenario {
    param($Material, [hashtable]$State)
    $baseline = Join-Path $env:GITHUB_WORKSPACE 'legacy-582'
    $driver = Join-Path $PSScriptRoot 'installed-legacy-582-driver.cjs'
    Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $baseline 'Container'
    Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $driver 'Leaf'
    $executor = Join-Path $Material.ownedRoot 'legacy-582-driver'
    if (Test-Path -LiteralPath $executor) { throw 'installed_legacy_582_rejected' }
    New-Item -ItemType Directory -Path $executor | Out-Null
    foreach ($name in @('home','appdata','localappdata','tmp','config','runtime')) { New-Item -ItemType Directory -Path (Join-Path $executor $name) | Out-Null }
    $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $Material.node; $start.WorkingDirectory = $Material.payload
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    & $script:processModule { param($s,$r) Set-HpmInstalledHttpDriverEnvironment $s $r } $start $executor
    foreach ($arg in @($driver,$baseline,$Material.payload,$Material.manifestSha256)) { $start.ArgumentList.Add($arg) }
    $State.treeEmpty = $false
    try {
        $output = & $script:processModule { param($s) Invoke-HpmInstalledHttpDriverProcess $s -RequireNaturalExit } $start
        $State.treeEmpty = $true
        $receipt = ConvertFrom-HpmInstalledLegacy582Receipt $output $Material.manifestSha256
        $State.receipt = $receipt
        return @{ passed = $true }
    } catch {
        if ($_.Exception.Message -cmatch '\Ainstalled_daemon_http_process_failed:cause=(resources_failed|start_failed|job_assign_failed|gate_release_failed|deadline|pipe_failed|output_limit|exit_failed|output_invalid|none);cleanup=confirmed\z') { $State.treeEmpty = $true }
        throw 'installed_legacy_582_rejected'
    }
}
function Invoke-HpmInstalledLegacy582 {
    param([string]$CurrentDirectory, [string]$CurrentRuntimeManifest, [string]$CurrentSha)
    $state = @{ treeEmpty = $true; receipt = $null }; $owner = $ExecutionContext.SessionState.Module
    $run = { param($material) & $owner { param($m,$s) Invoke-HpmInstalledLegacy582Scenario $m $s } $material $state }.GetNewClosure()
    $stop = { return @{ treeEmpty = $state.treeEmpty -ceq $true } }.GetNewClosure()
    $result = Invoke-HpmInstalledClientPayload -CurrentDirectory $CurrentDirectory -CurrentRuntimeManifest $CurrentRuntimeManifest -CurrentSha $CurrentSha -RunOwnedScenario $run -StopOwnedScenario $stop
    if ($result.phase -cne 'installed_payload_finished' -or $result.ownedTreeEmpty -cne $true -or $result.uninstalled -cne $true) { throw 'installed_legacy_582_rejected' }
    return @{ phase = 'installed_legacy_582_finished'; scope = 'installed_payload_default_worker_582_migration'; passed = $true; sourceSha = $CurrentSha; installedMigrationQualified = $true; driver = $state.receipt; ownedTreeEmpty = $true; uninstalled = $true; modelRequests = 0; retention24hQualified = $false; clientQualified = $false }
}
Export-ModuleMember -Function Invoke-HpmInstalledLegacy582
