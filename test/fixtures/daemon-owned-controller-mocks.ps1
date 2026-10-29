param([string]$NodeExecutable = (Get-Command node).Source, [switch]$ConfigOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/context-recovery-daemon-owned-controller.psm1') -Force
if ($ConfigOnly) {
    $module = Get-Module context-recovery-daemon-owned-controller
    & $module { New-HpmDaemonOwnedConfig @(15000, 25000) } | ConvertTo-Json -Depth 8 -Compress
    return
}
$parseTokens = $null; $parseErrors = $null
[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../../scripts/lib/context-recovery-daemon-owned-controller.ps1'), [ref]$parseTokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -ne 0) { throw 'controller_entry_parse_failed' }
$script:rejected = 0
function Refuses([scriptblock]$Action) {
    try { & $Action | Out-Null } catch { $script:rejected++; return }
    throw 'expected_rejection'
}
$token = 'x' * 32
$frame = '{"v":1,"id":1,"op":"start","case":"00","token":"' + $token + '"}'
$parsed = ConvertFrom-HpmDaemonOwnedFrame $frame
if ($parsed.token -cne $token) { throw 'parser_failed' }
foreach ($bad in @('', 'null', '[]', '{}', ($frame -replace '"v":1', '"v":1,"v":1'), ($frame -replace '"id":1', '"id":0'), ($frame -replace '"case":"00"', '"case":"12"'), ($frame -replace '"op":"start"', '"op":"shell"'), ($frame -replace $token, 'PRIVATE_BAD_TOKEN'), ($frame -replace '"v":1', '"path":"PRIVATE_PATH","v":1'), (' ' * 2049), ($frame -replace '"id":1', '"id":1.5'), ($frame -replace '"token":', '"token":null,"unused":'))) {
    Refuses { ConvertFrom-HpmDaemonOwnedFrame $bad }
}
$script:starts = 0
$script:stops = 0
$operations = @{
    Start = { param($request, $state) $script:starts++; return @{ label = $request.case; identity = @{ pid = 10 } } }
    Alive = { param($owner) return $owner.label -cin @('00', '01', '10', '11') }
    Credentials = { param($owner) return $true }
    Stop = { param($owner) $script:stops++; return $true }
}
$state = New-HpmDaemonOwnedState
$id = 0
foreach ($label in @('00', '01', '10', '11')) {
    $id++; $start = Invoke-HpmDaemonOwnedRequest $state @{ id = $id; op = 'start'; case = $label; token = $token } $operations
    if (-not $start.ok) { throw 'start_failed' }
    $id++; $status = Invoke-HpmDaemonOwnedRequest $state @{ id = $id; op = 'status'; case = $label } $operations
    if (-not $status.alive) { throw 'status_failed' }
    $id++; $stop = Invoke-HpmDaemonOwnedRequest $state @{ id = $id; op = 'stop'; case = $label } $operations
    if (-not $stop.treeEmpty -or $stop.cleanupSemantics -cne 'forced_cleanup') { throw 'stop_failed' }
}
if ($script:starts -ne 4 -or $script:stops -ne 4 -or $state.next -ne 4) { throw 'sequence_failed' }
Refuses { Invoke-HpmDaemonOwnedRequest $state @{ id = 13; op = 'start'; case = '00'; token = $token } $operations }
foreach ($kind in @('replay', 'overlap', 'wrong_case', 'wrong_order', 'false_stop', 'throw_stop', 'start_failure')) {
    $state = New-HpmDaemonOwnedState
    $ops = $operations.Clone()
    if ($kind -ceq 'wrong_order') {
        Refuses { Invoke-HpmDaemonOwnedRequest $state @{ id = 1; op = 'start'; case = '01' } $ops }
        continue
    }
    if ($kind -ceq 'start_failure') {
        $ops.Start = { throw 'PRIVATE_START_ERROR' }
        $failed = Invoke-HpmDaemonOwnedRequest $state @{ id = 1; op = 'start'; case = '00' } $ops
        if ($failed.ok -or $failed.cause -cne 'setup') { throw 'wrong_start_cause' }
    } else {
        Invoke-HpmDaemonOwnedRequest $state @{ id = 1; op = 'start'; case = '00' } $ops | Out-Null
        if ($kind -ceq 'replay') { Refuses { Invoke-HpmDaemonOwnedRequest $state @{ id = 1; op = 'status'; case = '00' } $ops }; continue }
        if ($kind -ceq 'overlap') { Refuses { Invoke-HpmDaemonOwnedRequest $state @{ id = 2; op = 'start'; case = '01' } $ops }; continue }
        if ($kind -ceq 'wrong_case') { Refuses { Invoke-HpmDaemonOwnedRequest $state @{ id = 2; op = 'status'; case = '01' } $ops }; continue }
        $ops.Stop = if ($kind -ceq 'false_stop') { { return $false } } else { { throw 'PRIVATE_STOP_ERROR' } }
        $failed = Invoke-HpmDaemonOwnedRequest $state @{ id = 2; op = 'stop'; case = '00' } $ops
        if ($failed.ok -or $failed.cause -cne 'controller_cleanup') { throw 'wrong_cleanup_cause' }
    }
    if (-not $state.blocked) { throw 'failure_not_blocked' }
    Refuses { Invoke-HpmDaemonOwnedRequest $state @{ id = 3; op = 'start'; case = '01' } $ops }
}

foreach ($stage in @('setup', 'process_start', 'job_assign', 'gate_release', 'PRIVATE_INVALID_STAGE')) {
    $state = New-HpmDaemonOwnedState
    $ops = $operations.Clone()
    $ops.Start = { param($request, $session) $session.startStage = $stage; throw 'PRIVATE_NATIVE_ERROR' }
    $failed = Invoke-HpmDaemonOwnedRequest $state @{ id = 1; op = 'start'; case = '00' } $ops
    $expected = if ($stage -ceq 'PRIVATE_INVALID_STAGE') { 'setup' } else { $stage }
    if ($failed.ok -or $failed.cause -cne $expected -or ($failed.Keys | Sort-Object) -join ',' -cne 'case,cause,id,ok,op,v') { throw 'stage_schema_failed' }
    $stop = Invoke-HpmDaemonOwnedRequest $state @{ id = 2; op = 'stop'; case = '00' } $ops
    if (-not $stop.treeEmpty -or -not $state.blocked) { throw 'failed_start_stop_failed' }
    Refuses { Invoke-HpmDaemonOwnedRequest $state @{ id = 3; op = 'start'; case = '01' } $ops }
}

$module = Get-Module context-recovery-daemon-owned-controller
& $module {
    foreach ($ports in @(@(), @(15000), @(15000, 15000), @(0, 25000), @(15000, 65536), @(15000, 25000, 35000))) {
        try { New-HpmDaemonOwnedConfig $ports | Out-Null; throw 'missing_config_port_rejection' } catch { if ($_.Exception.Message -cne 'daemon_port_rejected') { throw 'wrong_config_port_rejection' } }
    }
    $entered = [Text.Encoding]::ASCII.GetBytes("HPM_GATE_ENTERED`n")
    foreach ($phase in @('PASSED', 'FAILED')) {
        $bytes = [Text.Encoding]::ASCII.GetBytes("HPM_GATE_ENTERED`nHPM_GATE_$phase`n")
        for ($split = 0; $split -le $bytes.Length; $split++) {
            $marker = New-HpmDaemonGateMarker
            $first = [byte[]]::new($split); [Array]::Copy($bytes, 0, $first, 0, $split)
            $second = [byte[]]::new($bytes.Length - $split); [Array]::Copy($bytes, $split, $second, 0, $second.Length)
            Update-HpmDaemonGateMarker $marker $first $first.Length
            Update-HpmDaemonGateMarker $marker $second $second.Length
            if ($marker.phase -cne $phase.ToLowerInvariant() -or -not $marker.done) { throw 'marker_split_failed' }
            Update-HpmDaemonGateMarker $marker ([Text.Encoding]::ASCII.GetBytes("HPM_GATE_FAILED`nPRIVATE_PRODUCT_BYTES")) 16
            if ($marker.phase -cne $phase.ToLowerInvariant()) { throw 'marker_terminal_changed' }
        }
    }
    foreach ($invalid in @([byte[]]@(255), [Text.Encoding]::ASCII.GetBytes("PRIVATE_PRODUCT_BYTES`nHPM_GATE_ENTERED`nHPM_GATE_PASSED`n"), [Text.Encoding]::ASCII.GetBytes("HPM_GATE_PASSED`n"))) {
        $marker = New-HpmDaemonGateMarker
        Update-HpmDaemonGateMarker $marker $invalid $invalid.Length
        if ($marker.phase -cne 'unobserved' -or -not $marker.done) { throw 'marker_invalid_accepted' }
    }
    $marker = New-HpmDaemonGateMarker
    Update-HpmDaemonGateMarker $marker $entered $entered.Length
    Update-HpmDaemonGateMarker $marker $entered $entered.Length
    if ($marker.phase -cne 'entered' -or -not $marker.done) { throw 'marker_extra_accepted' }
    $marker = New-HpmDaemonGateMarker
    Update-HpmDaemonGateMarker $marker ([byte[]]@()) 0
    if ($marker.phase -cne 'unobserved' -or $marker.done) { throw 'marker_empty_changed' }
    foreach ($count in @(-1, 1)) { try { Update-HpmDaemonGateMarker $marker ([byte[]]@()) $count; throw 'missing_marker_count_rejection' } catch { if ($_.Exception.Message -cne 'daemon_protocol_rejected') { throw 'wrong_marker_count_rejection' } } }
    # A MemoryStream returns completed ReadAsync tasks: all queued small chunks
    # must be consumed without waiting, including terminal marker at process exit.
    $marker = New-HpmDaemonGateMarker
    $bytes = [Text.Encoding]::ASCII.GetBytes("HPM_GATE_ENTERED`nHPM_GATE_PASSED`nPRIVATE_PRODUCT_BYTES")
    $stream = [IO.MemoryStream]::new($bytes)
    $buffer = [byte[]]::new(4)
    $item = @{ stream = $stream; buffer = $buffer; count = 0; ended = $false; gateMarker = $marker; task = $stream.ReadAsync($buffer, 0, 4) }
    Update-HpmDaemonOwnedPipes @{ streams = @($item) }
    if ($marker.phase -cne 'passed' -or -not $item.ended -or $item.count -ne $bytes.Length -or ($marker.Keys | Sort-Object) -join ',' -cne 'done,failed,index,passed,phase') { throw 'completed_marker_drain_failed' }
    $stream.Dispose()
    $marker = New-HpmDaemonGateMarker
    $stream = [IO.MemoryStream]::new($bytes)
    $buffer = [byte[]]::new(4)
    $item = @{ stream = $stream; buffer = $buffer; count = 0; ended = $false; task = $stream.ReadAsync($buffer, 0, 4) }
    Update-HpmDaemonOwnedPipes @{ streams = @($item); gateMarker = $marker }
    if ($marker.phase -cne 'unobserved' -or -not $item.ended) { throw 'stdout_marker_promoted' }
    $stream.Dispose()
    $userSid = 'S-1-5-21-10-20-30-1000'
    $rules = @(@{ sid = $userSid; type = 'Allow'; rights = 1 }, @{ sid = 'S-1-5-18'; type = 'Allow'; rights = 1 })
    if (-not (Test-HpmDaemonOwnedAcl $true $rules $userSid)) { throw 'private_acl_rejected' }
    if ((Test-HpmDaemonOwnedAcl $false $rules $userSid) -or (Test-HpmDaemonOwnedAcl $true @() $userSid) -or (Test-HpmDaemonOwnedAcl $true @(@{ sid = 'S-1-1-0'; type = 'Allow'; rights = 1 }) $userSid)) { throw 'broad_acl_accepted' }
    # These objects exercise the real stop/pump code without any live process.
    $script:calls = [Collections.Generic.List[string]]::new()
    $job = [pscustomobject]@{}
    $job | Add-Member ScriptMethod StopAndWait { param($milliseconds) if ($milliseconds -ne 5000) { throw 'deadline' }; $script:calls.Add('job_zero') }
    $job | Add-Member ScriptMethod Dispose { $script:calls.Add('job_dispose') }
    $process = [pscustomobject]@{}
    $process | Add-Member ScriptMethod WaitForExit { param($milliseconds) $script:calls.Add('process_exit'); return $true }
    $process | Add-Member ScriptMethod Dispose { $script:calls.Add('process_dispose') }
    $owner = @{ job = $job; process = $process; assigned = $true; streams = @() }
    if ((Stop-HpmDaemonOwnedCase $owner) -ne $true -or ($script:calls -join ',') -cne 'job_zero,process_exit,job_dispose,process_dispose') { throw 'stop_order' }
    $stream = @{ ended = $false; task = [Threading.Tasks.Task[int]]::FromResult(1024); count = 262144; buffer = [byte[]]::new(1024) }
    try { Update-HpmDaemonOwnedPipes @{ streams = @($stream) }; throw 'missing_limit' } catch { if ($_.Exception.Message -cne 'daemon_output_limit') { throw 'wrong_limit' } }
    $job | Add-Member ScriptMethod StopAndWait { param($milliseconds) throw 'PRIVATE_JOB_ERROR' } -Force
    try { Stop-HpmDaemonOwnedCase $owner | Out-Null; throw 'missing_job_failure' } catch { if ($_.Exception.Message -cne 'daemon_cleanup_failed') { throw 'wrong_job_failure' } }
}

# Same .NET anonymous stdin pipe as the owner, using only a standalone helper.
$gatePath = Join-Path $PSScriptRoot '../../scripts/lib/context-recovery-daemon-start-gate.cjs'
$probeCode = 'const fs=require("node:fs");const {readGate}=require(process.argv[1]);process.stdout.write("entered\n");try{readGate((...a)=>{try{return fs.readSync(...a)}catch(e){process.stdout.write(e.code==="EAGAIN"?"read_eagain\n":"read_other_failed\n");throw e}});process.stdout.write("passed\n")}catch{process.stdout.write("failed\n");process.exitCode=1}'
foreach ($delayMs in @(0, 100, 500)) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $NodeExecutable; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.ArgumentList.Add('-e'); $info.ArgumentList.Add($probeCode); $info.ArgumentList.Add($gatePath)
    $child = [Diagnostics.Process]::new(); $child.StartInfo = $info
    try {
        if (-not $child.Start()) { throw 'pipe_probe_start_failed' }
        $stderr = $child.StandardError.ReadToEndAsync()
        $entered = $child.StandardOutput.ReadLineAsync()
        if (-not $entered.Wait(5000) -or $entered.Result -cne 'entered') { throw 'pipe_probe_enter_failed' }
        [Threading.Thread]::Sleep($delayMs)
        if ($child.HasExited) { throw 'pipe_probe_early_exit' }
        $child.StandardInput.Write('1'); $child.StandardInput.Close()
        $output = $child.StandardOutput.ReadToEndAsync()
        if (-not $child.WaitForExit(5000) -or -not $output.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'pipe_probe_deadline' }
        if ($child.ExitCode -ne 0 -or $output.Result -cne "passed`n" -or $stderr.Result.Length -ne 0) { throw 'pipe_probe_failed' }
    } finally { $child.Dispose() }
}
[Console]::Out.WriteLine('protocolRejects=' + $script:rejected + '; syntheticCases=4; daemonExecutions=0; networkRequests=0')
