Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-installed-client-payload.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-client-inputs.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-client-matrix-receipt.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-native-control.psm1')
$script:clientProcessModule = Import-Module (Join-Path $PSScriptRoot 'nsis-installed-daemon-http.psm1') -PassThru
. (Join-Path $PSScriptRoot '../context-hosted/shared/hosted-network.ps1')

function Invoke-HpmClientMatrixProcess {
    param([Diagnostics.ProcessStartInfo]$StartInfo)
    return & $script:clientProcessModule { param($start) Invoke-HpmInstalledHttpDriverProcess $start } $StartInfo
}
function Invoke-HpmInstalledClientDriver {
    param($Material, $Network, [hashtable]$State)
    $driver = Join-Path $PSScriptRoot 'nsis-installed-client-matrix.cjs'
    Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $driver 'Leaf'
    $executor = Join-Path $Material.ownedRoot 'client-driver'
    if (Test-Path -LiteralPath $executor) { throw 'installed_client_driver_rejected' }
    New-Item -ItemType Directory -Path $executor | Out-Null
    foreach ($name in @('home','appdata','localappdata','tmp','config','runtime')) { New-Item -ItemType Directory -Path (Join-Path $executor $name) | Out-Null }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Material.node
    $start.WorkingDirectory = $Material.payload
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    & $script:clientProcessModule { param($s,$r) Set-HpmInstalledHttpDriverEnvironment $s $r } $start $executor
    foreach ($key in @('RUNNER_TEMP','GITHUB_WORKSPACE','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','CI')) { $start.Environment[$key] = [Environment]::GetEnvironmentVariable($key) }
    foreach ($argument in @($driver, $Material.ownedRoot, $Material.payload, $Material.manifestSha256, $Network.networkRoot, $Network.caSha256, $Network.leafSha256, $State.hashes.codex, $State.hashes.claude)) { $start.ArgumentList.Add($argument) }
    $State.treeEmpty = $false
    try {
        $output = Invoke-HpmClientMatrixProcess $start
        # This function returns only after original Job StopAndWait and process
        # termination succeeded; receipt parsing does not manufacture that proof.
        $State.treeEmpty = $true
        $State.matrixReceipt = ConvertFrom-HpmInstalledClientMatrixReceipt $output
        return $State.matrixReceipt
    } catch {
        if ($_.Exception.Message -cmatch '\Ainstalled_daemon_http_process_failed:cause=(resources_failed|start_failed|job_assign_failed|gate_release_failed|deadline|pipe_failed|output_limit|exit_failed|output_invalid|none);cleanup=confirmed\z') { $State.treeEmpty = $true }
        throw 'installed_client_driver_failed'
    } finally { Write-HpmInstalledClientPhase $Material.ownedRoot }
}
function Invoke-HpmPreparedInstalledClients {
    param($Material, [hashtable]$Preparation, [hashtable]$State)
    try {
        Copy-HpmInstalledClientTools $Material.ownedRoot $Preparation $State
        $receiptFile = Join-Path $Material.ownedRoot 'build-and-npm.json'
        if (Test-Path -LiteralPath $receiptFile) { throw 'installed_client_preparation_rejected' }
        @{ phase = 'build_and_npm_ready'; buildCompleted = $Preparation.buildCompleted; npmCompleted = $Preparation.npmCompleted; manifestSha256 = $Material.manifestSha256; nodeSha256 = $Material.nodeSha256 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $receiptFile -Encoding utf8
        $receiptSha = (Get-FileHash -LiteralPath $receiptFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $owner = $ExecutionContext.SessionState.Module
        $run = { param($network) & $owner {
            param($m,$n,$s)
            $s.nativeControl = Invoke-HpmInstalledNativeControl $m $s
            if ($s.nativeControl.naturalTreeEmpty -cne $true -or $s.nativeControl.probe.passed -cne $true) { throw 'installed_native_control_failed' }
            Invoke-HpmInstalledClientDriver $m $n $s
        } $Material $network $State }.GetNewClosure()
        $stop = { return $State.treeEmpty -ceq $true }.GetNewClosure()
        $networkReceipt = Invoke-HpmN08HostedNetwork -OwnedRoot $Material.ownedRoot -BuildReceiptSha256 $receiptSha -InstalledClientMatrix -RunOwnedScenario $run -StopOwnedScenario $stop
        if ($networkReceipt.phase -cne 'hosted_network_finished' -or $networkReceipt.ownedTreeEmpty -cne $true -or $State.treeEmpty -cne $true) { throw 'installed_client_driver_failed' }
        return @{ passed = $true }
    } finally {
        foreach ($lease in $State.leases) { $lease.Dispose() }
    }
}
function Invoke-HpmNsisInstalledClients {
    [CmdletBinding()]
    param([string]$CurrentDirectory, [string]$CurrentRuntimeManifest, [string]$CurrentSha, [string]$PreparationReceiptSha256)
    try {
        $preparation = Initialize-HpmInstalledClientTools $CurrentSha $PreparationReceiptSha256
        $state = @{ treeEmpty = $true; leases = @(); hashes = @{} }
        $owner = $ExecutionContext.SessionState.Module
        $run = { param($material) & $owner { param($m,$p,$s) Invoke-HpmPreparedInstalledClients $m $p $s } $material $preparation $state }.GetNewClosure()
        $stop = { return @{ treeEmpty = $state.treeEmpty -ceq $true } }.GetNewClosure()
        $result = Invoke-HpmInstalledClientPayload -CurrentDirectory $CurrentDirectory -CurrentRuntimeManifest $CurrentRuntimeManifest -CurrentSha $CurrentSha -RunOwnedScenario $run -StopOwnedScenario $stop
        if ($result.phase -cne 'installed_payload_finished' -or $result.ownedTreeEmpty -cne $true) { throw 'invalid' }
        return @{ phase = 'installed_native_cli_four_cases_finished'; matrix = $state.matrixReceipt; nativeControl = $state.nativeControl; uninstalled = $true }
    } catch { throw 'nsis_installed_clients_failed' }
}
Export-ModuleMember -Function Invoke-HpmNsisInstalledClients
