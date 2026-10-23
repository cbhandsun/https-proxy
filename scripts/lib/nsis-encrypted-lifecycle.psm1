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

function Assert-HpmLegacyRefusalReceipt {
    param([object]$Receipt)
    if ($null -eq $Receipt -or ($Receipt.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'fileCount,preserved,refused,statusCode' -or
        $Receipt.refused -isnot [bool] -or -not $Receipt.refused -or $Receipt.preserved -isnot [bool] -or -not $Receipt.preserved -or
        ($Receipt.statusCode -isnot [int] -and $Receipt.statusCode -isnot [long]) -or $Receipt.statusCode -ne 503 -or
        ($Receipt.fileCount -isnot [int] -and $Receipt.fileCount -isnot [long]) -or $Receipt.fileCount -lt 3 -or $Receipt.fileCount -gt 16) {
        throw 'Legacy refusal receipt failed.'
    }
}

function Invoke-HpmInstalledRecoveryFixture {
    param([string]$InstallDirectory, [string]$StoreDirectory, [string]$ManifestSha256, [ValidateSet('seed', 'read', 'resave', 'refuse-legacy')][string]$Operation)
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
        if ($Operation -ceq 'refuse-legacy') { Assert-HpmLegacyRefusalReceipt $result.receipt }
        else { Assert-HpmEncryptedReceipt $result.receipt }
        return $result.receipt
    } finally { $process.Dispose() }
}

function Invoke-HpmEncryptedLifecycleSequence {
    param([hashtable]$Operations)
    foreach ($name in @('Install', 'Stop', 'Inspect', 'Seed', 'Read', 'RefuseLegacy', 'CheckFixtures', 'RuntimeBoundaries', 'Uninstall', 'CheckRemoved')) {
        if ($Operations[$name] -isnot [scriptblock]) { throw 'Encrypted lifecycle operation is missing.' }
    }
    & $Operations.Install 'baseline'; & $Operations.Stop
    $baseline = & $Operations.Inspect 'baseline'
    if ([string]$baseline -cnotmatch '\A[a-fA-F0-9]{64}\z') { throw 'Encrypted baseline identity failed.' }
    & $Operations.Seed 'legacy'
    & $Operations.Install 'current'; & $Operations.Stop
    $current = & $Operations.Inspect 'current'
    if ([string]$current -cnotmatch '\A[a-fA-F0-9]{64}\z' -or $current -ieq $baseline) { throw 'Encrypted upgrade identity failed.' }
    & $Operations.RefuseLegacy
    & $Operations.Seed 'anchored'
    & $Operations.Read 'current' 'anchored' 'read'
    & $Operations.Read 'current' 'anchored' 'resave'
    & $Operations.CheckFixtures
    & $Operations.RuntimeBoundaries
    & $Operations.Install 'baseline'; & $Operations.Stop
    if ((& $Operations.Inspect 'baseline') -cne $baseline) { throw 'Encrypted rollback identity failed.' }
    # The 625-source reader accepts the unchanged on-disk format, but does not
    # enforce independent anchors. Read compatibility grants no rollback safety.
    & $Operations.Read 'baseline' 'legacy' 'read'
    & $Operations.Read 'baseline' 'anchored' 'read'
    & $Operations.CheckFixtures
    & $Operations.Install 'current'; & $Operations.Stop
    if ((& $Operations.Inspect 'current') -cne $current) { throw 'Encrypted reinstall identity failed.' }
    & $Operations.Read 'current' 'anchored' 'read'
    & $Operations.RefuseLegacy
    & $Operations.CheckFixtures
    & $Operations.Uninstall; & $Operations.Stop; & $Operations.CheckRemoved; & $Operations.CheckFixtures
}

Export-ModuleMember -Function Assert-HpmEncryptedReceipt, Compare-HpmEncryptedReceipt, Assert-HpmLegacyRefusalReceipt, Invoke-HpmInstalledRecoveryFixture, Invoke-HpmEncryptedLifecycleSequence
