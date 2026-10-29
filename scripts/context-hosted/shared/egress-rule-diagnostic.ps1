Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Diagnostic only: never launches the copied program or grants qualification.
function Find-HpmEgressDiagnosticRule {
    param([Parameter(Mandatory)][string]$Name)
    $queryErrors = @()
    $rules = @(Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue -ErrorVariable queryErrors)
    foreach ($queryError in $queryErrors) {
        if ($queryError.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) { throw 'egress_probe_query_failed' }
    }
    if ($rules.Count -gt 1) { throw 'egress_probe_query_failed' }
    if ($rules.Count -eq 1) { return $rules[0] }
    return $null
}

function Invoke-HpmEgressRuleProbe {
    param(
        [Parameter(Mandatory)][ValidateSet('original', 'ipv4', 'ipv6', 'ipv6_split', 'full_split')][string]$Case,
        [Parameter(Mandatory)][ValidatePattern('\AHPM-EGRESS-DIAG-[a-f0-9]{32}\z')][string]$Name,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Program
    )
    $ipv4 = @('0.0.0.0-127.0.0.0', '127.0.0.2-255.255.255.255')
    $addresses = switch ($Case) {
        'original' { $ipv4; '::/0' }
        'ipv4' { $ipv4 }
        'ipv6' { '::/0' }
        'ipv6_split' { '::/1'; '8000::/1' }
        'full_split' { $ipv4; '::/1'; '8000::/1' }
    }
    $result = [ordered]@{ case = $Case; created = $false; verified = $false; cleaned = $false; stage = 'collision'; category = $null; hresult = $null; nativeCode = $null }
    $owned = $false
    try {
        if ($null -ne (Find-HpmEgressDiagnosticRule -Name $Name)) { throw 'egress_probe_collision' }
        $owned = $true
        $result.stage = 'create'
        New-NetFirewallRule -Name $Name -DisplayName $Name -Direction Outbound -Action Block -Enabled True -Profile Any -Program $Program -RemoteAddress @($addresses) -ErrorAction Stop | Out-Null
        $result.created = $true
        $result.stage = 'verify'
        $rule = Get-NetFirewallRule -Name $Name -ErrorAction Stop
        $application = $rule | Get-NetFirewallApplicationFilter -ErrorAction Stop
        if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block' -or $rule.Direction -ne 'Outbound' -or $application.Program -cne $Program) { throw 'egress_probe_identity' }
        $result.stage = 'address_filter'
        $filter = $rule | Get-NetFirewallAddressFilter -ErrorAction Stop
        $actual = @($filter.RemoteAddress | ForEach-Object { $_.Trim().ToLowerInvariant() } | Sort-Object -Unique)
        $expected = @($addresses | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique)
        if ([string]::Join("`n", $actual) -cne [string]::Join("`n", $expected)) { throw 'egress_probe_addresses' }
        $result.verified = $true
    } catch {
        # No native messages, paths, rule contents or command arguments escape.
        $result.category = [int]$_.CategoryInfo.Category
        $result.hresult = [int]$_.Exception.HResult
        if ($_.Exception -is [Microsoft.Management.Infrastructure.CimException]) {
            $result.nativeCode = [long]$_.Exception.NativeErrorCode
        }
    } finally {
        if ($owned) {
            try {
                # Also reclaim a rule if a native create applied before throwing.
                if ($null -ne (Find-HpmEgressDiagnosticRule -Name $Name)) {
                    Remove-NetFirewallRule -Name $Name -ErrorAction Stop
                }
                if ($null -ne (Find-HpmEgressDiagnosticRule -Name $Name)) { throw 'egress_probe_cleanup' }
                $result.cleaned = $true
            } catch { $result.stage = 'cleanup'; $result.cleaned = $false }
        }
    }
    return [pscustomobject]$result
}

function Invoke-HpmHostedEgressDiagnostic {
    $owned = $null
    $program = $null
    $created = $false
    try {
        if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
            $env:RUNNER_OS -cne 'Windows' -or [string]::IsNullOrEmpty($env:RUNNER_TEMP)) { throw 'egress_diagnostic_rejected' }
        $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'egress_diagnostic_rejected' }
        $temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
        if ($temp.StartsWith('\\')) { throw 'egress_diagnostic_rejected' }
        $current = $temp
        while ($true) {
            $item = Get-Item -LiteralPath $current -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'egress_diagnostic_rejected' }
            $parent = [IO.Path]::GetDirectoryName($current)
            if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
            $current = $parent
        }
        $owned = [IO.Path]::GetFullPath((Join-Path $temp ('hpm-egress-diagnostic-' + [Guid]::NewGuid().ToString('N'))))
        if ([IO.Path]::GetDirectoryName($owned) -cne $temp -or (Test-Path -LiteralPath $owned)) { throw 'egress_diagnostic_rejected' }
        New-Item -ItemType Directory -Path $owned | Out-Null
        $created = $true
        if (((Get-Item -LiteralPath $owned).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'egress_diagnostic_rejected' }
        $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
        $program = Join-Path $owned 'probe-node.exe'
        Copy-Item -LiteralPath $node -Destination $program
        if ((Get-FileHash -LiteralPath $node).Hash -cne (Get-FileHash -LiteralPath $program).Hash) { throw 'egress_diagnostic_rejected' }
        foreach ($case in @('original', 'ipv4', 'ipv6', 'ipv6_split', 'full_split')) {
            $result = Invoke-HpmEgressRuleProbe -Case $case -Name ('HPM-EGRESS-DIAG-' + [Guid]::NewGuid().ToString('N')) -Program $program
            $result | ConvertTo-Json -Compress
            if (-not $result.cleaned) { throw 'egress_diagnostic_rejected' }
        }
    } finally {
        # Only the two exact paths created above; no recursive deletion.
        if ($created -and $null -ne $program -and (Test-Path -LiteralPath $program)) { Remove-Item -LiteralPath $program -Force }
        if ($created -and (Test-Path -LiteralPath $owned)) { Remove-Item -LiteralPath $owned -Force }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-HpmHostedEgressDiagnostic } catch { throw 'egress_diagnostic_failed' }
}
