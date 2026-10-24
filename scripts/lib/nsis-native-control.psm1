Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
$script:nativeProcessModule = Import-Module (Join-Path $PSScriptRoot 'nsis-installed-daemon-http.psm1') -PassThru
$script:nativeInputModule = Import-Module (Join-Path $PSScriptRoot 'nsis-client-inputs.psm1') -PassThru

function ConvertFrom-HpmNativeControlReceipt {
    param([string]$Output, [string]$Manifest, [string]$Commit, [string]$Application)
    $document = $null
    try {
        if ($Manifest -cnotmatch '\A[a-f0-9]{64}\z' -or $Commit -cnotmatch '\A[a-f0-9]{40}\z' -or $Application -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
        if ([string]::IsNullOrEmpty($Output) -or [Text.Encoding]::UTF8.GetByteCount($Output) -gt 4096) { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse($Output)
        $value = $document.RootElement
        $names = @($value.EnumerateObject() | ForEach-Object { $_.Name })
        $expected = @('applicationSha256','clientQualified','idleGracefulStopVerified','manifestSha256','modelRequests','normalStops','originalExpiryPreserved','passed','restartRetention','retention24hQualified','schemaVersion','scope','sourceCommit','storageReopenVerified')
        if ($names.Count -ne 14 -or ($names | Sort-Object) -join ',' -cne ($expected -join ',') -or
            $value.GetProperty('schemaVersion').GetInt32() -ne 1 -or $value.GetProperty('scope').GetString() -cne 'installed_native_idle_stop_storage_reopen' -or
            $value.GetProperty('sourceCommit').GetString() -cne $Commit -or $value.GetProperty('manifestSha256').GetString() -cne $Manifest -or $value.GetProperty('applicationSha256').GetString() -cne $Application -or
            $value.GetProperty('normalStops').GetInt32() -ne 2 -or $value.GetProperty('modelRequests').GetInt32() -ne 0) { throw 'invalid' }
        foreach ($name in @('passed','originalExpiryPreserved','storageReopenVerified','idleGracefulStopVerified')) { if (-not $value.GetProperty($name).GetBoolean()) { throw 'invalid' } }
        foreach ($name in @('restartRetention','clientQualified','retention24hQualified')) { if ($value.GetProperty($name).GetBoolean()) { throw 'invalid' } }
        return [pscustomobject]@{ schemaVersion = 1; scope = 'installed_native_idle_stop_storage_reopen'; passed = $true; normalStops = 2; originalExpiryPreserved = $true; storageReopenVerified = $true; idleGracefulStopVerified = $true; restartRetention = $false; clientQualified = $false; retention24hQualified = $false; modelRequests = 0; sourceCommit = $Commit; manifestSha256 = $Manifest; applicationSha256 = $Application }
    } catch { throw 'native_control_receipt_rejected' } finally { if ($null -ne $document) { $document.Dispose() } }
}

function Write-HpmNativeControlFailurePhase {
    param([string]$Executor)
    $phase = 'not_started'
    $document = $null
    try {
        $file = Join-Path $Executor 'native-control-phase.json'
        if (Test-Path -LiteralPath $file) {
            Assert-HpmLifecycleArtifactPath $Executor $file 'Leaf'
            if ((Get-Item -LiteralPath $file).Length -gt 256) { throw 'invalid' }
            $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($file))
            $value = $document.RootElement
            $names = @($value.EnumerateObject() | ForEach-Object { $_.Name })
            if ($names.Count -ne 2 -or ($names | Sort-Object) -join ',' -cne 'phase,schemaVersion' -or $value.GetProperty('schemaVersion').GetInt32() -ne 1) { throw 'invalid' }
            $candidate = $value.GetProperty('phase').GetString()
            if ($candidate -cnotin @('seed','start-1','ready-1','stop-1','read-1','start-2','ready-2','stop-2','read-2','complete')) { throw 'invalid' }
            $phase = $candidate
        }
    } catch { $phase = 'phase_invalid' } finally { if ($null -ne $document) { $document.Dispose() } }
    [Console]::Error.WriteLine('NSIS_NATIVE_CONTROL_PHASE=' + $phase)
}

function Invoke-HpmInstalledNativeControl {
    param($Material, [hashtable]$State)
    & $script:nativeInputModule { Assert-HpmClientPreparationHost }
    $lease = $null
    $executor = Join-Path $Material.ownedRoot 'native-control-driver'
    try {
        if ($Material.currentSha -cne $env:GITHUB_SHA) { throw 'invalid' }
        Assert-HpmLifecycleArtifactPath $env:RUNNER_TEMP $Material.ownedRoot 'Container'
        Assert-HpmLifecycleArtifactPath $Material.ownedRoot $Material.payload 'Container'
        Assert-HpmLifecycleArtifactPath $Material.payload $Material.node 'Leaf'
        $program = Join-Path $Material.payload 'https-proxy-manager.exe'
        Assert-HpmLifecycleArtifactPath $Material.payload $program 'Leaf'
        $lease = [HpmN08ArtifactLease]::new($program, $false)
        $application = (Get-FileHash -LiteralPath $program -Algorithm SHA256).Hash.ToLowerInvariant()
        if (Test-Path -LiteralPath $executor) { throw 'invalid' }
        New-Item -ItemType Directory -Path $executor | Out-Null
        foreach ($name in @('home','appdata','localappdata','tmp','config','runtime')) { New-Item -ItemType Directory -Path (Join-Path $executor $name) | Out-Null }
        $driver = Join-Path $PSScriptRoot 'nsis-native-control-probe.cjs'
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $driver 'Leaf'
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $Material.node; $start.WorkingDirectory = $Material.payload
        $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
        & $script:nativeProcessModule { param($s,$r) Set-HpmInstalledHttpDriverEnvironment $s $r } $start $executor
        foreach ($name in @('GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','CI','GITHUB_SHA','GITHUB_WORKSPACE')) { $start.Environment[$name] = [Environment]::GetEnvironmentVariable($name) }
        foreach ($argument in @($driver,$Material.ownedRoot,$Material.payload,$executor,$Material.manifestSha256,$Material.currentSha,$application)) { $start.ArgumentList.Add($argument) }
        $State.treeEmpty = $false
        $output = & $script:nativeProcessModule { param($s) Invoke-HpmInstalledHttpDriverProcess $s -RequireNaturalExit } $start
        $State.treeEmpty = $true
        $lease.Verify($program)
        $receipt = ConvertFrom-HpmNativeControlReceipt $output $Material.manifestSha256 $Material.currentSha $application
        return [pscustomobject]@{ probe = $receipt; naturalTreeEmpty = $true }
    } catch {
        if ($_.Exception.Message -cmatch '\Ainstalled_daemon_http_process_failed:cause=(resources_failed|start_failed|job_assign_failed|gate_release_failed|deadline|pipe_failed|output_limit|exit_failed|output_invalid|none);cleanup=confirmed\z') { $State.treeEmpty = $true }
        Write-HpmNativeControlFailurePhase $executor
        throw 'installed_native_control_failed'
    } finally { if ($null -ne $lease) { $lease.Dispose() } }
}
Export-ModuleMember -Function Invoke-HpmInstalledNativeControl, ConvertFrom-HpmNativeControlReceipt
