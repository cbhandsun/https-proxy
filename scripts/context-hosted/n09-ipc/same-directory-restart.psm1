Set-StrictMode -Version Latest

# Vault-only composition. No stdin protocol or existing four-case controller is changed.
# Registry entries, owners, credentials and captured launch data never leave this module.
$script:N09Leases = @{}
$script:N09ControllerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../scripts/lib/context-recovery-daemon-owned-controller.psm1'))

function Copy-HpmN09StartInfo {
    param([Diagnostics.ProcessStartInfo]$Source)
    $copy = [Diagnostics.ProcessStartInfo]::new()
    $copy.FileName = $Source.FileName
    $copy.WorkingDirectory = $Source.WorkingDirectory
    $copy.UseShellExecute = $Source.UseShellExecute
    $copy.CreateNoWindow = $Source.CreateNoWindow
    $copy.RedirectStandardInput = $Source.RedirectStandardInput
    $copy.RedirectStandardOutput = $Source.RedirectStandardOutput
    $copy.RedirectStandardError = $Source.RedirectStandardError
    $copy.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $Source.ArgumentList) { $copy.ArgumentList.Add($argument) }
    $copy.Environment.Clear()
    foreach ($pair in $Source.Environment.GetEnumerator()) { $copy.Environment[$pair.Key] = $pair.Value }
    return $copy
}

function Assert-HpmN09Capture {
    param([hashtable]$Lease)
    $start = $Lease.capture
    $identity = $Lease.identity
    if ($start.FileName -cne $Lease.node -or $start.WorkingDirectory -cne $Lease.install -or
        $start.UseShellExecute -or -not $start.CreateNoWindow -or -not $start.RedirectStandardInput -or
        -not $start.RedirectStandardOutput -or -not $start.RedirectStandardError -or $start.Arguments.Length -ne 0 -or
        $start.ArgumentList.Count -ne 3 -or $start.ArgumentList[0] -cne '--require' -or
        $start.ArgumentList[1] -cne (Join-Path (Split-Path $script:N09ControllerPath) 'context-recovery-daemon-start-gate.cjs') -or
        $start.ArgumentList[2] -cne (Join-Path $Lease.install 'openai-proxy.js')) { throw 'n09_capture_rejected' }
    $caseRoot = $start.Environment['HPM_DAEMON_OWNED_CASE_ROOT']
    $expected = @{
        HPM_DAEMON_OWNED_ROOT = $Lease.root; HPM_DAEMON_OWNED_INSTALL = $Lease.install
        HPM_DAEMON_OWNED_MANIFEST = $Lease.manifest; HPM_DAEMON_OWNED_CASE_ROOT = $caseRoot
        PROXY_CONFIG_DIR = $identity.configDir; PROXY_RUNTIME_DIR = $identity.runtimeDir
        MGMT_PORT = [string]$identity.managementPort; MGMT_TOKEN = $Lease.token
        PROXY_DATA_DIR = ''; PROXY_DISABLE_CONVERSATION_AUDIT = '1'
        PROXY_DISABLE_FILE_LOG = '1'; PROXY_LOG_LEVEL = 'error'
    }
    foreach ($pair in @(@('USERPROFILE', 'home'), @('HOME', 'home'), @('APPDATA', 'appdata'), @('LOCALAPPDATA', 'localappdata'), @('TEMP', 'tmp'), @('TMP', 'tmp'))) {
        $expected[$pair[0]] = Join-Path $caseRoot $pair[1]
    }
    if ($identity.configDir -cne (Join-Path $caseRoot 'config') -or $identity.runtimeDir -cne (Join-Path $caseRoot 'runtime')) { throw 'n09_capture_rejected' }
    foreach ($key in $expected.Keys) { if ($start.Environment[$key] -cne $expected[$key]) { throw 'n09_capture_rejected' } }
    foreach ($key in $start.Environment.Keys) {
        if (-not $expected.ContainsKey($key) -and $key -cnotin @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT')) { throw 'n09_capture_rejected' }
    }
    & $Lease.controller {
        param($root, $install, $sha, $node, $caseDirectory)
        foreach ($directory in @($install, $caseDirectory, (Join-Path $caseDirectory 'config'), (Join-Path $caseDirectory 'runtime'))) {
            Assert-HpmLifecycleArtifactPath $root $directory 'Container'
        }
        $boundary = Get-Module -Name nsis-runtime-boundary -All | Select-Object -First 1
        if ($null -eq $boundary) { throw 'n09_capture_rejected' }
        $current = & $boundary { param($r, $i, $s) Get-HpmRuntimeBoundaryNode $r $i $s } $root $install $sha
        if ($current -cne $node) { throw 'n09_capture_rejected' }
    } $Lease.root $Lease.install $Lease.manifest $Lease.node $caseRoot
}

function Clear-HpmN09PartialOwner {
    param([hashtable]$Lease, [hashtable]$Owner)
    if ($null -eq $Owner) { return }
    if ($Owner.assigned) {
        if ((& $Lease.controller { param($o) Stop-HpmDaemonOwnedCase $o } $Owner) -ne $true) { throw 'n09_cleanup_failed' }
        return
    }
    # No tree-empty ACK is issued for an unassigned owner. Closing the gate input
    # makes the fixed preload exit without entering product code.
    $failed = $false
    try {
        $started = $false
        try { $null = $Owner.process.Id; $started = $true } catch [InvalidOperationException] { $started = $false }
        if ($started) {
            try { $Owner.process.StandardInput.Close() } catch { $failed = $true }
            if (-not $Owner.process.WaitForExit(5000)) {
                $failed = $true
                $Owner.process.Kill()
                if (-not $Owner.process.WaitForExit(5000)) { throw 'n09_cleanup_failed' }
            }
        }
    } catch { $failed = $true } finally {
        try { if ($null -ne $Owner.job) { $Owner.job.Dispose() } } catch { $failed = $true }
        try { $Owner.process.Dispose() } catch { $failed = $true }
    }
    if ($failed) { throw 'n09_cleanup_failed' }
}

function New-HpmN09ReplayCapabilities {
    param([hashtable]$Lease)
    # Only production wiring supplies these private capabilities. They are not
    # accepted by exported commands; regression source exercises the engine alone.
    return @{
        Verify = { param($l) Assert-HpmN09Capture $l }
        Process = {
            param($l)
            $copy = Copy-HpmN09StartInfo $l.capture
            $p = [Diagnostics.Process]::new()
            try { $p.StartInfo = $copy; return $p } catch { $p.Dispose(); throw 'n09_start_failed' }
        }
        Marker = { param($l) & $l.controller { New-HpmDaemonGateMarker } }
        Job = { [HpmRuntimeBoundaryJob]::new() }
        Start = { param($o) $o.process.Start() }
        Pipes = {
            param($o)
            $o.streams = @(
                @{ stream = $o.process.StandardOutput.BaseStream; buffer = [byte[]]::new(1024); count = 0; ended = $false; task = $null },
                @{ stream = $o.process.StandardError.BaseStream; buffer = [byte[]]::new(1024); count = 0; ended = $false; task = $null; gateMarker = $o.gateMarker }
            )
            foreach ($item in $o.streams) { $item.task = $item.stream.ReadAsync($item.buffer, 0, $item.buffer.Length) }
        }
        Assign = { param($o) $o.job.Assign($o.process) }
        Release = { param($o) $o.process.StandardInput.Write('1'); $o.process.StandardInput.Close() }
        Pid = { param($o) $o.process.Id }
        Cleanup = { param($l, $o) Clear-HpmN09PartialOwner $l $o }
    }
}

function Invoke-HpmN09ReplayLaunch {
    param([hashtable]$Lease, [hashtable]$Capabilities)
    if ($Lease.phase -cne 'stopped' -or $null -ne $Lease.owner) { throw 'n09_restart_rejected' }
    $Lease.phase = 'restarting'
    try {
        & $Capabilities.Verify $Lease
        $process = & $Capabilities.Process $Lease
        # Retain the process before constructing a Job or starting the child.
        $Lease.owner = @{ label = $Lease.label; process = $process; job = $null; assigned = $false; streams = @(); gateMarker = $null; clock = [Diagnostics.Stopwatch]::StartNew(); ownedRoot = $Lease.root; userSid = $Lease.userSid }
        $owner = $Lease.owner
        $owner.gateMarker = & $Capabilities.Marker $Lease
        $owner.job = & $Capabilities.Job
        if ((& $Capabilities.Start $owner) -ne $true) { throw 'n09_start_failed' }
        & $Capabilities.Pipes $owner
        & $Capabilities.Assign $owner
        $owner.assigned = $true
        & $Capabilities.Release $owner
        $newPid = & $Capabilities.Pid $owner
        if ($newPid -isnot [int] -or $newPid -le 0 -or $newPid -eq $Lease.identity.pid) { throw 'n09_identity_rejected' }
        $identity = $Lease.identity.Clone()
        $identity.pid = $newPid
        $owner.identity = $identity
        & $Capabilities.Verify $Lease
        $Lease.identity = $identity
        $Lease.phase = 'running'
    } catch {
        $Lease.phase = 'failed'
        try { & $Capabilities.Cleanup $Lease $Lease.owner; $Lease.owner = $null } catch { throw 'n09_cleanup_failed' }
        throw 'n09_restart_failed'
    }
}

function Get-HpmN09Lease {
    param([string]$LeaseId)
    if ($LeaseId -cnotmatch '\A[a-f0-9]{32}\z' -or -not $script:N09Leases.ContainsKey($LeaseId)) { throw 'n09_lease_rejected' }
    return $script:N09Leases[$LeaseId]
}

function Get-HpmN09SafeSnapshot {
    param([hashtable]$Lease)
    $result = $Lease.identity.Clone()
    $result.manifestSha256 = $Lease.manifest
    $result.phase = $Lease.phase
    $result.evidenceLevel = 'lifecycle-identity-only'
    $result.liveDaemonProved = $false
    # This is lifecycle identity only, never a claim of HTTP readiness/isolation.
    return $result
}

function New-HpmN09OwnedLease {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$OwnedRoot, [Parameter(Mandatory)][string]$InstallDirectory,
        [Parameter(Mandatory)][string]$ManifestSha256, [Parameter(Mandatory)][string]$Token,
        [ValidateSet('00', '01', '10', '11')][string]$Label = '00')
    # Trusted fixture composition only. Restart/stop accept solely the opaque ID.
    $lease = $null
    $state = $null
    $id = $null
    try {
        if (-not $IsWindows -or $ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or
            $Token -cnotmatch '\A[a-zA-Z0-9_-]{32,256}\z' -or -not [IO.Path]::IsPathFullyQualified($OwnedRoot) -or
            -not [IO.Path]::IsPathFullyQualified($InstallDirectory)) { throw 'n09_lease_rejected' }
        $controller = Import-Module $script:N09ControllerPath -PassThru -ErrorAction Stop
        $node = & $controller {
            param($root, $install, $sha, $jobSource)
            Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($root)) $root 'Container'
            Assert-HpmLifecycleArtifactPath $root $install 'Container'
            $boundary = Get-Module -Name nsis-runtime-boundary -All | Select-Object -First 1
            if ($null -eq $boundary) { throw 'n09_lease_rejected' }
            $n = & $boundary { param($r, $i, $s) Get-HpmRuntimeBoundaryNode $r $i $s } $root $install $sha
            if (-not ('HpmRuntimeBoundaryJob' -as [type])) { Add-Type -Path $jobSource -ErrorAction Stop }
            return $n
        } $OwnedRoot $InstallDirectory $ManifestSha256 (Join-Path (Split-Path $script:N09ControllerPath) 'nsis-runtime-boundary-job.cs')
        $lease = @{ controller = $controller; node = $node; root = $OwnedRoot; install = $InstallDirectory; manifest = $ManifestSha256; token = $Token; label = $Label; phase = 'starting'; owner = $null; identity = $null; capture = $null; userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
        $id = [Guid]::NewGuid().ToString('N')
        $script:N09Leases.Add($id, $lease)
        $state = & $controller { New-HpmDaemonOwnedState }
        $request = @{ case = $Label; token = $Token }
        $lease.owner = & $controller { param($r, $s, $root, $install, $sha, $n) Start-HpmDaemonOwnedCase $r $s $root $install $sha $n } $request $state $OwnedRoot $InstallDirectory $ManifestSha256 $node
        $lease.identity = $lease.owner.identity.Clone()
        $lease.capture = Copy-HpmN09StartInfo $lease.owner.process.StartInfo
        Assert-HpmN09Capture $lease
        $lease.phase = 'running'
        return @{ leaseId = $id; identity = (Get-HpmN09SafeSnapshot $lease) }
    } catch {
        if ($null -ne $lease) {
            if ($null -ne $state -and $null -ne $state.active) { $lease.owner = $state.active }
            try {
                Clear-HpmN09PartialOwner $lease $lease.owner
                if ($null -ne $id) { $script:N09Leases.Remove($id) }
            } catch { $lease.phase = 'failed'; throw 'n09_cleanup_failed' }
        }
        throw 'n09_start_failed'
    }
}

function Stop-HpmN09OwnedLease {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LeaseId)
    $lease = Get-HpmN09Lease $LeaseId
    if ($lease.phase -cne 'running' -or $null -eq $lease.owner) { throw 'n09_stop_rejected' }
    $lease.phase = 'stopping'
    try {
        if ((& $lease.controller { param($o) Stop-HpmDaemonOwnedCase $o } $lease.owner) -ne $true) { throw 'n09_cleanup_failed' }
        $lease.owner = $null
        $lease.phase = 'stopped'
        return @{ pid = $lease.identity.pid; treeEmpty = $true; shutdownInvoked = $false; semantics = 'forced_cleanup' }
    } catch { $lease.phase = 'failed'; throw 'n09_cleanup_failed' }
}

function Restart-HpmN09OwnedLease {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LeaseId)
    $lease = Get-HpmN09Lease $LeaseId
    Invoke-HpmN09ReplayLaunch $lease (New-HpmN09ReplayCapabilities $lease)
    return Get-HpmN09SafeSnapshot $lease
}

function Get-HpmN09OwnedLeaseStatus {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LeaseId)
    $lease = Get-HpmN09Lease $LeaseId
    if ($lease.phase -cne 'running') { throw 'n09_status_rejected' }
    return & $lease.controller {
        param($o)
        Update-HpmDaemonOwnedPipes $o
        return @{ alive = -not $o.process.HasExited; preloadPhase = $o.gateMarker.phase; credentialsPrivate = (Test-HpmDaemonOwnedCredentials $o) }
    } $lease.owner
}

function Remove-HpmN09OwnedLease {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LeaseId)
    $lease = Get-HpmN09Lease $LeaseId
    # Explicit finally/disposal entry, including failed partial restart. Failure
    # preserves the registry entry; caller cannot mistake disposal for a kill ACK.
    try { Clear-HpmN09PartialOwner $lease $lease.owner } catch { $lease.phase = 'failed'; throw 'n09_cleanup_failed' }
    $lease.owner = $null
    $lease.capture = $null
    $lease.token = $null
    $script:N09Leases.Remove($LeaseId)
}

function Clear-HpmN09AllLeases {
    $failed = $false
    foreach ($id in @($script:N09Leases.Keys)) {
        try { Remove-HpmN09OwnedLease -LeaseId $id } catch { $failed = $true }
    }
    if ($failed) { throw 'n09_cleanup_failed' }
}

Export-ModuleMember -Function New-HpmN09OwnedLease, Stop-HpmN09OwnedLease, Restart-HpmN09OwnedLease, Get-HpmN09OwnedLeaseStatus, Remove-HpmN09OwnedLease
