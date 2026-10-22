Set-StrictMode -Version Latest
$httpBoundaryModule = Import-Module (Join-Path $PSScriptRoot 'nsis-runtime-boundary.psm1') -PassThru

function ConvertFrom-HpmInstalledDaemonHttpReceipt {
    param([string]$Output, [string]$ManifestSha256)
    $document = $null
    try {
        if ($ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or [string]::IsNullOrEmpty($Output) -or [Text.UTF8Encoding]::new($false, $true).GetByteCount($Output) -gt 4096) { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse($Output)
        $root = $document.RootElement
        $names = @($root.EnumerateObject() | ForEach-Object { $_.Name })
        $expected = @('caseId', 'cleanupSemantics', 'clientQualified', 'combinations', 'controllerClosed', 'dependencyIdentity', 'gracefulDrainQualified', 'manifestSha256', 'modelRequests', 'phase', 'restartRetention', 'schemaVersion', 'scope')
        if ($names.Count -ne $expected.Count -or ($names | Sort-Object) -join ',' -cne ($expected -join ',')) { throw 'invalid' }
        if ($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or $root.GetProperty('caseId').GetString() -cne 'daemon-http-settings-matrix' -or $root.GetProperty('phase').GetString() -cne 'current_pre_rollback' -or $root.GetProperty('scope').GetString() -cne 'installed_daemon_management_http' -or $root.GetProperty('manifestSha256').GetString() -cne $ManifestSha256 -or $root.GetProperty('dependencyIdentity').GetString() -cne 'lock_only' -or $root.GetProperty('modelRequests').GetInt32() -ne 0 -or -not $root.GetProperty('controllerClosed').GetBoolean() -or $root.GetProperty('cleanupSemantics').GetString() -cne 'forced_cleanup') { throw 'invalid' }
        foreach ($name in @('restartRetention', 'clientQualified', 'gracefulDrainQualified')) { if ($root.GetProperty($name).GetBoolean()) { throw 'invalid' } }
        $cases = $root.GetProperty('combinations')
        $labels = @('00', '01', '10', '11')
        $checks = @('config_saved', 'application_observed', 'storage_verified', 'owned_stop_acknowledged')
        if ($cases.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $cases.GetArrayLength() -ne 4) { throw 'invalid' }
        $normalized = @()
        for ($index = 0; $index -lt 4; $index++) {
            $item = $cases[$index]
            $fields = @($item.EnumerateObject() | ForEach-Object { $_.Name })
            if ($fields.Count -ne 2 -or ($fields | Sort-Object) -join ',' -cne 'checks,combination' -or $item.GetProperty('combination').GetString() -cne $labels[$index]) { throw 'invalid' }
            $items = $item.GetProperty('checks')
            if ($items.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $items.GetArrayLength() -ne 4) { throw 'invalid' }
            for ($c = 0; $c -lt 4; $c++) { if ($items[$c].GetString() -cne $checks[$c]) { throw 'invalid' } }
            $normalized += [pscustomobject]@{ combination = $labels[$index]; checks = $checks }
        }
        return [pscustomobject]@{ schemaVersion = 1; caseId = 'daemon-http-settings-matrix'; phase = 'current_pre_rollback'; scope = 'installed_daemon_management_http'; manifestSha256 = $ManifestSha256; dependencyIdentity = 'lock_only'; modelRequests = 0; restartRetention = $false; clientQualified = $false; gracefulDrainQualified = $false; controllerClosed = $true; cleanupSemantics = 'forced_cleanup'; combinations = $normalized }
    } catch { throw 'installed_daemon_http_receipt_rejected' } finally { if ($null -ne $document) { $document.Dispose() } }
}

function New-HpmInstalledHttpProcessResources {
    param([Diagnostics.ProcessStartInfo]$StartInfo)
    if (-not ('HpmRuntimeBoundaryJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'nsis-runtime-boundary-job.cs') -ErrorAction Stop }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $StartInfo
    try { $job = [HpmRuntimeBoundaryJob]::new() } catch { $process.Dispose(); throw 'installed_daemon_http_resources_failed' }
    return @{ process = $process; job = $job; clock = [Diagnostics.Stopwatch]::StartNew() }
}

# Private resource factory permits executed failure-path mocks, never CLI injection.
# Fixed 240s orchestration envelope; do not widen the separate 120s module runner.
function Invoke-HpmInstalledHttpDriverProcess {
    param([Diagnostics.ProcessStartInfo]$StartInfo)
    $process = $null
    $job = $null
    $started = $false
    $assigned = $false
    $failure = $null
    $cleanupFailure = $false
    $stage = 'resources_failed'
    $memory = [IO.MemoryStream]::new()
    try {
        $resources = New-HpmInstalledHttpProcessResources $StartInfo
        $process = $resources.process; $job = $resources.job; $clock = $resources.clock
        $stage = 'start_failed'
        if (-not $process.Start()) { throw 'invalid' }
        $started = $true
        $stage = 'job_assign_failed'
        $job.Assign($process)
        $assigned = $true
        $stage = 'gate_release_failed'
        $process.StandardInput.Write('1')
        $process.StandardInput.Close()
        $stage = 'pipe_failed'
        $streams = @(
            @{ stream = $process.StandardOutput.BaseStream; buffer = [byte[]]::new(1024); count = 0; ended = $false; task = $null; output = $true },
            @{ stream = $process.StandardError.BaseStream; buffer = [byte[]]::new(1024); count = 0; ended = $false; task = $null; output = $false }
        )
        foreach ($item in $streams) { $item.task = $item.stream.ReadAsync($item.buffer, 0, $item.buffer.Length) }
        do {
            $stage = 'deadline'
            if ($clock.ElapsedMilliseconds -ge 240000) { throw 'invalid' }
            $stage = 'pipe_failed'
            foreach ($item in $streams) {
                if (-not $item.ended -and $item.task.IsCompleted) {
                    $count = $item.task.GetAwaiter().GetResult()
                    $item.count += $count
                    $stage = 'output_limit'
                    if ($item.count -gt 4096) { throw 'invalid' }
                    $stage = 'pipe_failed'
                    if ($count -eq 0) { $item.ended = $true } else {
                        if ($item.output) { $memory.Write($item.buffer, 0, $count) }
                        $item.task = $item.stream.ReadAsync($item.buffer, 0, $item.buffer.Length)
                    }
                }
            }
            if ($process.HasExited -and $streams[0].ended -and $streams[1].ended) { break }
            [Threading.Thread]::Sleep(10)
        } while ($true)
        $stage = 'exit_failed'
        if ($process.ExitCode -ne 0) { throw 'invalid' }
        $stage = 'output_invalid'
        $result = [Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray())
    } catch { $failure = $stage } finally {
        # Only this owned Job can be terminated. Product/controller stderr is discarded.
        if ($null -ne $job) {
            try { $job.StopAndWait(5000) } catch { $cleanupFailure = $true } finally { try { $job.Dispose() } catch { $cleanupFailure = $true } }
        }
        if ($started) {
            try {
                # Before assignment the fixed driver is still gated. Terminate
                # only the Process object this function successfully started.
                if (-not $assigned -and -not $process.HasExited) { $process.Kill($true) }
                if (-not $process.WaitForExit(5000)) { $cleanupFailure = $true }
            } catch { $cleanupFailure = $true }
        }
        $memory.Dispose()
        if ($null -ne $process) { try { $process.Dispose() } catch { $cleanupFailure = $true } }
    }
    if ($failure -or $cleanupFailure) {
        if (-not $failure) { $failure = 'none' }
        $cleanup = if ($cleanupFailure) { 'failed' } else { 'confirmed' }
        throw ('installed_daemon_http_process_failed:cause=' + $failure + ';cleanup=' + $cleanup)
    }
    return $result
}

function Set-HpmInstalledHttpDriverEnvironment {
    param([Diagnostics.ProcessStartInfo]$StartInfo, [string]$CaseRoot)
    # An allowlist removes case variants of Node/PROXY injection and inherited
    # provider credentials. This helper mutates only the unstarted child object.
    $StartInfo.Environment.Clear()
    foreach ($key in @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($value) { $StartInfo.Environment[$key] = $value }
    }
    foreach ($key in @('HOME', 'USERPROFILE')) { $StartInfo.Environment[$key] = Join-Path $CaseRoot 'home' }
    $StartInfo.Environment['APPDATA'] = Join-Path $CaseRoot 'appdata'
    $StartInfo.Environment['LOCALAPPDATA'] = Join-Path $CaseRoot 'localappdata'
    foreach ($key in @('TEMP', 'TMP')) { $StartInfo.Environment[$key] = Join-Path $CaseRoot 'tmp' }
    $StartInfo.Environment['PROXY_CONFIG_DIR'] = Join-Path $CaseRoot 'config'
    $StartInfo.Environment['PROXY_RUNTIME_DIR'] = Join-Path $CaseRoot 'runtime'
}

function Invoke-HpmInstalledDaemonHttpMatrix {
    param([string]$OwnedRoot, [string]$InstallDirectory, [string]$ManifestSha256)
    try {
        $ErrorActionPreference = 'Stop'
        # Standalone calls cannot silently turn this into workstation acceptance.
        & $httpBoundaryModule { Assert-HpmLifecycleIsolation @{ GITHUB_ACTIONS = $env:GITHUB_ACTIONS; RUNNER_ENVIRONMENT = $env:RUNNER_ENVIRONMENT; RUNNER_OS = $env:RUNNER_OS } $false $false; Assert-HpmLifecycleArtifactPath $env:RUNNER_TEMP $args[0] 'Container' } $OwnedRoot
        $node = & $httpBoundaryModule { param($root, $install, $sha) Get-HpmRuntimeBoundaryNode $root $install $sha } $OwnedRoot $InstallDirectory $ManifestSha256
        $driver = Join-Path $PSScriptRoot 'nsis-installed-daemon-http.cjs'
        & $httpBoundaryModule { param($driver) Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $driver 'Leaf' } $driver
        $pwsh = Join-Path $PSHOME 'pwsh.exe'
        & $httpBoundaryModule { param($pwsh) Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($pwsh)) $pwsh 'Leaf' } $pwsh
        $caseRoot = Join-Path $OwnedRoot ('http-executor-' + [Guid]::NewGuid().ToString('N'))
        & $httpBoundaryModule { param($root, $child) Assert-HpmLifecycleChildPath $root $child } $OwnedRoot $caseRoot
        New-Item -ItemType Directory -Path $caseRoot -ErrorAction Stop | Out-Null
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $node
        $start.WorkingDirectory = $InstallDirectory
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
        foreach ($name in @('home', 'appdata', 'localappdata', 'tmp', 'config', 'runtime')) { New-Item -ItemType Directory -Path (Join-Path $caseRoot $name) -ErrorAction Stop | Out-Null }
        Set-HpmInstalledHttpDriverEnvironment $start $caseRoot
        foreach ($argument in @($driver, $OwnedRoot, $InstallDirectory, $caseRoot, $ManifestSha256, $pwsh)) { $start.ArgumentList.Add($argument) }
        $output = Invoke-HpmInstalledHttpDriverProcess $start
        return ConvertFrom-HpmInstalledDaemonHttpReceipt $output $ManifestSha256
    } catch {
        if ($_.Exception.Message -cmatch '\Ainstalled_daemon_http_process_failed:cause=(resources_failed|start_failed|job_assign_failed|gate_release_failed|deadline|pipe_failed|output_limit|exit_failed|output_invalid|none);cleanup=(failed|confirmed)\z') { throw $_.Exception.Message }
        throw 'installed_daemon_http_failed'
    }
}
Export-ModuleMember -Function ConvertFrom-HpmInstalledDaemonHttpReceipt, Invoke-HpmInstalledDaemonHttpMatrix
