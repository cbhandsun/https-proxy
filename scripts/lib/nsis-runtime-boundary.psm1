Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')

function ConvertFrom-HpmRuntimeBoundaryResult {
    param([string]$Output, [string]$CaseId, [string]$ManifestSha256)
    $document = $null
    try {
        if ([string]::IsNullOrEmpty($Output) -or $Output.Length -gt 4096 -or [Text.UTF8Encoding]::new($false, $true).GetByteCount($Output) -gt 4096) { throw 'invalid' }
        if ($CaseId -cnotin @('defaults-migration', 'initialization-failure', 'reopen-clear') -or $ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse($Output)
        $root = $document.RootElement
        if ($root.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'invalid' }
        $names = @($root.EnumerateObject() | ForEach-Object { $_.Name })
        if ($names.Count -ne 7 -or ($names | Sort-Object) -join ',' -cne 'caseId,checks,complete,dependencyIdentity,manifestSha256,schemaVersion,scope') { throw 'invalid' }
        if ($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or $root.GetProperty('caseId').GetString() -cne $CaseId -or $root.GetProperty('manifestSha256').GetString() -cne $ManifestSha256 -or $root.GetProperty('scope').GetString() -cne 'installed_module_api' -or $root.GetProperty('dependencyIdentity').GetString() -cne 'lock_only') { throw 'invalid' }
        $expectedComplete = $CaseId -cne 'defaults-migration'
        if ($root.GetProperty('complete').GetBoolean() -ne $expectedComplete) { throw 'invalid' }
        $expected = if ($CaseId -ceq 'reopen-clear') { @('persistent_runtime_read', 'principal_revoke_acknowledged', 'principal_reopen_denied', 'clear_acknowledged', 'clear_reopen_denied', 'all_owners_closed') } elseif ($CaseId -ceq 'initialization-failure') { @('storage_directory_blocked', 'initialization_failed_closed', 'reenable_rejected', 'shutdown_failure_acknowledged') } else { @('empty_config_directory', 'default_policy_disabled', 'runtime_disabled', 'shutdown_acknowledged') }
        $array = $root.GetProperty('checks')
        if ($array.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $array.GetArrayLength() -ne $expected.Count) { throw 'invalid' }
        for ($index = 0; $index -lt $expected.Count; $index++) { if ($array[$index].GetString() -cne $expected[$index]) { throw 'invalid' } }
        return [pscustomobject]@{ schemaVersion = 1; caseId = $CaseId; manifestSha256 = $ManifestSha256; scope = 'installed_module_api'; complete = $expectedComplete; dependencyIdentity = 'lock_only'; checks = $expected }
    } catch { throw 'Runtime boundary result rejected.' } finally { if ($null -ne $document) { $document.Dispose() } }
}

function ConvertFrom-HpmOwnedFailurePhase {
    param([byte[]]$Bytes)
    # Optional finite diagnostics only. Invalid input yields no disclosure, and
    # the caller still rejects the failed child regardless of this result.
    if ($null -eq $Bytes -or $Bytes.Length -gt 80) { return $null }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes) } catch { return $null }
    if ($text -cnotmatch '\An09_owned_entry_rejected\nn09_primary_phase=([0-9]{2}|10[1-9]|11[0-9]|12[0-6])\n\z') { return $null }
    $phase = [int]$Matches[1]
    if (($phase -ge 73 -and $phase -le 84) -or ($phase -ge 86 -and $phase -le 96) -or ($phase -ge 101 -and $phase -le 126)) { return $phase }
    return $null
}

function Invoke-HpmBoundedRuntimeChild {
    param([Diagnostics.ProcessStartInfo]$StartInfo, [ValidateRange(100, 120000)][int]$TimeoutMilliseconds = 120000)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $StartInfo
    $job = $null
    $started = $false
    $failure = $false
    $memory = [IO.MemoryStream]::new()
    $diagnosticMemory = [IO.MemoryStream]::new()
    $boundaryStage = 'job_type'
    try {
        if (-not ('HpmRuntimeBoundaryJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'nsis-runtime-boundary-job.cs') -ErrorAction Stop }
        $boundaryStage = 'job_create'
        $job = [HpmRuntimeBoundaryJob]::new()
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $boundaryStage = 'process_start'
        # The assignment grant is exactly one ASCII byte. Do not inherit a
        # caller/console UTF-8 preamble that the fixed child must reject.
        $StartInfo.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
        if (-not $process.Start()) { throw 'invalid' }
        $started = $true
        $boundaryStage = 'job_assign'
        $job.Assign($process)
        # The child must not execute product code or spawn before job assignment.
        $boundaryStage = 'stdin_grant'
        $process.StandardInput.Write('1')
        $process.StandardInput.Close()
        $boundaryStage = 'pipe_drain'
        $streams = @(
            @{ stream = $process.StandardOutput.BaseStream; buffer = [byte[]]::new(1024); count = 0; ended = $false; task = $null; output = $true },
            @{ stream = $process.StandardError.BaseStream; buffer = [byte[]]::new(1024); count = 0; ended = $false; task = $null; output = $false }
        )
        foreach ($item in $streams) { $item.task = $item.stream.ReadAsync($item.buffer, 0, $item.buffer.Length) }
        do {
            if ($clock.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
                $boundaryStage = 'deadline'
                throw 'invalid'
            }
            foreach ($item in $streams) {
                if (-not $item.ended -and $item.task.IsCompleted) {
                    $count = $item.task.GetAwaiter().GetResult()
                    $item.count += $count
                    if ($item.count -gt 4096) {
                        $boundaryStage = 'output_limit'
                        throw 'invalid'
                    }
                    if ($count -eq 0) { $item.ended = $true } else {
                        if ($item.output) { $memory.Write($item.buffer, 0, $count) }
                        else { $diagnosticMemory.Write($item.buffer, 0, $count) }
                        $item.task = $item.stream.ReadAsync($item.buffer, 0, $item.buffer.Length)
                    }
                }
            }
            if ($process.HasExited -and $streams[0].ended -and $streams[1].ended) { break }
            [Threading.Thread]::Sleep(10)
        } while ($true)
        $boundaryStage = 'child_exit'
        if ($process.ExitCode -ne 0) {
            # Only the fixed hosted entry phase codes are disclosed. Other
            # exits and all stderr remain opaque; no child data is forwarded.
            $childExitCode = 'other'
            if (($process.ExitCode -ge 64 -and $process.ExitCode -le 84) -or ($process.ExitCode -ge 86 -and $process.ExitCode -le 96) -or ($process.ExitCode -ge 98 -and $process.ExitCode -le 126)) {
                $childExitCode = [string]$process.ExitCode
            }
            Write-Information ('hpm_runtime_child_exit_code=' + $childExitCode) -InformationAction Continue
            if ($process.ExitCode -ge 98 -and $process.ExitCode -le 100) {
                $primaryPhase = ConvertFrom-HpmOwnedFailurePhase $diagnosticMemory.ToArray()
                if ($null -ne $primaryPhase) {
                    Write-Information ('hpm_runtime_child_primary_phase=' + $primaryPhase) -InformationAction Continue
                }
            }
            throw 'invalid'
        }
        $boundaryStage = 'stdout_decode'
        $result = [Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray())
    } catch {
        $failure = $true
        Write-Information ('hpm_runtime_child_failed_stage=' + $boundaryStage) -InformationAction Continue
    } finally {
        # Job closure kills the entire owned tree even when the parent exited
        # while a descendant retained a pipe. No arbitrary PID is ever killed.
        if ($null -ne $job) {
            try { $job.StopAndWait(5000) } catch { $failure = $true } finally { $job.Dispose() }
        }
        if ($started) {
            try {
                if (-not $process.WaitForExit(5000)) { $process.Kill($true); if (-not $process.WaitForExit(5000)) { $failure = $true } }
            } catch { $failure = $true }
        }
        $memory.Dispose()
        $diagnosticMemory.Dispose()
        $process.Dispose()
    }
    if ($failure) { throw 'Runtime boundary child failed.' }
    return $result
}

function Get-HpmRuntimeBoundaryNode {
    param([string]$OwnedRoot, [string]$InstallDirectory, [string]$ManifestSha256)
    $document = $null
    try {
        $node = Join-Path $InstallDirectory 'runtime/node/node.exe'
        $manifest = Join-Path $InstallDirectory 'release-runtime-manifest.json'
        Assert-HpmLifecycleArtifactPath $OwnedRoot $node 'Leaf'
        Assert-HpmLifecycleArtifactPath $OwnedRoot $manifest 'Leaf'
        if ((Get-Item -LiteralPath $node -ErrorAction Stop).Length -gt 268435456 -or (Get-Item -LiteralPath $manifest -ErrorAction Stop).Length -gt 4194304) { throw 'invalid' }
        if ((Get-FileHash -LiteralPath $manifest -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -cne $ManifestSha256) { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($manifest))
        if ($document.RootElement.GetProperty('schemaVersion').GetInt32() -ne 2) { throw 'invalid' }
        $nodeSha = $document.RootElement.GetProperty('nodeSha256').GetString()
        if ($nodeSha -cnotmatch '\A[a-f0-9]{64}\z' -or (Get-FileHash -LiteralPath $node -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -cne $nodeSha) { throw 'invalid' }
        return $node
    } catch { throw 'Runtime boundary payload rejected.' } finally { if ($null -ne $document) { $document.Dispose() } }
}

function Invoke-HpmInstalledRuntimeBoundary {
    param([string]$OwnedRoot, [string]$InstallDirectory, [string]$ManifestSha256, [ValidateSet('defaults-migration', 'initialization-failure', 'reopen-clear')][string]$CaseId)
    try {
        $ErrorActionPreference = 'Stop'
        if ($ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or -not [IO.Path]::IsPathFullyQualified($OwnedRoot)) { throw 'invalid' }
        if (-not (Test-Path -LiteralPath $OwnedRoot -PathType Container) -or -not (Test-Path -LiteralPath $InstallDirectory -PathType Container)) { throw 'invalid' }
        Assert-HpmLifecycleChildPath ([IO.Path]::GetPathRoot($OwnedRoot)) $OwnedRoot
        Assert-HpmLifecycleChildPath $OwnedRoot $InstallDirectory
        # Authenticate the executable before it can run, not only from inside
        # that executable after the stdin gate. The driver checks all sources.
        $node = Get-HpmRuntimeBoundaryNode $OwnedRoot $InstallDirectory $ManifestSha256
        $caseRoot = Join-Path $OwnedRoot ('runtime-boundary-' + [Guid]::NewGuid().ToString('N'))
        Assert-HpmLifecycleChildPath $OwnedRoot $caseRoot
        New-Item -ItemType Directory -Path $caseRoot -ErrorAction Stop | Out-Null
        foreach ($name in @('config', 'data')) { New-Item -ItemType Directory -Path (Join-Path $caseRoot $name) -ErrorAction Stop | Out-Null }
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $node
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
        $start.Environment.Remove('NODE_OPTIONS') | Out-Null
        $start.Environment.Remove('NODE_PATH') | Out-Null
        $start.Environment['HPM_NSIS_BOUNDARY_OWNED_ROOT'] = $OwnedRoot
        $start.Environment['HPM_NSIS_BOUNDARY_START_GATE'] = '1'
        foreach ($argument in @((Join-Path $PSScriptRoot 'nsis-installed-runtime-boundary.cjs'), $CaseId, $InstallDirectory, $caseRoot, $ManifestSha256)) { $start.ArgumentList.Add($argument) }
        $output = Invoke-HpmBoundedRuntimeChild $start
        return ConvertFrom-HpmRuntimeBoundaryResult $output $CaseId $ManifestSha256
    } catch { throw 'Installed runtime boundary failed.' }
}

# Hosted N08/N09 callers reuse this exact bounded Job implementation after
# authenticating their fixed executable and arguments; export that shared API.
Export-ModuleMember -Function ConvertFrom-HpmRuntimeBoundaryResult, Invoke-HpmBoundedRuntimeChild, Invoke-HpmInstalledRuntimeBoundary
