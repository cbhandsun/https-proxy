Set-StrictMode -Version Latest
$script:nativeDayChildren = [Runtime.CompilerServices.ConditionalWeakTable[object,object]]::new()

function Start-HpmNativeDayChild {
    param([Diagnostics.ProcessStartInfo]$StartInfo)
    $process = $null
    $job = $null
    $started = $false
    try {
        # Compile and authenticate the existing Job type before invoking this
        # function. No cold compiler runs after the day process starts.
        if (-not ('HpmRuntimeBoundaryJob' -as [type]) -or $null -eq $StartInfo -or
            $StartInfo.UseShellExecute -or -not $StartInfo.CreateNoWindow -or
            -not $StartInfo.RedirectStandardInput -or -not $StartInfo.RedirectStandardOutput -or
            -not $StartInfo.RedirectStandardError -or
            $StartInfo.Environment['HPM_NATIVE_DAY_OWNED_JOB'] -cne '1') { throw 'invalid' }
        $StartInfo.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
        $job = [HpmRuntimeBoundaryJob]::new()
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $StartInfo
        if (-not $process.Start()) { throw 'invalid' }
        $started = $true
        $job.Assign($process)
        # The fixed Node entry reads exactly this byte and EOF before importing
        # product modules or touching storage. A dead controller grants nothing.
        $process.StandardInput.Write('1')
        $process.StandardInput.Close()
        $lease = [pscustomobject]@{ Process = $process }
        $resource = [pscustomobject]@{ Process = $process; Job = $job; Closed = $false; Failed = $false; NaturalVerified = $false }
        $script:nativeDayChildren.Add($lease, $resource)
        return $lease
    } catch {
        if ($null -ne $job) {
            try { $job.StopAndWait(5000) } catch { } finally { $job.Dispose() }
        }
        if ($started) {
            try {
                if (-not $process.HasExited) { $process.Kill($true) }
                [void]$process.WaitForExit(5000)
            } catch { }
        }
        if ($null -ne $process) { $process.Dispose() }
        # Startup is rejected regardless of any secondary cleanup result.
        throw 'Native day owned child failed.'
    }
}

function Close-HpmNativeDayChild {
    param([object]$Lease, [switch]$RequireNaturalExit)
    $resource = $null
    if ($null -eq $Lease -or -not $script:nativeDayChildren.TryGetValue($Lease, [ref]$resource)) {
        throw 'Native day owned child rejected.'
    }
    if ($resource.Closed) {
        if ($resource.Failed -or ($RequireNaturalExit -and -not $resource.NaturalVerified)) { throw 'Native day owned child cleanup failed.' }
        return
    }
    $resource.Closed = $true
    try {
        if ($RequireNaturalExit) {
            try { $resource.Job.WaitForEmpty(5000); $resource.NaturalVerified = $true } catch { $resource.Failed = $true }
        }
        try { $resource.Job.StopAndWait(5000) } catch { $resource.Failed = $true }
        try {
            if (-not $resource.Process.WaitForExit(5000)) { $resource.Failed = $true }
        } catch { $resource.Failed = $true }
    } finally {
        try { $resource.Job.Dispose() } catch { $resource.Failed = $true }
        try { $resource.Process.Dispose() } catch { $resource.Failed = $true }
    }
    if ($resource.Failed) { throw 'Native day owned child cleanup failed.' }
}

Export-ModuleMember -Function Start-HpmNativeDayChild, Close-HpmNativeDayChild
