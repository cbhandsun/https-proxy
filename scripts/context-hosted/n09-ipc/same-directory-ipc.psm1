Set-StrictMode -Version Latest

function ConvertFrom-HpmN09IpcFrame {
    param([string]$Frame)
    $document = $null
    try {
        if ([Text.UTF8Encoding]::new($false, $true).GetByteCount($Frame) -gt 2048) { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse($Frame)
        $value = $document.RootElement
        if ($value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'invalid' }
        $names = @($value.EnumerateObject() | ForEach-Object { $_.Name })
        $op = $value.GetProperty('op').GetString()
        if ($op -cnotin @('start', 'status', 'stop', 'restart', 'remove')) { throw 'invalid' }
        $expected = if ($op -ceq 'start') { 'id,op,v' } else { 'id,leaseId,op,v' }
        if (($names | Sort-Object) -join ',' -cne $expected -or $value.GetProperty('v').GetInt32() -ne 1) { throw 'invalid' }
        $id = $value.GetProperty('id').GetInt32()
        if ($id -lt 1 -or $id -gt 4096) { throw 'invalid' }
        $result = @{ v = 1; id = $id; op = $op }
        if ($op -cne 'start') {
            $leaseId = $value.GetProperty('leaseId').GetString()
            if ($leaseId -cnotmatch '\A[a-f0-9]{32}\z') { throw 'invalid' }
            $result.leaseId = $leaseId
        }
        return $result
    } catch { throw 'n09_ipc_protocol_rejected' } finally { if ($null -ne $document) { $document.Dispose() } }
}

function Invoke-HpmN09IpcRequestUnsafe {
    param([hashtable]$State, [hashtable]$Request, [hashtable]$Operations)
    if ($Request.id -ne $State.lastId + 1) { throw 'n09_ipc_protocol_rejected' }
    $State.lastId = $Request.id
    if ($Request.op -ceq 'start') {
        if ($State.started -or $null -ne $State.leaseId) { throw 'n09_ipc_protocol_rejected' }
        $State.started = $true
        $start = & $Operations.Start
        if ($start.leaseId -cnotmatch '\A[a-f0-9]{32}\z') { throw 'n09_ipc_protocol_rejected' }
        $State.leaseId = $start.leaseId
        return @{ v = 1; id = $Request.id; op = 'start'; ok = $true; leaseId = $State.leaseId; identity = $start.identity }
    }
    if ($null -eq $State.leaseId -or $Request.leaseId -cne $State.leaseId) { throw 'n09_ipc_protocol_rejected' }
    $reply = @{ v = 1; id = $Request.id; op = $Request.op; ok = $true }
    switch -CaseSensitive ($Request.op) {
        'status' { $reply.status = & $Operations.Status $State.leaseId }
        'stop' { $reply.cleanup = & $Operations.Stop $State.leaseId }
        'restart' { $reply.identity = & $Operations.Restart $State.leaseId }
        'remove' { & $Operations.Remove $State.leaseId; $State.leaseId = $null }
        default { throw 'n09_ipc_protocol_rejected' }
    }
    return $reply
}

function Invoke-HpmN09IpcRequest {
    param([hashtable]$State, [hashtable]$Request, [hashtable]$Operations)
    try { return Invoke-HpmN09IpcRequestUnsafe $State $Request $Operations } catch { throw 'n09_ipc_request_rejected' }
}

function Add-HpmN09IpcChunk {
    param([IO.MemoryStream]$Memory, [byte[]]$Bytes, [int]$Count)
    try {
        if ($Count -lt 0 -or $Count -gt $Bytes.Length -or $Count -gt 1024 -or $Memory.Length -gt 2048) { throw 'invalid' }
        $frames = [Collections.Generic.List[string]]::new()
        for ($offset = 0; $offset -lt $Count; $offset++) {
            if ($Bytes[$offset] -eq 10) {
                $frames.Add([Text.UTF8Encoding]::new($false, $true).GetString($Memory.ToArray()))
                $Memory.SetLength(0)
            } else {
                if ($Memory.Length -ge 2048) { throw 'invalid' }
                $Memory.WriteByte($Bytes[$offset])
            }
        }
        return ,$frames.ToArray()
    } catch { throw 'n09_ipc_protocol_rejected' }
}

function Assert-HpmN09IpcSession {
    param($Parent, [long]$ParentStartTicks, $Clock, [hashtable]$State, $Lifecycle)
    $Parent.Refresh()
    if ($Parent.HasExited -or $Parent.StartTime.ToUniversalTime().Ticks -ne $ParentStartTicks -or $Clock.ElapsedMilliseconds -ge 240000) { throw 'n09_ipc_deadline' }
    if ($null -ne $State.leaseId) {
        & $Lifecycle {
            param($id)
            $lease = Get-HpmN09Lease $id
            if ($null -ne $lease.owner) {
                if ($lease.owner.clock.ElapsedMilliseconds -ge 45000) { throw 'n09_ipc_deadline' }
                & $lease.controller { param($owner) Update-HpmDaemonOwnedPipes $owner } $lease.owner
            }
        } $State.leaseId
    }
}

function Wait-HpmN09PendingIo {
    param($Task, [scriptblock]$Check, [scriptblock]$Pause = { [Threading.Thread]::Sleep(10) })
    try {
        do {
            # Reuses the original clocks; pending output never extends deadlines.
            & $Check
            if ($Task.IsCompleted) { break }
            & $Pause
        } while ($true)
        $Task.GetAwaiter().GetResult() | Out-Null
    } catch { throw 'n09_ipc_io_failed' }
}

function Invoke-HpmN09IpcController {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$TrustedLaunch, [Parameter(Mandatory)][int]$ParentPid,
        [Parameter(Mandatory)][string]$SyntheticToken)
    $lifecycle = $null
    $parent = $null
    $memory = [IO.MemoryStream]::new()
    $failed = $false
    try {
        if ($ParentPid -le 0 -or $SyntheticToken -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
        $parent = [Diagnostics.Process]::GetProcessById($ParentPid)
        $parentStartTicks = $parent.StartTime.ToUniversalTime().Ticks
        if ($parent.HasExited) { throw 'invalid' }
        $lifecycle = Import-Module (Join-Path $PSScriptRoot 'same-directory-restart.psm1') -PassThru -ErrorAction Stop
        if (-not ('HpmN09IpcWriter' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'n09-ipc-writer.cs') -ErrorAction Stop }
        $launch = $TrustedLaunch.Clone()
        if (($launch.Keys | Sort-Object) -join ',' -cne 'InstallDirectory,ManifestSha256,OwnedRoot') { throw 'invalid' }
        # Captured once from the entry's already-cleared bootstrap environment.
        # Ordinary IPC cannot alter or retrieve this synthetic token.
        $token = $SyntheticToken
        $SyntheticToken = $null
        $state = @{ lastId = 0; started = $false; leaseId = $null }
        $operations = @{
            Start = { New-HpmN09OwnedLease -OwnedRoot $launch.OwnedRoot -InstallDirectory $launch.InstallDirectory -ManifestSha256 $launch.ManifestSha256 -Token $token -Label '00' }
            Status = { param($id) Get-HpmN09OwnedLeaseStatus -LeaseId $id }
            Stop = { param($id) Stop-HpmN09OwnedLease -LeaseId $id }
            Restart = { param($id) Restart-HpmN09OwnedLease -LeaseId $id }
            Remove = { param($id) Remove-HpmN09OwnedLease -LeaseId $id }
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $inputStream = [Console]::OpenStandardInput()
        $outputStream = [Console]::OpenStandardOutput()
        $encoding = [Text.UTF8Encoding]::new($false, $true)
        $buffer = [byte[]]::new(1024)
        $read = $inputStream.ReadAsync($buffer, 0, $buffer.Length)
        $checkSession = { Assert-HpmN09IpcSession $parent $parentStartTicks $clock $state $lifecycle }
        do {
            & $checkSession
            if ($read.IsCompleted) {
                $count = $read.GetAwaiter().GetResult()
                if ($count -eq 0) {
                    if ($memory.Length -ne 0) { throw 'n09_ipc_protocol_rejected' }
                    break
                }
                foreach ($frame in (Add-HpmN09IpcChunk $memory $buffer $count)) {
                        $request = ConvertFrom-HpmN09IpcFrame $frame
                        $reply = Invoke-HpmN09IpcRequest $state $request $operations
                        $bytes = $encoding.GetBytes(($reply | ConvertTo-Json -Compress -Depth 6) + "`n")
                        if ($bytes.Length -gt 16384) { throw 'n09_ipc_protocol_rejected' }
                        # Backpressure remains interruptible by the same parent/
                        # session/owner checks, so it cannot strand a live Job.
                        $write = [HpmN09IpcWriter]::WriteAndFlushAsync($outputStream, $bytes)
                        Wait-HpmN09PendingIo $write $checkSession
                        $request = $null; $reply = $null
                }
                [Array]::Clear($buffer, 0, $buffer.Length)
                $read = $inputStream.ReadAsync($buffer, 0, $buffer.Length)
            }
            [Threading.Thread]::Sleep(10)
        } while ($true)
    } catch { $failed = $true } finally {
        # Also includes a partially started owner whose start failed before it
        # returned an opaque ID. The private registry retains such failures.
        if ($null -ne $lifecycle) {
            try { & $lifecycle { Clear-HpmN09AllLeases } } catch { $failed = $true }
        }
        if ($null -ne $parent) { $parent.Dispose() }
        $memory.Dispose()
        $token = $null
    }
    if ($failed) { throw 'n09_ipc_failed' }
}

Export-ModuleMember -Function ConvertFrom-HpmN09IpcFrame, Invoke-HpmN09IpcRequest, Invoke-HpmN09IpcController
