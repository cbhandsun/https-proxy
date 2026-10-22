Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-runtime-boundary.psm1')

function ConvertFrom-HpmDaemonOwnedFrame {
    param([string]$Frame)
    $document = $null
    try {
        if ([Text.UTF8Encoding]::new($false, $true).GetByteCount($Frame) -gt 2048) { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse($Frame)
        $value = $document.RootElement
        if ($value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'invalid' }
        $names = @($value.EnumerateObject() | ForEach-Object { $_.Name })
        $op = $value.GetProperty('op').GetString()
        $expected = if ($op -ceq 'start') { 'case,id,op,token,v' } else { 'case,id,op,v' }
        if (($names | Sort-Object) -join ',' -cne $expected -or $value.GetProperty('v').GetInt32() -ne 1 -or $op -cnotin @('start', 'status', 'stop')) { throw 'invalid' }
        $id = $value.GetProperty('id').GetInt32()
        $label = $value.GetProperty('case').GetString()
        if ($id -lt 1 -or $id -gt 4096 -or $label -cnotin @('00', '01', '10', '11')) { throw 'invalid' }
        $result = @{ v = 1; id = $id; op = $op; case = $label }
        if ($op -ceq 'start') {
            $token = $value.GetProperty('token').GetString()
            if ($token -cnotmatch '\A[a-zA-Z0-9_-]{32,256}\z') { throw 'invalid' }
            $result.token = $token
        }
        return $result
    } catch { throw 'daemon_protocol_rejected' } finally { if ($null -ne $document) { $document.Dispose() } }
}

function New-HpmDaemonOwnedState {
    return @{ next = 0; lastId = 0; active = $null; blocked = $false; failedCase = $null; startStage = 'setup'; ports = [Collections.Generic.HashSet[int]]::new() }
}

function Invoke-HpmDaemonOwnedRequest {
    param([hashtable]$State, [hashtable]$Request, [hashtable]$Operations)
    if (($State.blocked -and -not ($Request.op -ceq 'stop' -and $Request.case -ceq $State.failedCase)) -or $Request.id -ne $State.lastId + 1) { throw 'daemon_protocol_rejected' }
    $State.lastId = $Request.id
    $labels = @('00', '01', '10', '11')
    if ($Request.op -ceq 'start') {
        if ($null -ne $State.active -or $State.next -ge 4 -or $Request.case -cne $labels[$State.next]) { throw 'daemon_protocol_rejected' }
        try {
            $State.startStage = 'setup'
            # Start must retain partially created owner state for final cleanup.
            $State.active = & $Operations.Start $Request $State
            return @{ v = 1; id = $Request.id; op = 'start'; case = $Request.case; ok = $true; identity = $State.active.identity }
        } catch {
            $State.blocked = $true; $State.failedCase = $Request.case
            $cause = if ($State.startStage -cin @('setup', 'process_start', 'job_assign', 'gate_release')) { $State.startStage } else { 'setup' }
            return @{ v = 1; id = $Request.id; op = 'start'; case = $Request.case; ok = $false; cause = $cause }
        }
    }
    if ($State.blocked -and $Request.op -ceq 'stop' -and $null -eq $State.active) {
        $State.failedCase = $null
        return @{ v = 1; id = $Request.id; op = 'stop'; case = $Request.case; ok = $true; treeEmpty = $true; cleanupSemantics = 'forced_cleanup' }
    }
    if ($null -eq $State.active -or $State.active.label -cne $Request.case) { throw 'daemon_protocol_rejected' }
    if ($Request.op -ceq 'status') {
        $alive = [bool](& $Operations.Alive $State.active)
        # Drain only already-completed reads, including chunks queued at exit.
        if ($State.active.ContainsKey('streams')) { Update-HpmDaemonOwnedPipes $State.active }
        $reply = @{ v = 1; id = $Request.id; op = 'status'; case = $Request.case; ok = $true; alive = $alive; credentialsPrivate = [bool](& $Operations.Credentials $State.active) }
        if ($State.active.ContainsKey('gateMarker')) { $reply.preloadPhase = $State.active.gateMarker.phase }
        return $reply
    }
    if ($Request.op -cne 'stop') { throw 'daemon_protocol_rejected' }
    try {
        if ((& $Operations.Stop $State.active) -ne $true) { throw 'invalid' }
        $State.active = $null
        $State.failedCase = $null
        $State.next++
        return @{ v = 1; id = $Request.id; op = 'stop'; case = $Request.case; ok = $true; treeEmpty = $true; cleanupSemantics = 'forced_cleanup' }
    } catch {
        $State.blocked = $true; $State.failedCase = $Request.case
        return @{ v = 1; id = $Request.id; op = 'stop'; case = $Request.case; ok = $false; cause = 'controller_cleanup' }
    }
}

function Test-HpmDaemonOwnedAcl {
    param([bool]$Protected, [object[]]$Rules, [string]$UserSid)
    if (-not $Protected -or $Rules.Count -eq 0) { return $false }
    $userAllowed = $false
    foreach ($rule in $Rules) {
        if ($rule.type -ceq 'Allow') {
            if ($rule.sid -cnotin @($UserSid, 'S-1-5-18', 'S-1-5-32-544')) { return $false }
            if ($rule.sid -ceq $UserSid -and ($rule.rights -band 1) -ne 0) { $userAllowed = $true }
        }
    }
    return $userAllowed
}

function Test-HpmDaemonOwnedCredentials {
    param([hashtable]$Owner)
    try {
        $directory = $Owner.identity.runtimeDir
        foreach ($file in @($directory, (Join-Path $directory '.mgmt-token'), (Join-Path $directory ('.mgmt-token-' + $Owner.identity.managementPort)))) {
            $kind = if ($file -ceq $directory) { 'Container' } else { 'Leaf' }
            Assert-HpmLifecycleArtifactPath $Owner.ownedRoot $file $kind
            if ($kind -ceq 'Leaf') {
                $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
                if ($item.Length -lt 32 -or $item.Length -gt 256) { return $false }
            }
            $acl = Get-Acl -LiteralPath $file -ErrorAction Stop
            $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType; rights = [int]$_.FileSystemRights } })
            if (-not (Test-HpmDaemonOwnedAcl $acl.AreAccessRulesProtected $rules $Owner.userSid)) { return $false }
        }
        # No credential file is opened or copied; only metadata and DACLs above.
        return $true
    } catch { return $false }
}

function New-HpmDaemonGateMarker {
    return @{ phase = 'unobserved'; index = 0; passed = $true; failed = $true; done = $false }
}

function Update-HpmDaemonGateMarker {
    param([hashtable]$Marker, [byte[]]$Bytes, [int]$Count)
    if ($Count -lt 0 -or $Count -gt $Bytes.Length) { throw 'daemon_protocol_rejected' }
    # Match only the two fixed prefix lines. No raw output, text decoding,
    # scanning for later log matches or unbounded partial buffer is retained.
    $entered = [Text.Encoding]::ASCII.GetBytes("HPM_GATE_ENTERED`n")
    $passed = [Text.Encoding]::ASCII.GetBytes("HPM_GATE_PASSED`n")
    $failed = [Text.Encoding]::ASCII.GetBytes("HPM_GATE_FAILED`n")
    for ($offset = 0; $offset -lt $Count -and -not $Marker.done; $offset++) {
        $value = $Bytes[$offset]
        if ($Marker.phase -ceq 'unobserved') {
            if ($value -ne $entered[$Marker.index]) { $Marker.done = $true; break }
            $Marker.index++
            if ($Marker.index -eq $entered.Length) { $Marker.phase = 'entered'; $Marker.index = 0 }
        } else {
            $Marker.passed = $Marker.passed -and $value -eq $passed[$Marker.index]
            $Marker.failed = $Marker.failed -and $value -eq $failed[$Marker.index]
            $Marker.index++
            if (-not $Marker.passed -and -not $Marker.failed) { $Marker.done = $true }
            elseif ($Marker.index -eq $passed.Length) {
                $Marker.phase = if ($Marker.passed) { 'passed' } else { 'failed' }
                $Marker.done = $true
            }
        }
    }
}

function Update-HpmDaemonOwnedPipes {
    param([hashtable]$Owner)
    foreach ($item in $Owner.streams) {
        while (-not $item.ended -and $item.task.IsCompleted) {
            $count = $item.task.GetAwaiter().GetResult()
            $item.count += $count
            if ($item.count -gt 262144) { throw 'daemon_output_limit' }
            if ($count -eq 0) { $item.ended = $true } else {
                if ($item.ContainsKey('gateMarker')) { Update-HpmDaemonGateMarker $item.gateMarker $item.buffer $count }
                # Product bytes are never decoded, forwarded or retained.
                [Array]::Clear($item.buffer, 0, $item.buffer.Length)
                $item.task = $item.stream.ReadAsync($item.buffer, 0, $item.buffer.Length)
            }
        }
    }
}

function Stop-HpmDaemonOwnedCase {
    param([hashtable]$Owner)
    try {
        if ($Owner.assigned) { $Owner.job.StopAndWait(5000) } else { $Owner.process.StandardInput.Close() }
        if (-not $Owner.process.WaitForExit(5000)) { throw 'invalid' }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            Update-HpmDaemonOwnedPipes $Owner
            if (@($Owner.streams | Where-Object { -not $_.ended }).Count -eq 0) { break }
            if ($clock.ElapsedMilliseconds -ge 5000) { throw 'invalid' }
            [Threading.Thread]::Sleep(10)
        } while ($true)
        if (-not $Owner.assigned) { throw 'invalid' }
        return $true
    } catch { throw 'daemon_cleanup_failed' } finally {
        if ($null -ne $Owner.job) { $Owner.job.Dispose() }
        $Owner.process.Dispose()
    }
}

function New-HpmDaemonOwnedConfig {
    param([int[]]$Ports)
    if ($null -eq $Ports -or $Ports.Count -ne 2 -or $Ports[0] -eq $Ports[1]) { throw 'daemon_port_rejected' }
    foreach ($port in $Ports) { if ($port -lt 1024 -or $port -gt 65535) { throw 'daemon_port_rejected' } }
    return @{
        profiles = @(@{ id = 'hpm-owned-local'; name = 'Owned local acceptance'; protocol = 'openai'; targetUrl = 'http://127.0.0.1:1/v1'; apiKey = '' })
        modelRoutes = @(); activeProfile = 'hpm-owned-local'
        localServer = @{ host = '127.0.0.1'; listenPort = $ports[1]; managementPort = $ports[0]; protocol = 'openai-responses'; basePath = '/v1' }
        entryServers = @(@{ host = '127.0.0.1'; listenPort = $ports[1]; protocol = 'openai-responses'; tls = $false })
        entryAuth = @{ enabled = $true; keys = @() }
        appSettings = @{ contextRecoveryEnabled = $false; contextRecoveryPersistenceEnabled = $false; conversationAuditEnabled = $false; conversationAuditCaptureContent = $false; upstreamWarmupEnabled = $false; antigravityCredentialWatchdogEnabled = $false }
        diagnostics = @{ enabled = $false }
    }
}

function Start-HpmDaemonOwnedCase {
    param([hashtable]$Request, [hashtable]$State, [string]$OwnedRoot, [string]$InstallDirectory, [string]$ManifestSha256, [string]$Node)
    $caseRoot = Join-Path $OwnedRoot ('daemon-http-' + [Guid]::NewGuid().ToString('N'))
    Assert-HpmLifecycleChildPath $OwnedRoot $caseRoot
    New-Item -ItemType Directory -Path $caseRoot -ErrorAction Stop | Out-Null
    foreach ($name in @('config', 'runtime', 'home', 'appdata', 'localappdata', 'tmp')) { New-Item -ItemType Directory -Path (Join-Path $caseRoot $name) -ErrorAction Stop | Out-Null }
    $listeners = @()
    try {
        foreach ($unused in 1..2) {
            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
            $listener.Start()
            $listeners += $listener
        }
        $ports = @($listeners | ForEach-Object { $_.LocalEndpoint.Port })
        foreach ($port in $ports) { if ($port -lt 1024 -or -not $State.ports.Add($port)) { throw 'daemon_port_rejected' } }
    } finally { foreach ($listener in $listeners) { $listener.Stop() } }
    $config = New-HpmDaemonOwnedConfig $ports
    $configFile = Join-Path $caseRoot 'config/proxy.config.json'
    Assert-HpmLifecycleChildPath $OwnedRoot $configFile
    $file = [IO.File]::Open($configFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($config | ConvertTo-Json -Depth 8 -Compress)); $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Node
    $start.WorkingDirectory = $InstallDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $inherited = @{}
    foreach ($key in @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT')) { if ($start.Environment.ContainsKey($key)) { $inherited[$key] = $start.Environment[$key] } }
    $start.Environment.Clear()
    foreach ($key in $inherited.Keys) { $start.Environment[$key] = $inherited[$key] }
    foreach ($pair in @(@('USERPROFILE', 'home'), @('HOME', 'home'), @('APPDATA', 'appdata'), @('LOCALAPPDATA', 'localappdata'), @('TEMP', 'tmp'), @('TMP', 'tmp'), @('PROXY_CONFIG_DIR', 'config'), @('PROXY_RUNTIME_DIR', 'runtime'))) { $start.Environment[$pair[0]] = Join-Path $caseRoot $pair[1] }
    $start.Environment['PROXY_DATA_DIR'] = ''
    $start.Environment['MGMT_TOKEN'] = $Request.token
    $start.Environment['MGMT_PORT'] = [string]$ports[0]
    $start.Environment['PROXY_DISABLE_CONVERSATION_AUDIT'] = '1'
    $start.Environment['PROXY_DISABLE_FILE_LOG'] = '1'
    $start.Environment['PROXY_LOG_LEVEL'] = 'error'
    $start.Environment['HPM_DAEMON_OWNED_ROOT'] = $OwnedRoot
    $start.Environment['HPM_DAEMON_OWNED_INSTALL'] = $InstallDirectory
    $start.Environment['HPM_DAEMON_OWNED_CASE_ROOT'] = $caseRoot
    $start.Environment['HPM_DAEMON_OWNED_MANIFEST'] = $ManifestSha256
    foreach ($argument in @('--require', (Join-Path $PSScriptRoot 'context-recovery-daemon-start-gate.cjs'), (Join-Path $InstallDirectory 'openai-proxy.js'))) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $owner = @{ label = $Request.case; process = $process; job = $null; assigned = $false; streams = @(); gateMarker = (New-HpmDaemonGateMarker); clock = [Diagnostics.Stopwatch]::StartNew(); ownedRoot = $OwnedRoot; userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    # Retain partial state before Start/Assign so finally can close every handle.
    $State.active = $owner
    $State.startStage = 'job_assign'
    $owner.job = [HpmRuntimeBoundaryJob]::new()
    $State.startStage = 'process_start'
    if (-not $process.Start()) { throw 'daemon_start_failed' }
    $State.startStage = 'job_assign'
    $owner.streams = @(
        @{ stream = $process.StandardOutput.BaseStream; buffer = [byte[]]::new(1024); count = 0; ended = $false; task = $null },
        @{ stream = $process.StandardError.BaseStream; buffer = [byte[]]::new(1024); count = 0; ended = $false; task = $null; gateMarker = $owner.gateMarker }
    )
    foreach ($item in $owner.streams) { $item.task = $item.stream.ReadAsync($item.buffer, 0, $item.buffer.Length) }
    $owner.job.Assign($process)
    $owner.assigned = $true
    $State.startStage = 'gate_release'
    $process.StandardInput.Write('1')
    $process.StandardInput.Close()
    $owner.identity = @{ pid = $process.Id; entrypoint = Join-Path $InstallDirectory 'openai-proxy.js'; cwd = $InstallDirectory; configDir = Join-Path $caseRoot 'config'; runtimeDir = Join-Path $caseRoot 'runtime'; managementPort = $ports[0]; entryPort = $ports[1] }
    return $owner
}

function Invoke-HpmDaemonOwnedController {
    param([string]$OwnedRoot, [string]$InstallDirectory, [string]$ManifestSha256)
    $state = New-HpmDaemonOwnedState
    $memory = [IO.MemoryStream]::new()
    try {
        if (-not $IsWindows -or -not [IO.Path]::IsPathFullyQualified($OwnedRoot) -or $ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
        Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($OwnedRoot)) $OwnedRoot 'Container'
        Assert-HpmLifecycleArtifactPath $OwnedRoot $InstallDirectory 'Container'
        $boundaryModule = Get-Module -Name nsis-runtime-boundary -All | Select-Object -First 1
        if ($null -eq $boundaryModule) { throw 'invalid' }
        $node = & $boundaryModule { param($root, $install, $sha) Get-HpmRuntimeBoundaryNode $root $install $sha } $OwnedRoot $InstallDirectory $ManifestSha256
        if (-not ('HpmRuntimeBoundaryJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'nsis-runtime-boundary-job.cs') -ErrorAction Stop }
        $operations = @{
            Start = { param($request, $session) Start-HpmDaemonOwnedCase $request $session $OwnedRoot $InstallDirectory $ManifestSha256 $node }
            Alive = { param($owner) -not $owner.process.HasExited }
            Credentials = { param($owner) Test-HpmDaemonOwnedCredentials $owner }
            Stop = { param($owner) Stop-HpmDaemonOwnedCase $owner }
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $inputStream = [Console]::OpenStandardInput()
        $buffer = [byte[]]::new(1024)
        $read = $inputStream.ReadAsync($buffer, 0, $buffer.Length)
        do {
            if ($clock.ElapsedMilliseconds -ge 240000) { throw 'daemon_deadline' }
            if ($null -ne $state.active) {
                if ($state.active.clock.ElapsedMilliseconds -ge 45000) { throw 'daemon_deadline' }
                Update-HpmDaemonOwnedPipes $state.active
            }
            if ($read.IsCompleted) {
                $count = $read.GetAwaiter().GetResult()
                if ($count -eq 0) {
                    if ($memory.Length -ne 0 -or $null -ne $state.active) { throw 'daemon_protocol_rejected' }
                    return
                }
                $newline = [Array]::IndexOf($buffer, [byte]10, 0, $count)
                $length = if ($newline -lt 0) { $count } else { $newline }
                if ($memory.Length + $length -gt 2048 -or ($newline -ge 0 -and $newline -ne $count - 1)) { throw 'daemon_protocol_rejected' }
                $memory.Write($buffer, 0, $length)
                if ($newline -ge 0) {
                    $frame = [Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray())
                    $request = ConvertFrom-HpmDaemonOwnedFrame $frame
                    $response = Invoke-HpmDaemonOwnedRequest $state $request $operations
                    # Drop the token-bearing request before the next iteration.
                    $request = $null; $frame = $null
                    $memory.SetLength(0)
                    $line = $response | ConvertTo-Json -Compress -Depth 5
                    if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 16384) { throw 'daemon_protocol_rejected' }
                    [Console]::Out.WriteLine($line)
                    [Console]::Out.Flush()
                }
                [Array]::Clear($buffer, 0, $buffer.Length)
                $read = $inputStream.ReadAsync($buffer, 0, $buffer.Length)
            }
            [Threading.Thread]::Sleep(10)
        } while ($true)
    } finally {
        try { if ($null -ne $state.active) { Stop-HpmDaemonOwnedCase $state.active | Out-Null } } finally { $memory.Dispose() }
    }
}

Export-ModuleMember -Function ConvertFrom-HpmDaemonOwnedFrame, New-HpmDaemonOwnedState, Invoke-HpmDaemonOwnedRequest, Invoke-HpmDaemonOwnedController
