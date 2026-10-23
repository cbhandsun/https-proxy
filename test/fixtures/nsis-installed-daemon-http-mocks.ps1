$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$module = Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-installed-daemon-http.psm1') -PassThru -Force
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-encrypted-lifecycle.psm1') -Force
$sha = 'a' * 64
$valid = [ordered]@{ schemaVersion = 1; caseId = 'daemon-http-settings-matrix'; phase = 'current_pre_rollback'; scope = 'installed_daemon_management_http'; manifestSha256 = $sha; dependencyIdentity = 'lock_only'; modelRequests = 0; restartRetention = $false; clientQualified = $false; gracefulDrainQualified = $false; controllerClosed = $true; cleanupSemantics = 'forced_cleanup'; combinations = @('00','01','10','11') | ForEach-Object { @{ combination = $_; checks = @('config_saved','application_observed','storage_verified','owned_stop_acknowledged') } } }
$json = $valid | ConvertTo-Json -Depth 8 -Compress
$parsed = ConvertFrom-HpmInstalledDaemonHttpReceipt $json $sha
if ($parsed.combinations.Count -ne 4 -or -not $parsed.controllerClosed) { throw 'normal_failed' }
$refused = 0
function Refuse([scriptblock]$Work) {
    $rejected = $false
    try { & $Work | Out-Null } catch { if ($_.Exception.Message -match 'PRIVATE_UNTRUSTED_CONTENT') { throw 'unsafe_error' }; $rejected = $true }
    if (-not $rejected) { throw 'expected_rejection' }
    $script:refused++
}
foreach ($inputJson in @('', '{}', 'null', '[]', ('x' * 4097), ('{"schemaVersion":1,' + $json.Substring(1)), $json.Replace('"combination":"11"','"combination":"10"'), $json.Replace('"checks":[','"checks":[],"checks":['), $json.Replace('"00"','"PRIVATE_UNTRUSTED_CONTENT"'))) { Refuse { ConvertFrom-HpmInstalledDaemonHttpReceipt $inputJson $sha } }
foreach ($field in @('schemaVersion','caseId','phase','scope','manifestSha256','dependencyIdentity','modelRequests','restartRetention','clientQualified','gracefulDrainQualified','controllerClosed','cleanupSemantics','combinations')) {
    $copy = $json | ConvertFrom-Json
    $copy.$field = 'PRIVATE_UNTRUSTED_CONTENT'
    Refuse { ConvertFrom-HpmInstalledDaemonHttpReceipt ($copy | ConvertTo-Json -Depth 8 -Compress) $sha }
}
Refuse { ConvertFrom-HpmInstalledDaemonHttpReceipt $json ('b' * 64) }
$copy = $json | ConvertFrom-Json
$copy | Add-Member -NotePropertyName extra -NotePropertyValue 'PRIVATE_UNTRUSTED_CONTENT'
Refuse { ConvertFrom-HpmInstalledDaemonHttpReceipt ($copy | ConvertTo-Json -Depth 8 -Compress) $sha }
# Genuine runner isolation check, no environment spoofing and no product execution.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') { Refuse { Invoke-HpmInstalledDaemonHttpMatrix 'invalid' 'invalid' $sha } }

$events = [Collections.Generic.List[string]]::new()
$operations = @{
    Install = { param($phase) $events.Add('install:' + $phase) }; Stop = { $events.Add('stop') }
    Inspect = { param($phase) if ($phase -eq 'baseline') { 'a' * 64 } else { 'b' * 64 } }
    Seed = { param($role) $events.Add('seed:' + $role) }
    Read = { param($phase, $role, $operation) $events.Add('read:' + $phase + ':' + $role + ':' + $operation) }
    RefuseLegacy = { $events.Add('refuse-legacy') }
    CheckFixtures = { $events.Add('fixtures') }
    RuntimeBoundaries = { $events.Add('module-matrix'); $events.Add('http-matrix'); ConvertFrom-HpmInstalledDaemonHttpReceipt '{}' $sha | Out-Null }
    Uninstall = { $events.Add('uninstall') }; CheckRemoved = { $events.Add('removed') }
}
Refuse { Invoke-HpmEncryptedLifecycleSequence $operations }
if (@($events | Where-Object { $_ -eq 'install:baseline' }).Count -ne 1 -or $events.Contains('uninstall') -or -not $events.Contains('http-matrix')) { throw 'sequence_failed' }
$expected = 'install:baseline,stop,seed:legacy,install:current,stop,refuse-legacy,seed:anchored,read:current:anchored:read,read:current:anchored:resave,fixtures,module-matrix,http-matrix'
if (($events -join ',') -cne $expected) { throw 'http_matrix_lifecycle_order_failed' }

# AST checks bind fixed ownership/clock/dispatch constraints without executing an installer or daemon.
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../scripts/lib/nsis-installed-daemon-http.psm1'))
if ($source.IndexOf('$job.Assign($process)') -ge $source.IndexOf("`$process.StandardInput.Write('1')") -or $source -notmatch 'ElapsedMilliseconds -ge 240000' -or $source -notmatch 'StopAndWait\(5000\)' -or $source -match 'Get-Process|Stop-Process') { throw 'ownership_contract_failed' }
$runner = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../scripts/lib/nsis-lifecycle-runner.psm1'))
if ($runner -notmatch '\$encryptedState.httpMatrix = Invoke-HpmInstalledDaemonHttpMatrix \$root \$installDir \$manifestHashes.current' -or $runner -notmatch 'NSIS_DAEMON_HTTP=' -or $runner -notmatch 'httpMatrix.*') { throw 'composition_missing' }

$environmentProbe = [Diagnostics.ProcessStartInfo]::new()
foreach ($key in @('NODE_OPTIONS','node_path','Node_V8_Coverage','PROXY_CONFIG_DIR','proxy_extra','MGMT_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY','HPM_DAEMON_OWNED_ROOT','HPM_NSIS_BOUNDARY_START_GATE')) { $environmentProbe.Environment[$key] = 'PRIVATE_UNTRUSTED_CONTENT' }
$environmentRoot = Join-Path ([IO.Path]::GetTempPath()) 'http-environment-unit'
& $module { param($start, $root) Set-HpmInstalledHttpDriverEnvironment $start $root } $environmentProbe $environmentRoot
$allowed = @('SystemRoot','WINDIR','PATH','PATHEXT','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','PROXY_CONFIG_DIR','PROXY_RUNTIME_DIR')
foreach ($key in $environmentProbe.Environment.Keys) {
    if ($key -cnotin $allowed -or $environmentProbe.Environment[$key] -ceq 'PRIVATE_UNTRUSTED_CONTENT') { throw 'inherited_environment_leaked' }
}
foreach ($pair in @(@('HOME','home'),@('USERPROFILE','home'),@('APPDATA','appdata'),@('LOCALAPPDATA','localappdata'),@('TEMP','tmp'),@('TMP','tmp'),@('PROXY_CONFIG_DIR','config'),@('PROXY_RUNTIME_DIR','runtime'))) { if ($environmentProbe.Environment[$pair[0]] -cne (Join-Path $environmentRoot $pair[1])) { throw 'environment_isolation_failed' } }

# Execute the actual bounded orchestration and finally logic with owned resource
# doubles. No Process.Start, Job API or environment mutation occurs in this test.
foreach ($mode in @('normal','start_false','assign_failed','gate_failed','stdout_limit','stderr_limit','invalid_utf8','deadline','exit_failed','pipe_failed','cleanup_failed','assign_and_cleanup_failed','wait_failed','resources_failed')) {
    $trace = [Collections.Generic.List[string]]::new()
    $stdout = if ($mode -eq 'stdout_limit') { [byte[]]::new(4097) } elseif ($mode -eq 'invalid_utf8') { [byte[]]@(255) } else { [Text.Encoding]::UTF8.GetBytes($json) }
    $stderr = [byte[]]::new(0)
    if ($mode -eq 'stderr_limit') { $stderr = [byte[]]::new(4097) }
    $outStream = [IO.MemoryStream]::new($stdout, $false)
    $errStream = [IO.MemoryStream]::new($stderr, $false)
    if ($mode -eq 'pipe_failed') { $outStream.Dispose() }
    $inputStream = [pscustomobject]@{}
    $inputStream | Add-Member ScriptMethod Write { param($value) $trace.Add('gate'); if ($mode -eq 'gate_failed') { throw 'PRIVATE_UNTRUSTED_CONTENT' }; if ($value -cne '1') { throw 'gate_value_failed' } }.GetNewClosure()
    $inputStream | Add-Member ScriptMethod Close { $trace.Add('stdin_close') }.GetNewClosure()
    $process = [pscustomobject]@{ StandardInput = $inputStream; StandardOutput = [pscustomobject]@{ BaseStream = $outStream }; StandardError = [pscustomobject]@{ BaseStream = $errStream }; HasExited = ($mode -notin @('assign_failed','assign_and_cleanup_failed')); ExitCode = $(if ($mode -eq 'exit_failed') { 1 } else { 0 }) }
    $process | Add-Member ScriptMethod Start { $trace.Add('start'); return $mode -ne 'start_false' }.GetNewClosure()
    $process | Add-Member ScriptMethod Kill { param($tree) if (-not $tree) { throw 'tree_required' }; $trace.Add('kill_owned'); $this.HasExited = $true }.GetNewClosure()
    $process | Add-Member ScriptMethod WaitForExit { param($milliseconds) if ($milliseconds -ne 5000) { throw 'wait_changed' }; $trace.Add('wait'); return $mode -ne 'wait_failed' }.GetNewClosure()
    $process | Add-Member ScriptMethod Dispose { $trace.Add('process_dispose') }.GetNewClosure()
    $job = [pscustomobject]@{}
    $job | Add-Member ScriptMethod Assign { param($child) $trace.Add('assign'); if ($mode -in @('assign_failed','assign_and_cleanup_failed')) { throw 'PRIVATE_UNTRUSTED_CONTENT' } }.GetNewClosure()
    $job | Add-Member ScriptMethod StopAndWait { param($milliseconds) if ($milliseconds -ne 5000) { throw 'job_wait_changed' }; $trace.Add('job_stop'); if ($mode -in @('cleanup_failed','assign_and_cleanup_failed')) { throw 'PRIVATE_UNTRUSTED_CONTENT' } }.GetNewClosure()
    $job | Add-Member ScriptMethod Dispose { $trace.Add('job_dispose') }.GetNewClosure()
    $resources = @{ process = $process; job = $job; clock = [pscustomobject]@{ ElapsedMilliseconds = $(if ($mode -eq 'deadline') { 240000 } else { 0 }) } }
    & $module {
        param($resources, $mode)
        $script:mockResources = $resources; $script:mockMode = $mode
        function script:New-HpmInstalledHttpProcessResources { param($StartInfo) if ($script:mockMode -eq 'resources_failed') { throw 'PRIVATE_UNTRUSTED_CONTENT' }; return $script:mockResources }
    } $resources $mode
    $errorMessage = $null
    try { $output = & $module { Invoke-HpmInstalledHttpDriverProcess ([Diagnostics.ProcessStartInfo]::new()) }; if ($mode -ne 'normal' -or $output -cne $json) { throw 'mock_expected_failure' } } catch { $errorMessage = $_.Exception.Message }
    if ($mode -eq 'normal') { if ($errorMessage) { throw ('normal_process_mock_failed:' + $errorMessage) } }
    else {
        if ($errorMessage -cnotmatch '\Ainstalled_daemon_http_process_failed:cause=(resources_failed|start_failed|job_assign_failed|gate_release_failed|deadline|pipe_failed|output_limit|exit_failed|output_invalid|none);cleanup=(failed|confirmed)\z') { throw ('unexpected_process_mock_result:' + $mode) }
        if ($mode -eq 'assign_and_cleanup_failed' -and $errorMessage -cne 'installed_daemon_http_process_failed:cause=job_assign_failed;cleanup=failed') { throw 'primary_failure_lost' }
        $refused++
    }
    if ($mode -ne 'resources_failed') {
        if (-not $trace.Contains('job_stop') -or -not $trace.Contains('job_dispose') -or -not $trace.Contains('process_dispose')) { throw 'cleanup_not_executed' }
        if ($mode -in @('assign_failed','assign_and_cleanup_failed') -and (-not $trace.Contains('kill_owned') -or -not $trace.Contains('wait') -or $trace.Contains('gate'))) { throw 'unassigned_process_leak' }
        if ($trace.Contains('gate') -and $trace.IndexOf('assign') -ge $trace.IndexOf('gate')) { throw 'gate_before_job' }
    }
    $outStream.Dispose(); $errStream.Dispose()
}
Write-Output ('installedHttpRefusals=' + $refused + '; installerExecutions=0; daemonExecutions=0; modelRequests=0')
