Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/context-recovery-daemon-owned-controller.psm1') -Force
$module = Get-Module context-recovery-daemon-owned-controller
$script:rejected = 0
function Refuses([scriptblock]$Action) {
    try { & $Action | Out-Null } catch { $script:rejected++; return }
    throw 'expected_rejection'
}
$operations = @{
    Start = { param($request, $state) return @{ label = $request.case; identity = @{ pid = 10 } } }
    Stop = { return $true }
}
# Natural exit is an independent observation, never forced cleanup relabelled.
$ops = $operations.Clone()
$ops.Reap = { return $true }
$state = New-HpmDaemonOwnedState
Invoke-HpmDaemonOwnedRequest $state @{ id = 1; op = 'start'; case = '00' } $ops | Out-Null
$natural = Invoke-HpmDaemonOwnedRequest $state @{ id = 2; op = 'reap'; case = '00' } $ops
if (-not $natural.ok -or $natural.cleanupSemantics -cne 'natural_exit' -or $natural.exitCode -ne 0 -or $state.next -ne 1 -or $null -ne $state.active) { throw 'natural_receipt_failed' }
$parsed = ConvertFrom-HpmDaemonOwnedFrame '{"v":1,"id":2,"op":"reap","case":"00"}'
if ($parsed.op -cne 'reap') { throw 'natural_frame_failed' }
foreach ($failure in @($false, 'throw')) {
    $state = New-HpmDaemonOwnedState
    $ops.Reap = { if ($failure -ceq 'throw') { throw 'PRIVATE_REAP_ERROR' }; return $false }
    Invoke-HpmDaemonOwnedRequest $state @{ id = 1; op = 'start'; case = '00' } $ops | Out-Null
    $failed = Invoke-HpmDaemonOwnedRequest $state @{ id = 2; op = 'reap'; case = '00' } $ops
    if ($failed.ok -or $failed.cause -cne 'controller_natural_exit' -or -not $state.blocked -or $null -eq $state.active -or $state.next -ne 0) { throw 'natural_failure_promoted' }
    Refuses { Invoke-HpmDaemonOwnedRequest $state @{ id = 3; op = 'reap'; case = '00' } $ops }
    $cleanup = Invoke-HpmDaemonOwnedRequest $state @{ id = 3; op = 'stop'; case = '00' } $ops
    if ($cleanup.cleanupSemantics -cne 'forced_cleanup' -or -not $state.blocked) { throw 'natural_cleanup_promoted' }
}
& $module {
    foreach ($kind in @('valid', 'unassigned', 'nonzero', 'job_nonempty', 'output_failure', 'alive', 'pipe_pending')) {
        $script:naturalCalls = [Collections.Generic.List[string]]::new()
        $job = [pscustomobject]@{}
        $job | Add-Member ScriptMethod WaitForEmpty { param($milliseconds) if ($milliseconds -ne 5000) { throw 'deadline' }; $script:naturalCalls.Add('empty'); if ($kind -ceq 'job_nonempty') { throw 'PRIVATE_JOB_ERROR' } }
        $job | Add-Member ScriptMethod StopAndWait { throw 'natural_path_killed' }
        $job | Add-Member ScriptMethod Dispose { $script:naturalCalls.Add('job_dispose') }
        $process = [pscustomobject]@{ HasExited = $kind -cne 'alive'; ExitCode = $(if ($kind -ceq 'nonzero') { 1 } else { 0 }) }
        $process | Add-Member ScriptMethod Dispose { $script:naturalCalls.Add('process_dispose') }
        $streams = @()
        if ($kind -ceq 'output_failure') { $streams = @(@{ ended = $false; task = [Threading.Tasks.Task[int]]::FromResult(1024); count = 262144; buffer = [byte[]]::new(1024) }) }
        if ($kind -ceq 'pipe_pending') { $streams = @(@{ ended = $false; task = [Threading.Tasks.TaskCompletionSource[int]]::new().Task }) }
        $owner = @{ assigned = $kind -cne 'unassigned'; job = $job; process = $process; streams = $streams }
        if ($kind -ceq 'valid') {
            if ((Complete-HpmDaemonOwnedNaturalExit $owner) -ne $true -or ($script:naturalCalls -join ',') -cne 'empty,job_dispose,process_dispose') { throw 'natural_order_failed' }
        } else {
            try { Complete-HpmDaemonOwnedNaturalExit $owner | Out-Null; throw 'missing_natural_failure' } catch { if ($_.Exception.Message -cne 'daemon_natural_exit_failed') { throw 'wrong_natural_failure' } }
            if (($script:naturalCalls -join ',') -match 'dispose') { throw 'natural_failure_disposed_owner' }
        }
    }
}

[Console]::Out.WriteLine('naturalExitCases=7; daemonExecutions=0; networkRequests=0')
