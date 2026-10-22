Set-StrictMode -Version Latest

function Assert-HpmEncryptedReceipt {
    param([object]$Receipt)
    $keys = @('budgetSha256', 'callCount', 'expiresAt', 'keySha256', 'originalSha256', 'rootId', 'sourceId')
    if ($null -eq $Receipt -or ($Receipt.PSObject.Properties.Name | Sort-Object) -join ',' -cne ($keys -join ',')) { throw 'Encrypted lifecycle result schema failed.' }
    foreach ($name in @('budgetSha256', 'keySha256', 'originalSha256')) {
        if ($Receipt.$name -isnot [string] -or $Receipt.$name -cnotmatch '\A[a-f0-9]{64}\z') { throw 'Encrypted lifecycle digest failed.' }
    }
    if ($Receipt.rootId -isnot [string] -or $Receipt.rootId -cnotmatch '\Ahbs_[a-f0-9]{32}\z' -or $Receipt.sourceId -isnot [string] -or $Receipt.sourceId -cnotmatch '\Ahce_[a-f0-9]{32}\z') { throw 'Encrypted lifecycle identity failed.' }
    foreach ($name in @('callCount', 'expiresAt')) {
        if (($Receipt.$name -isnot [long] -and $Receipt.$name -isnot [int]) -or $Receipt.$name -lt 0 -or $Receipt.$name -gt 9007199254740991) { throw 'Encrypted lifecycle integer failed.' }
    }
    if ($Receipt.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { throw 'Encrypted lifecycle deadline is no longer live.' }
}

function Compare-HpmEncryptedReceipt {
    param([object]$Baseline, [object]$Current)
    Assert-HpmEncryptedReceipt $Baseline
    Assert-HpmEncryptedReceipt $Current
    foreach ($name in $Baseline.PSObject.Properties.Name) {
        if ($Baseline.$name -cne $Current.$name) { throw 'Encrypted lifecycle changed original identity, budget, key or deadline.' }
    }
}

function Invoke-HpmInstalledRecoveryFixture {
    param([string]$InstallDirectory, [string]$StoreDirectory, [string]$ManifestSha256, [ValidateSet('seed', 'read', 'resave')][string]$Operation)
    if ($ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'Encrypted lifecycle manifest identity failed.' }
    $node = Join-Path $InstallDirectory 'runtime/node/node.exe'
    $driver = Join-Path $PSScriptRoot 'nsis-installed-recovery-fixture.cjs'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment.Remove('NODE_OPTIONS') | Out-Null
    $start.Environment.Remove('NODE_PATH') | Out-Null
    foreach ($argument in @($driver, $Operation, $InstallDirectory, $StoreDirectory, $ManifestSha256)) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Encrypted lifecycle reader did not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(120000)) { $process.Kill($true); throw 'Encrypted lifecycle reader timed out.' }
        $output = $stdout.GetAwaiter().GetResult()
        # Discard native/Node diagnostics; never copy key output or original text into logs.
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or $output.Length -gt 4096) { throw 'Encrypted lifecycle reader failed.' }
        $result = $output | ConvertFrom-Json -ErrorAction Stop
        if (($result.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'manifestSha256,nativeCalls,receipt,sourceCount' -or $result.manifestSha256 -cne $ManifestSha256 -or ($result.nativeCalls -isnot [int] -and $result.nativeCalls -isnot [long]) -or $result.nativeCalls -lt 1 -or $result.nativeCalls -gt 4 -or ($result.sourceCount -isnot [int] -and $result.sourceCount -isnot [long]) -or $result.sourceCount -lt 1 -or $result.sourceCount -gt 4096) { throw 'Encrypted lifecycle reader result failed.' }
        Assert-HpmEncryptedReceipt $result.receipt
        return $result.receipt
    } finally { $process.Dispose() }
}

function Invoke-HpmEncryptedLifecycleSequence {
    param([hashtable]$Operations)
    foreach ($name in @('Install', 'Stop', 'Inspect', 'Seed', 'Read', 'CheckFixtures', 'RuntimeBoundaries', 'Uninstall', 'CheckRemoved')) {
        if ($Operations[$name] -isnot [scriptblock]) { throw 'Encrypted lifecycle operation is missing.' }
    }
    & $Operations.Install 'baseline'; & $Operations.Stop
    $baseline = & $Operations.Inspect 'baseline'
    if ([string]$baseline -cnotmatch '\A[a-fA-F0-9]{64}\z') { throw 'Encrypted baseline identity failed.' }
    & $Operations.Seed
    & $Operations.Install 'current'; & $Operations.Stop
    $current = & $Operations.Inspect 'current'
    if ([string]$current -cnotmatch '\A[a-fA-F0-9]{64}\z' -or $current -ieq $baseline) { throw 'Encrypted upgrade identity failed.' }
    & $Operations.Read 'current' 'resave'; & $Operations.Read 'current' 'read'; & $Operations.CheckFixtures
    & $Operations.RuntimeBoundaries
    & $Operations.Install 'baseline'; & $Operations.Stop
    if ((& $Operations.Inspect 'baseline') -cne $baseline) { throw 'Encrypted rollback identity failed.' }
    # This authentic 625-source baseline supports the same format. Any refusal
    # is a failure here; the separate 582-reader migration lane owns safe refusal.
    & $Operations.Read 'baseline' 'read'; & $Operations.CheckFixtures
    & $Operations.Install 'current'; & $Operations.Stop
    if ((& $Operations.Inspect 'current') -cne $current) { throw 'Encrypted reinstall identity failed.' }
    & $Operations.Read 'current' 'read'; & $Operations.CheckFixtures
    & $Operations.Uninstall; & $Operations.Stop; & $Operations.CheckRemoved; & $Operations.CheckFixtures
}

Export-ModuleMember -Function Assert-HpmEncryptedReceipt, Compare-HpmEncryptedReceipt, Invoke-HpmInstalledRecoveryFixture, Invoke-HpmEncryptedLifecycleSequence
