$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-lifecycle.psm1') -Force
$script:expectedFailureCases = 0
function Assert-Throws {
    param([scriptblock]$Action)
    $threw = $false
    try { & $Action } catch { $threw = $true }
    if (-not $threw) { throw 'Expected a failure.' }
    $script:expectedFailureCases++
}
$baseline = 'a' * 40
$current = 'b' * 40
Assert-HpmLifecycleCommitPair $baseline $current
foreach ($invalid in @('', 'main', ('a' * 39), ('a' * 41), ('g' * 40), ('a' * 40 + "`n"), ('a' * 40 + ';whoami'))) {
    Assert-Throws { Assert-HpmLifecycleCommitPair $invalid $current }
}
Assert-Throws { Assert-HpmLifecycleCommitPair $baseline $baseline.ToUpperInvariant() }
$environment = @{ GITHUB_ACTIONS = 'true'; RUNNER_ENVIRONMENT = 'github-hosted'; RUNNER_OS = 'Windows' }
Assert-HpmLifecycleIsolation $environment $false $false
Assert-Throws { Assert-HpmLifecycleIsolation @{} $false $false }
Assert-Throws { Assert-HpmLifecycleIsolation $environment $true $false }
Assert-Throws { Assert-HpmLifecycleIsolation $environment $false $true }
Assert-Throws { Assert-HpmLifecycleIsolation @{ GITHUB_ACTIONS = 'true'; RUNNER_ENVIRONMENT = 'self-hosted'; RUNNER_OS = 'Windows' } $false $false }
$root = Join-Path ([IO.Path]::GetTempPath()) ('hpm-lifecycle-mock-' + [Guid]::NewGuid().ToString('N'))
Assert-HpmLifecycleChildPath $root (Join-Path $root 'child')
Assert-Throws { Assert-HpmLifecycleChildPath $root $root }
Assert-Throws { Assert-HpmLifecycleChildPath $root ($root + '-other/child') }
Assert-Throws { Assert-HpmLifecycleChildPath $root (Join-Path $root '../escape') }
$outside = $root + '-outside'
$link = Join-Path $root 'redirect'
Assert-HpmLifecycleChildPath ([IO.Path]::GetTempPath()) $root
Assert-HpmLifecycleChildPath ([IO.Path]::GetTempPath()) $outside
try {
    New-Item -ItemType Directory -Path $root, $outside | Out-Null
    Assert-HpmLifecycleArtifactPath ([IO.Path]::GetTempPath()) $root 'Container'
    foreach ($candidate in @('', '\\server\share\setup.exe', '//server/share/setup.exe', '\\?\C:\setup.exe', (Join-Path $root '../escape.exe'))) {
        Assert-Throws { Assert-HpmLifecycleArtifactPath $root $candidate 'Leaf' }
    }
    $artifact = Join-Path $root 'current-setup.exe'
    [IO.File]::WriteAllText($artifact, 'synthetic executable placeholder; never executed')
    Assert-HpmLifecycleArtifactPath $root $artifact 'Leaf'
    Assert-Throws { Assert-HpmLifecycleArtifactPath $root $artifact 'Container' }
    $hardLink = Join-Path $root 'linked-setup.exe'
    New-Item -ItemType HardLink -Path $hardLink -Target $artifact | Out-Null
    Assert-Throws { Assert-HpmLifecycleArtifactPath $root $hardLink 'Leaf' }
    Assert-Throws { Assert-HpmLifecycleArtifactPath $root $artifact 'Leaf' }
    $linkType = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $linkType -Path $link -Target $outside | Out-Null
    Assert-Throws { Assert-HpmLifecycleChildPath $root (Join-Path $link 'child') }
    Assert-Throws { Assert-HpmLifecycleArtifactPath $root $link 'Container' }
} finally {
    if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
    if ($hardLink -and (Test-Path -LiteralPath $hardLink)) { Remove-Item -LiteralPath $hardLink -Force }
    if ($artifact -and (Test-Path -LiteralPath $artifact)) { Remove-Item -LiteralPath $artifact -Force }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root }
    if (Test-Path -LiteralPath $outside) { Remove-Item -LiteralPath $outside }
}

function New-MockOperations {
    return @{
        Install = { param($phase) $script:events.Add('install:' + $phase) }
        Stop = { $script:events.Add('stop') }
        Inspect = { param($phase) $script:events.Add('inspect:' + $phase); if ($phase -eq 'baseline') { 'A' * 64 } else { 'B' * 64 } }
        Seed = { $script:events.Add('seed') }
        CheckFixtures = { $script:events.Add('fixtures') }
        Uninstall = { $script:events.Add('uninstall') }
        CheckRemoved = { $script:events.Add('removed') }
    }
}
$script:events = [Collections.Generic.List[string]]::new()
Invoke-HpmLifecycleSequence (New-MockOperations)
$expected = 'install:baseline,stop,inspect:baseline,seed,install:current,stop,inspect:current,fixtures,install:baseline,stop,inspect:baseline,fixtures,uninstall,stop,removed,fixtures'
if (($script:events -join ',') -cne $expected) { throw 'Lifecycle ordering is incorrect.' }
Assert-Throws { Invoke-HpmLifecycleSequence @{} }
foreach ($name in @('Install', 'Stop', 'Inspect', 'Seed', 'CheckFixtures', 'Uninstall', 'CheckRemoved')) {
    $operations = New-MockOperations
    $operations[$name] = { throw 'Synthetic operation failure.' }
    Assert-Throws { Invoke-HpmLifecycleSequence $operations }
}
$operations = New-MockOperations
$operations.Inspect = { 'A' * 64 }
Assert-Throws { Invoke-HpmLifecycleSequence $operations }
$operations.Inspect = { 'invalid' }
Assert-Throws { Invoke-HpmLifecycleSequence $operations }
$operations.Inspect = { param($phase) if ($phase -eq 'baseline') { 'A' * 64 } else { 'B' * 64 + "`n" } }
Assert-Throws { Invoke-HpmLifecycleSequence $operations }
$script:inspections = 0
$operations.Inspect = { $script:inspections++; if ($script:inspections -eq 1) { 'A' * 64 } elseif ($script:inspections -eq 2) { 'B' * 64 } else { 'C' * 64 } }
Assert-Throws { Invoke-HpmLifecycleSequence $operations }
Write-Output "NSIS lifecycle pure guards and mocked sequence passed: expectedFailureCases=$script:expectedFailureCases; no installation executed."
