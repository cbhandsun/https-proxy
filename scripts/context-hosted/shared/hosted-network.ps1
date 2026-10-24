Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hosted-materials.ps1')

# Review-only library: dot-source does not change the machine. Invoke only in the
# disposable hosted Windows job, after the pinned build/npm receipt is complete.
function Invoke-HpmN08HostedNetwork {
    param(
        [Parameter(Mandatory)][string]$OwnedRoot,
        [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$BuildReceiptSha256,
        [Parameter(Mandatory)][scriptblock]$RunOwnedScenario,
        [Parameter(Mandatory)][scriptblock]$StopOwnedScenario,
        [switch]$InstalledClientMatrix
    )
    $networkStage = 'environment'
    $receipt = $null
    $hostsChanged = $false
    $hostsBefore = $null
    $hostsEditedHash = $null
    $profiles = @()
    $firewallName = $null
    $firewallCreated = $false
    $wfpLease = $null
    $ca = $null
    $leaf = $null
    $primaryFailed = $false
    $restoreFailed = $false
    $networkRoot = $null
    $networkRootCreated = $false
    $networkRootLease = $null
    $materialLeases = @{}
    $installedState = @{ programs = @() }
    $scenarioInvoked = $false
    $ownedScenarioStopped = $true
    function Hash-Bytes([byte[]]$Bytes) {
        return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
    }
    function Assert-Physical([string]$Path, [bool]$Directory) {
        if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'n08_network_rejected' }
        $current = [IO.Path]::GetFullPath($Path)
        $first = $true
        while ($true) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                ($first -and $item.PSIsContainer -ne $Directory) -or (-not $first -and -not $item.PSIsContainer)) { throw 'n08_network_rejected' }
            $parent = [IO.Path]::GetDirectoryName($current)
            if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
            $current = $parent
            $first = $false
        }
    }
    try {
        if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
            $env:RUNNER_OS -cne 'Windows' -or $env:CI -cne 'true' -or [string]::IsNullOrEmpty($env:RUNNER_TEMP)) { throw 'n08_network_rejected' }
        $networkStage = 'administrator'
        $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'n08_network_rejected' }
        $networkStage = 'build_identity'
        $OwnedRoot = [IO.Path]::GetFullPath($OwnedRoot)
        $tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
        if (-not $OwnedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'n08_network_rejected' }
        if ($InstalledClientMatrix -and $OwnedRoot -cne [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'hpm-installed-clients'))) { throw 'n08_network_rejected' }
        Assert-Physical $OwnedRoot $true
        $buildFile = Join-Path $OwnedRoot 'build-and-npm.json'
        Assert-Physical $buildFile $false
        $buildBytes = [IO.File]::ReadAllBytes($buildFile)
        if ($buildBytes.Length -gt 4096 -or (Hash-Bytes $buildBytes) -cne $BuildReceiptSha256) { throw 'n08_network_rejected' }
        $build = [Text.UTF8Encoding]::new($false, $true).GetString($buildBytes) | ConvertFrom-Json -AsHashtable
        if ($build.phase -cne 'build_and_npm_ready' -or $build.buildCompleted -ne $true -or $build.npmCompleted -ne $true -or
            $build.manifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $build.nodeSha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'n08_network_rejected' }
        $node = Join-Path $OwnedRoot 'payload/runtime/node/node.exe'
        $manifest = Join-Path $OwnedRoot 'payload/release-runtime-manifest.json'
        Assert-Physical $node $false
        Assert-Physical $manifest $false
        if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $build.nodeSha256 -or
            (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $build.manifestSha256) { throw 'n08_network_rejected' }

        if ($InstalledClientMatrix) { . (Join-Path $PSScriptRoot 'installed-client-network.ps1') }

        $networkStage = 'exclusive_port'
        # Prove port 443 is free before any hosts, certificate or firewall change.
        if (@(Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue).Count -ne 0) { throw 'n08_network_rejected' }
        $reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 443)
        try { $reservation.ExclusiveAddressUse = $true; $reservation.Start() } finally { $reservation.Stop() }

        $networkStage = 'owned_materials'
        $networkRoot = Join-Path $OwnedRoot 'n08-hosted-network'
        if (Test-Path -LiteralPath $networkRoot) { throw 'n08_network_rejected' }
        New-Item -ItemType Directory -Path $networkRoot | Out-Null
        Assert-Physical $networkRoot $true
        Initialize-HpmN08ArtifactLease
        $networkRootLease = [HpmN08ArtifactLease]::new($networkRoot, $true)
        $networkRootLease.Verify($networkRoot)
        $networkRootCreated = $true
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        }
        Set-Acl -LiteralPath $networkRoot -AclObject $acl
        $networkStage = 'synthetic_certificates'
        $nonce = [Guid]::NewGuid().ToString('N')
        $ca = New-SelfSignedCertificate -Type Custom -Subject ('CN=HPM N08 Synthetic ' + $nonce) -CertStoreLocation 'Cert:\CurrentUser\My' `
            -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign `
            -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') -NotAfter (Get-Date).AddHours(2)
        $dnsNames = @('api.openai.com', 'n08-target.invalid')
        if ($InstalledClientMatrix) { $dnsNames = @(Get-HpmHostedNetworkNames $true) }
        $leaf = New-SelfSignedCertificate -Type SSLServerAuthentication -DnsName $dnsNames -Signer $ca `
            -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddHours(1)
        $caFile = Join-Path $networkRoot 'ca.pem'
        $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($ca.RawData, [Base64FormattingOptions]::InsertLineBreaks) + "`n-----END CERTIFICATE-----`n"
        [IO.File]::WriteAllText($caFile, $pem, [Text.UTF8Encoding]::new($false))
        $materialLeases['ca.pem'] = [HpmN08ArtifactLease]::new($caFile, $false)
        $passwordText = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
        Export-PfxCertificate -Cert $leaf -FilePath (Join-Path $networkRoot 'server.pfx') -Password $password | Out-Null
        $materialLeases['server.pfx'] = [HpmN08ArtifactLease]::new((Join-Path $networkRoot 'server.pfx'), $false)
        [IO.File]::WriteAllText((Join-Path $networkRoot '.pfx-password'), $passwordText, [Text.UTF8Encoding]::new($false))
        $materialLeases['.pfx-password'] = [HpmN08ArtifactLease]::new((Join-Path $networkRoot '.pfx-password'), $false)
        $passwordText = $null

        $networkStage = 'egress_containment'
        $firewallName = 'HPM-N08-' + $nonce
        $networkStage = 'egress_profiles'
        $profiles = @(Get-NetFirewallProfile | Select-Object Name, Enabled)
        $networkStage = 'egress_enable'
        foreach ($profile in $profiles) { Set-NetFirewallProfile -Name $profile.Name -Enabled True }
        if ($InstalledClientMatrix) {
            $networkStage = 'installed_containment'
            Add-Type -Path (Join-Path $PSScriptRoot 'hosted-egress-wfp.cs') -ErrorAction Stop
            Initialize-HpmInstalledClientContainment $OwnedRoot $nonce $installedState $build.nodeSha256
        }
        if (-not $InstalledClientMatrix) {
        $networkStage = 'egress_collision'
        if ($null -ne (Get-NetFirewallRule -Name $firewallName -ErrorAction SilentlyContinue)) { throw 'n08_network_rejected' }
        $networkStage = 'egress_rule_create'
        # NetSecurity rejects ::/0 on the hosted image. The two /1 prefixes
        # retain the same complete IPv6 block, with IPv4 exclusions unchanged.
        New-NetFirewallRule -Name $firewallName -DisplayName $firewallName -Direction Outbound -Action Block -Enabled True -Profile Any `
            -Program $node -RemoteAddress @('0.0.0.0-127.0.0.0', '127.0.0.2-255.255.255.255', '::/1', '8000::/1') | Out-Null
        $firewallCreated = $true
        $networkStage = 'egress_rule_read'
        $rule = Get-NetFirewallRule -Name $firewallName
        $networkStage = 'egress_application'
        $application = $rule | Get-NetFirewallApplicationFilter
        $networkStage = 'egress_identity'
        if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block' -or $rule.Direction -ne 'Outbound' -or
            $application.Program -cne $node) { throw 'n08_network_rejected' }

        # Windows Firewall may exempt same-host traffic even for a non-loopback
        # destination address. Keep its rule and add a dynamic ALE connect scope
        # for only the owned binary, so the original actual negative probe holds.
        }
        $networkStage = 'egress_wfp_compile'
        if (-not $InstalledClientMatrix) {
        Add-Type -Path (Join-Path $PSScriptRoot 'hosted-egress-wfp.cs') -ErrorAction Stop
        $networkStage = 'egress_wfp_install'
        try { $wfpLease = [HpmHostedEgressLease]::new($node) } catch {
            $wfpFailurePhase = [HpmHostedEgressLease]::LastFailurePhase
            if ($wfpFailurePhase -ge 1 -and $wfpFailurePhase -le 22) {
                Write-Information ('hpm_wfp_failed_phase=' + $wfpFailurePhase) -InformationAction Continue
            }
            throw 'n08_network_rejected'
        }

        }

        $networkStage = 'hosts_mapping'
        $hostsFile = Join-Path $env:SystemRoot 'System32/drivers/etc/hosts'
        Assert-Physical $hostsFile $false
        $hostsBefore = [IO.File]::ReadAllBytes($hostsFile)
        if ($hostsBefore.Length -gt 1048576) { throw 'n08_network_rejected' }
        $hostsText = [Text.UTF8Encoding]::new($false, $true).GetString($hostsBefore)
        foreach ($line in ($hostsText -split "`r?`n")) {
            $active = ($line -split '#', 2)[0]
            if ($active -match '(?i)(?:^|\s)(?:api\.openai\.com|n08-target\.invalid)(?:\s|$)' -or
                ($InstalledClientMatrix -and $active -match '(?i)(?:^|\s)api\.anthropic\.com(?:\s|$)')) { throw 'n08_network_rejected' }
        }
        $hostNames = 'api.openai.com n08-target.invalid'
        if ($InstalledClientMatrix) { $hostNames = (Get-HpmHostedNetworkNames $true) -join ' ' }
        $addition = [Text.Encoding]::ASCII.GetBytes("`r`n127.0.0.1 $hostNames # HPM-N08-$nonce`r`n")
        $edited = [byte[]]::new($hostsBefore.Length + $addition.Length)
        [Array]::Copy($hostsBefore, $edited, $hostsBefore.Length)
        [Array]::Copy($addition, 0, $edited, $hostsBefore.Length, $addition.Length)
        $hostsEditedHash = Hash-Bytes $edited
        # Hold a write lease only for mutation; release before the system DNS
        # service reads hosts. Restore a partial write before releasing the lease.
        $hostsLease = [IO.File]::Open($hostsFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        try {
            if ($hostsLease.Length -ne $hostsBefore.Length) { throw 'n08_network_rejected' }
            $checked = [byte[]]::new($hostsBefore.Length)
            $hostsLease.ReadExactly($checked)
            if ((Hash-Bytes $checked) -cne (Hash-Bytes $hostsBefore)) { throw 'n08_network_rejected' }
            $hostsChanged = $true
            try {
                $hostsLease.Position = 0
                $hostsLease.Write($edited, 0, $edited.Length)
                $hostsLease.SetLength($edited.Length)
                $hostsLease.Flush($true)
            } catch {
                $hostsLease.Position = 0
                $hostsLease.Write($hostsBefore, 0, $hostsBefore.Length)
                $hostsLease.SetLength($hostsBefore.Length)
                $hostsLease.Flush($true)
                $hostsChanged = $false
                throw 'n08_network_rejected'
            }
        } finally { $hostsLease.Dispose() }
        Clear-DnsClientCache

        # Trusted harness callback must first bind/prove the listener and execute
        # the fixed positive TLS + negative egress probes before launching daemon.
        # It receives no arbitrary URL, proxy, environment or module selector.
        $networkStage = 'owned_scenario'
        $scenarioInvoked = $true
        $ownedScenarioStopped = $false
        if ($InstalledClientMatrix) { Assert-HpmInstalledClientContainment $installedState }
        $scenarioMaterials = [pscustomobject]@{
            node = $node; networkRoot = $networkRoot; caSha256 = (Get-FileHash -LiteralPath $caFile -Algorithm SHA256).Hash.ToLowerInvariant()
            leafSha256 = (Hash-Bytes $leaf.RawData); manifestSha256 = $build.manifestSha256; firewallName = $firewallName; port443WasExclusive = $true
        }
        if ($InstalledClientMatrix) {
            $scenarioMaterials | Add-Member -NotePropertyName installedClientPrograms -NotePropertyValue @($installedState.programs | ForEach-Object { @{ program = $_.program; sha256 = $_.sha256 } })
        }
        $result = & $RunOwnedScenario $scenarioMaterials
        if ($InstalledClientMatrix) { Assert-HpmInstalledClientContainment $installedState }
        $networkStage = 'scenario_receipt'
        if ($null -eq $result -or $result.probesPassed -ne $true -or $result.tlsVerified -ne $true -or
            $result.nonLoopbackBlocked -ne $true -or $result.listenerOwned -ne $true -or $result.ownedTreeEmpty -ne $true -or
            $result.syntheticSocketsClosed -ne $true) { throw 'n08_network_rejected' }
        $receipt = @{ phase = 'hosted_network_finished'; probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true; ownedTreeEmpty = $true; n08Qualified = $false }
    } catch {
        $primaryFailed = $true
        Write-Information ('hpm_network_failed_stage=' + $networkStage) -InformationAction Continue
    }
    finally {
        # The callback must own all children in existing Jobs and close them in
        # its own finally, before global test-environment restoration starts.
        if ($scenarioInvoked) {
            try {
                if ((& $StopOwnedScenario) -ceq $true) { $ownedScenarioStopped = $true }
                else { $restoreFailed = $true }
            } catch { $restoreFailed = $true }
        }
        if ($hostsChanged) {
            try {
                if ((Hash-Bytes ([IO.File]::ReadAllBytes($hostsFile))) -cne $hostsEditedHash) { throw 'n08_restore_failed' }
                [IO.File]::WriteAllBytes($hostsFile, $hostsBefore)
                Clear-DnsClientCache
                if ((Hash-Bytes ([IO.File]::ReadAllBytes($hostsFile))) -cne (Hash-Bytes $hostsBefore)) { throw 'n08_restore_failed' }
            } catch { $restoreFailed = $true }
        }
        # An unproved child tree must remain contained. The disposable hosted
        # runner is discarded on this hard failure; never unblock owned Node.
        if ($InstalledClientMatrix) { try { Remove-HpmInstalledClientContainment $installedState $ownedScenarioStopped } catch { $restoreFailed = $true } }
        if ($ownedScenarioStopped) {
            if ($null -ne $wfpLease) { try { $wfpLease.Dispose() } catch { $restoreFailed = $true } }
            if ($firewallCreated) { try { Remove-NetFirewallRule -Name $firewallName -ErrorAction Stop } catch { $restoreFailed = $true } }
            foreach ($profile in $profiles) { try { Set-NetFirewallProfile -Name $profile.Name -Enabled $profile.Enabled } catch { $restoreFailed = $true } }
        } else { $restoreFailed = $true }
        foreach ($certificate in @($leaf, $ca)) {
            if ($null -ne $certificate) { try { Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $certificate.Thumbprint) -DeleteKey -Force } catch { $restoreFailed = $true } }
        }
        try { Remove-HpmN08CreatedMaterials $networkRoot $networkRootCreated $networkRootLease $materialLeases } catch { $restoreFailed = $true }
        foreach ($lease in $materialLeases.Values) { try { $lease.Dispose() } catch { $restoreFailed = $true } }
        if ($null -ne $networkRootLease) { try { $networkRootLease.Dispose() } catch { $restoreFailed = $true } }
    }
    if ($restoreFailed) {
        Write-Information 'hpm_network_failed_stage=restore' -InformationAction Continue
        throw 'n08_network_restore_failed'
    }
    if ($primaryFailed) { throw 'n08_network_rejected' }
    return $receipt
}
