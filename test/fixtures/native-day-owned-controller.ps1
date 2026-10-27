param([string]$Repo, [string]$Node, [string]$Root, [string]$Assembly, [string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -Path $Assembly -ErrorAction Stop
Import-Module (Join-Path $Repo 'scripts/lib/context-recovery-native-day-child.psm1') -ErrorAction Stop
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $Node
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.Environment['HPM_NATIVE_DAY_OWNED_JOB'] = '1'
foreach ($argument in @((Join-Path $Repo 'test/fixtures/native-day-owned-child.cjs'), (Join-Path $Repo 'scripts/lib/context-recovery-native-day-start.js'), $Root, $Mode)) {
    [void]$info.ArgumentList.Add($argument)
}
$lease = Start-HpmNativeDayChild $info
$p = $lease.Process
if ($Mode -ceq 'success') {
    if (-not $p.WaitForExit(5000) -or $p.ExitCode -ne 0) { throw 'success_child_failed' }
} else {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath (Join-Path $Root 'owned-tree.json'))) {
        if ($clock.ElapsedMilliseconds -ge 5000 -or $p.HasExited) { throw 'tree_not_ready' }
        [Threading.Thread]::Sleep(10)
    }
    if ($Mode -ceq 'controller-kill') {
        [Console]::Out.WriteLine('owned_controller_ready')
        while ($true) { [Threading.Thread]::Sleep(100) }
    }
    # Cleanup must use its unforgeable resource, not this mutable public field.
    $lease.Process = [Diagnostics.Process]::GetCurrentProcess()
}
$rejected = $false
try { Close-HpmNativeDayChild ([pscustomobject]@{ Process = [Diagnostics.Process]::GetCurrentProcess() }) } catch { $rejected = $true }
if (-not $rejected) { throw 'forged_lease_accepted' }
if ($Mode -ceq 'natural-leak') {
    $rejected = $false
    try { Close-HpmNativeDayChild $lease -RequireNaturalExit } catch { $rejected = $true }
    if (-not $rejected) { throw 'live_descendant_received_natural_exit_credit' }
    $rejected = $false
    try { Close-HpmNativeDayChild $lease } catch { $rejected = $true }
    if (-not $rejected) { throw 'cleanup_failure_not_retained' }
} else {
    Close-HpmNativeDayChild $lease -RequireNaturalExit:($Mode -ceq 'success')
    Close-HpmNativeDayChild $lease
    if ($Mode -ceq 'explicit-close') {
        $rejected = $false
        try { Close-HpmNativeDayChild $lease -RequireNaturalExit } catch { $rejected = $true }
        if (-not $rejected) { throw 'forced_cleanup_upgraded_to_natural_exit' }
    }
}
[Console]::Out.WriteLine('owned_child_cleanup_passed')
