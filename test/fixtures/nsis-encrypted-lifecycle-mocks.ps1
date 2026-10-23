$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-encrypted-lifecycle.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-private-artifact.psm1') -Force
$checks = @{ count = 0 }
function Refuses([scriptblock]$Action) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    if (-not $failed) { throw 'Expected bounded refusal.' }
    $checks.count++
}
function Operations {
    param([Collections.Generic.List[string]]$Events)
    return @{
        Install = { param($phase) $Events.Add('install:' + $phase) }.GetNewClosure()
        Stop = { $Events.Add('stop') }.GetNewClosure()
        Inspect = { param($phase) $Events.Add('inspect:' + $phase); if ($phase -eq 'baseline') { 'a' * 64 } else { 'b' * 64 } }.GetNewClosure()
        Seed = { param($role) $Events.Add('seed:' + $role) }.GetNewClosure()
        Read = { param($phase, $role, $operation) $Events.Add('read:' + $phase + ':' + $role + ':' + $operation) }.GetNewClosure()
        RefuseLegacy = { $Events.Add('refuse-legacy') }.GetNewClosure()
        CheckFixtures = { $Events.Add('fixtures') }.GetNewClosure()
        RuntimeBoundaries = { $Events.Add('runtime-boundaries') }.GetNewClosure()
        Uninstall = { $Events.Add('uninstall') }.GetNewClosure()
        CheckRemoved = { $Events.Add('removed') }.GetNewClosure()
    }
}
$events = [Collections.Generic.List[string]]::new()
Invoke-HpmEncryptedLifecycleSequence (Operations $events)
$expected = 'install:baseline,stop,inspect:baseline,seed:legacy,install:current,stop,inspect:current,refuse-legacy,seed:anchored,read:current:anchored:read,read:current:anchored:resave,fixtures,runtime-boundaries,install:baseline,stop,inspect:baseline,read:baseline:legacy:read,read:baseline:anchored:read,fixtures,install:current,stop,inspect:current,read:current:anchored:read,refuse-legacy,fixtures,uninstall,stop,removed,fixtures'
if (($events -join ',') -cne $expected) { throw 'Encrypted lifecycle sequence differs.' }
foreach ($name in @('Install', 'Stop', 'Inspect', 'Seed', 'Read', 'RefuseLegacy', 'CheckFixtures', 'RuntimeBoundaries', 'Uninstall', 'CheckRemoved')) {
    $operations = Operations ([Collections.Generic.List[string]]::new())
    $operations.Remove($name)
    Refuses { Invoke-HpmEncryptedLifecycleSequence $operations }
    $operations = Operations ([Collections.Generic.List[string]]::new())
    $operations[$name] = { throw 'fixed-failure' }
    Refuses { Invoke-HpmEncryptedLifecycleSequence $operations }
}
$events = [Collections.Generic.List[string]]::new()
$operations = Operations $events
$operations.RuntimeBoundaries = { $events.Add('runtime-boundaries'); throw 'fixed-runtime-boundary-failure' }.GetNewClosure()
Refuses { Invoke-HpmEncryptedLifecycleSequence $operations }
if (@($events | Where-Object { $_ -eq 'install:baseline' }).Count -ne 1 -or $events.Contains('uninstall')) { throw 'Boundary failure must stop before rollback.' }
$events = [Collections.Generic.List[string]]::new()
$operations = Operations $events
$operations.Read = { param($phase, $role, $operation) $events.Add('read:' + $phase + ':' + $role + ':' + $operation); if ($phase -eq 'baseline') { throw 'old-reader-refused' } }.GetNewClosure()
Refuses { Invoke-HpmEncryptedLifecycleSequence $operations }
if ($events.Contains('uninstall') -or @($events | Where-Object { $_ -eq 'install:current' }).Count -ne 1) { throw 'Rollback refusal must fail before current reinstall.' }
$events = [Collections.Generic.List[string]]::new()
$operations = Operations $events
$operations.RefuseLegacy = { $events.Add('refuse-legacy'); throw 'legacy-unexpectedly-readable' }.GetNewClosure()
Refuses { Invoke-HpmEncryptedLifecycleSequence $operations }
if ($events.Contains('seed:anchored') -or $events.Contains('uninstall')) { throw 'Legacy refusal failure must stop before fresh seeding.' }
$legacyReceipt = [pscustomobject]@{ refused = $true; preserved = $true; statusCode = 503; fileCount = 3 }
Assert-HpmLegacyRefusalReceipt $legacyReceipt
foreach ($name in @('refused', 'preserved', 'statusCode', 'fileCount')) {
    $copy = $legacyReceipt | ConvertTo-Json | ConvertFrom-Json
    $copy.$name = 'invalid'
    Refuses { Assert-HpmLegacyRefusalReceipt $copy }
}
foreach ($receipt in @(
    [pscustomobject]@{ refused = $false; preserved = $true; statusCode = 503; fileCount = 3 },
    [pscustomobject]@{ refused = $true; preserved = $false; statusCode = 503; fileCount = 3 },
    [pscustomobject]@{ refused = $true; preserved = $true; statusCode = 500; fileCount = 3 },
    [pscustomobject]@{ refused = $true; preserved = $true; statusCode = 503; fileCount = 2 },
    [pscustomobject]@{ refused = $true; preserved = $true; statusCode = 503; fileCount = 17 },
    [pscustomobject]@{ refused = $true; preserved = $true; statusCode = 503; fileCount = 3; extra = $true }
)) { Refuses { Assert-HpmLegacyRefusalReceipt $receipt } }
$receipt = [pscustomobject]@{ budgetSha256 = 'a' * 64; callCount = 1; expiresAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 86400000; keySha256 = 'b' * 64; originalSha256 = 'c' * 64; rootId = 'hbs_' + ('d' * 32); sourceId = 'hce_' + ('e' * 32) }
Compare-HpmEncryptedReceipt $receipt $receipt
foreach ($name in @('budgetSha256', 'keySha256', 'originalSha256', 'rootId', 'sourceId')) {
    $copy = $receipt | ConvertTo-Json | ConvertFrom-Json
    $copy.$name = 'private-invalid'
    Refuses { Compare-HpmEncryptedReceipt $receipt $copy }
}
$copy = $receipt | ConvertTo-Json | ConvertFrom-Json
$copy.expiresAt++
Refuses { Compare-HpmEncryptedReceipt $receipt $copy }
$copy = $receipt | ConvertTo-Json | ConvertFrom-Json
$copy.callCount++
Refuses { Compare-HpmEncryptedReceipt $receipt $copy }
Refuses { Assert-HpmEncryptedReceipt ([pscustomobject]@{}) }
Assert-HpmPrivateArtifactInput 'owner/repository' '123' 'https://api.github.com'
foreach ($id in @('', '0', '-1', '1;echo', '../1', '1.5', '12345678901234567')) { Refuses { Assert-HpmPrivateArtifactInput 'owner/repository' $id 'https://api.github.com' } }
Refuses { Assert-HpmPrivateArtifactInput 'owner/repo/escape' '123' 'https://api.github.com' }
Refuses { Assert-HpmPrivateArtifactInput 'owner/repository' '123' 'https://attacker.invalid' }
$repository = [pscustomobject]@{ private = $true }
$metadata = [pscustomobject]@{ id = 123; name = 'hpm-old-nsis-e7dc2ec'; expired = $false; size_in_bytes = 42 }
Assert-HpmPrivateArtifactMetadata $repository $metadata '123'
Refuses { Assert-HpmPrivateArtifactMetadata ([pscustomobject]@{ private = $false }) $metadata '123' }
Refuses { Assert-HpmPrivateArtifactMetadata $repository $metadata '124' }
foreach ($name in @('name', 'expired', 'size_in_bytes')) {
    $copy = $metadata | ConvertTo-Json | ConvertFrom-Json
    $copy.$name = 'invalid'
    Refuses { Assert-HpmPrivateArtifactMetadata $repository $copy '123' }
}
foreach ($size in @(0, -1, 104857601)) {
    $copy = $metadata | ConvertTo-Json | ConvertFrom-Json
    $copy.size_in_bytes = $size
    Refuses { Assert-HpmPrivateArtifactMetadata $repository $copy '123' }
}
$copy = $metadata | ConvertTo-Json | ConvertFrom-Json
$copy.expired = $true
Refuses { Assert-HpmPrivateArtifactMetadata $repository $copy '123' }
$output = [IO.MemoryStream]::new()
$source = [IO.MemoryStream]::new([byte[]]@(1, 2, 3))
try {
    Copy-HpmBoundedArchiveEntry $source $output 3 3
    if ($output.Length -ne 3) { throw 'Bounded normal copy failed.' }
} finally { $source.Dispose(); $output.Dispose() }
foreach ($case in @(@(3, 2, 3), @(2, 3, 3), @(3, 3, 2), @(3, -1, 3), @(3, 3, 104857601))) {
    $source = [IO.MemoryStream]::new([byte[]]::new($case[0]))
    $output = [IO.MemoryStream]::new()
    try {
        Refuses { Copy-HpmBoundedArchiveEntry $source $output $case[1] $case[2] }
        if ($output.Length -gt [Math]::Max(0, [Math]::Min($case[1], $case[2]))) { throw 'Bounded failure wrote excess bytes.' }
    } finally { $source.Dispose(); $output.Dispose() }
}
$source = [IO.MemoryStream]::new()
$output = [IO.MemoryStream]::new()
try { Copy-HpmBoundedArchiveEntry $source $output 0 1 } finally { $source.Dispose(); $output.Dispose() }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('hpm-encrypted-zip-unit-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary -ErrorAction Stop | Out-Null
try {
    $index = 0
    foreach ($names in @(
        @('../escape.exe', 'identity.json'),
        @('HTTPS Proxy Manager_0.1.0_x64-setup.exe', 'HTTPS Proxy Manager_0.1.0_x64-setup.exe'),
        @('HTTPS Proxy Manager_0.1.0_x64-setup.exe', 'identity.json', 'extra'),
        @('HTTPS Proxy Manager_0.1.0_x64-setup.exe', 'identity.json')
    )) {
        $index++
        $zipPath = Join-Path $temporary ($index.ToString() + '.zip')
        $destination = Join-Path $temporary ($index.ToString() + '-out')
        $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($name in $names) {
                $entry = $zip.CreateEntry($name)
                $stream = $entry.Open()
                try { $stream.WriteByte(1) } finally { $stream.Dispose() }
            }
        } finally { $zip.Dispose() }
        # Last shape is valid but fake bytes must fail the fixed installer hash.
        Refuses { Expand-HpmPrivateBaselineArchive $zipPath $destination }
    }
    if (Test-Path -LiteralPath (Join-Path $temporary 'escape.exe')) { throw 'Archive entry escaped its destination.' }
} finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'hpm-encrypted-zip-unit-*') { throw 'Unit cleanup path refused.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output ('encryptedExpectedFailures=' + $checks.count + '; installerExecutions=0; networkRequests=0')
