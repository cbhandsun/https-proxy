Set-StrictMode -Version Latest

function Get-HpmHostedNetworkNames {
    param([bool]$InstalledClientMatrix)
    $names = @('api.openai.com', 'n08-target.invalid')
    if ($InstalledClientMatrix) { $names += 'api.anthropic.com' }
    return $names
}

# Fixed disposable-runner profile only. No caller-selected executable list.
function Initialize-HpmInstalledClientContainment {
    param([string]$OwnedRoot, [ValidatePattern('\A[a-f0-9]{32}\z')][string]$Nonce, [hashtable]$State, [ValidatePattern('\A[a-f0-9]{64}\z')][string]$NodeSha256)
    if ($null -eq $State -or $State.Keys.Count -ne 1 -or -not $State.ContainsKey('programs') -or $State.programs.Count -ne 0) { throw 'n08_network_rejected' }
    $expected = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'hpm-installed-clients'))
    if ([IO.Path]::GetFullPath($OwnedRoot) -cne $expected) { throw 'n08_network_rejected' }
    Assert-HpmN08MaterialPath $expected $true
    Initialize-HpmN08ArtifactLease
    foreach ($relative in @('payload/runtime/node/node.exe', 'clients/codex.exe', 'clients/claude.exe')) {
        $program = Join-Path $expected $relative
        Assert-HpmN08MaterialPath $program $false
        $lease = [HpmN08ArtifactLease]::new($program, $false)
        $record = @{ program = $program; sha256 = $null; fileLease = $lease; firewallName = ('HPM-N08-' + $Nonce + '-' + $State.programs.Count); firewallCreated = $false; wfpLease = $null }
        $State.programs += $record
        $lease.Verify($program)
        $record.sha256 = (Get-FileHash -LiteralPath $program -Algorithm SHA256).Hash.ToLowerInvariant()
        if (($relative -ceq 'payload/runtime/node/node.exe' -and $record.sha256 -cne $NodeSha256) -or $record.sha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'n08_network_rejected' }
        if ($null -ne (Get-NetFirewallRule -Name $record.firewallName -ErrorAction SilentlyContinue)) { throw 'n08_network_rejected' }
        New-NetFirewallRule -Name $record.firewallName -DisplayName $record.firewallName -Direction Outbound -Action Block -Enabled True -Profile Any `
            -Program $program -RemoteAddress @('0.0.0.0-127.0.0.0', '127.0.0.2-255.255.255.255', '::/1', '8000::/1') | Out-Null
        $record.firewallCreated = $true
        $rule = Get-NetFirewallRule -Name $record.firewallName
        $application = $rule | Get-NetFirewallApplicationFilter
        if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block' -or $rule.Direction -ne 'Outbound' -or $application.Program -cne $program) { throw 'n08_network_rejected' }
        $record.wfpLease = [HpmHostedEgressLease]::ForInstalledClient($program)
        if ($null -eq $record.wfpLease) { throw 'n08_network_rejected' }
    }
    Assert-HpmInstalledClientContainment $State
}

function Assert-HpmInstalledClientContainment {
    param([hashtable]$State)
    if ($State.programs.Count -ne 3) { throw 'n08_network_rejected' }
    foreach ($record in $State.programs) {
        Assert-HpmN08MaterialPath $record.program $false
        $record.fileLease.Verify($record.program)
        if ((Get-FileHash -LiteralPath $record.program -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256 -or
            -not $record.firewallCreated -or $null -eq $record.wfpLease) { throw 'n08_network_rejected' }
    }
}

function Remove-HpmInstalledClientContainment {
    param([hashtable]$State, [bool]$OwnedScenarioStopped)
    $failed = $false
    if ($OwnedScenarioStopped) {
        foreach ($record in $State.programs) {
            if ($null -ne $record.wfpLease) { try { $record.wfpLease.Dispose() } catch { $failed = $true } }
            if ($record.firewallCreated) { try { Remove-NetFirewallRule -Name $record.firewallName -ErrorAction Stop } catch { $failed = $true } }
        }
    } elseif ($State.programs.Count -gt 0) { $failed = $true }
    foreach ($record in $State.programs) { try { $record.fileLease.Dispose() } catch { $failed = $true } }
    if ($failed) { throw 'n08_network_restore_failed' }
}
