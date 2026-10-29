Set-StrictMode -Version Latest

function Assert-HpmLifecycleCommitPair {
    param([string]$BaselineSha, [string]$CurrentSha)
    if ($BaselineSha -cnotmatch '\A[0-9a-fA-F]{40}\z' -or $CurrentSha -cnotmatch '\A[0-9a-fA-F]{40}\z') {
        throw 'Lifecycle qualification requires two explicit full commit SHAs.'
    }
    if ($BaselineSha -ieq $CurrentSha) { throw 'Baseline and current commits must differ.' }
}

function Assert-HpmLifecycleIsolation {
    param([hashtable]$Environment, [bool]$ExistingInstallation, [bool]$ExistingProcess)
    if ($Environment.GITHUB_ACTIONS -cne 'true' -or $Environment.RUNNER_ENVIRONMENT -cne 'github-hosted' -or $Environment.RUNNER_OS -cne 'Windows') {
        throw 'Lifecycle qualification runs only on a disposable GitHub-hosted Windows runner.'
    }
    if ($ExistingInstallation -or $ExistingProcess) {
        throw 'Lifecycle qualification refuses an existing installation or application process.'
    }
}

function Assert-HpmLifecycleChildPath {
    param([string]$Root, [string]$Candidate)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $fullCandidate = [IO.Path]::GetFullPath($Candidate)
    if (-not $fullCandidate.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Lifecycle paths must stay strictly inside the disposable root.'
    }
    # Existing ancestors must not redirect writes or recursive cleanup outside the root.
    $ancestor = $fullCandidate
    while ($ancestor -and $ancestor.Length -ge $fullRoot.Length) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Lifecycle paths must not contain reparse points.'
            }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
}

function Invoke-HpmLifecycleSequence {
    param([hashtable]$Operations)
    foreach ($name in @('Install', 'Stop', 'Inspect', 'Seed', 'CheckFixtures', 'Uninstall', 'CheckRemoved')) {
        if (-not ($Operations[$name] -is [scriptblock])) { throw "Lifecycle operation is missing: $name" }
    }
    & $Operations.Install 'baseline'
    & $Operations.Stop
    $baseline = & $Operations.Inspect 'baseline'
    if ([string]$baseline -cnotmatch '\A[A-Fa-f0-9]{64}\z') { throw 'Baseline application hash is invalid.' }
    & $Operations.Seed
    & $Operations.Install 'current'
    & $Operations.Stop
    $current = & $Operations.Inspect 'current'
    if ([string]$current -cnotmatch '\A[A-Fa-f0-9]{64}\z' -or $current -ieq $baseline) {
        throw 'Upgrade must install a different application binary.'
    }
    & $Operations.CheckFixtures
    & $Operations.Install 'baseline'
    & $Operations.Stop
    $rollback = & $Operations.Inspect 'baseline'
    if ($rollback -cne $baseline) { throw 'Rollback did not restore the baseline application binary.' }
    & $Operations.CheckFixtures
    & $Operations.Uninstall
    & $Operations.Stop
    & $Operations.CheckRemoved
    & $Operations.CheckFixtures
}

function Assert-HpmLifecycleArtifactPath {
    param([string]$Workspace, [string]$Candidate, [ValidateSet('Leaf', 'Container')][string]$PathType)
    if ([string]::IsNullOrWhiteSpace($Workspace) -or [string]::IsNullOrWhiteSpace($Candidate)) {
        throw 'Lifecycle artifact paths are required.'
    }
    if ($Workspace -match '\A[\\/]{2}' -or $Candidate -match '\A[\\/]{2}') {
        throw 'Lifecycle artifacts must not use UNC or device paths.'
    }
    Assert-HpmLifecycleChildPath $Workspace $Candidate
    if (-not (Test-Path -LiteralPath $Candidate -PathType $PathType)) { throw 'Lifecycle artifact path has an invalid type or is missing.' }
    $item = Get-Item -LiteralPath $Candidate -Force
    $linkType = $item.PSObject.Properties['LinkType']
    if ($linkType -and $linkType.Value -eq 'HardLink') { throw 'Lifecycle artifacts must not be hard links.' }
}

Export-ModuleMember -Function Assert-HpmLifecycleCommitPair, Assert-HpmLifecycleIsolation, Assert-HpmLifecycleChildPath, Assert-HpmLifecycleArtifactPath, Invoke-HpmLifecycleSequence
