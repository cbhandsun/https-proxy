param([Parameter(Mandatory)][string]$Helper)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('n08_material_phase=script_started')
. $Helper
[Console]::Error.WriteLine('n08_material_phase=helper_loaded')
$root = Join-Path ([IO.Path]::GetTempPath()) ('hpm-n08-material-fixture-' + [Guid]::NewGuid().ToString('N'))
$leases = @()
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $existing = Join-Path $root 'existing'
    New-Item -ItemType Directory -Path $existing | Out-Null
    foreach ($name in @('server.pfx', '.pfx-password', 'ca.pem')) { [IO.File]::WriteAllText((Join-Path $existing $name), 'SYNTHETIC_PRESERVE_' + $name) }
    $before = @{}
    foreach ($file in (Get-ChildItem -LiteralPath $existing -Force)) { $before[$file.Name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
    [Console]::Error.WriteLine('n08_material_phase=sentinels_hashed')
    # Exact production cleanup helper; never dot-source or invoke network.ps1.
    Remove-HpmN08CreatedMaterials $existing $false $null @{}
    foreach ($name in $before.Keys) { if ((Get-FileHash -LiteralPath (Join-Path $existing $name) -Algorithm SHA256).Hash -cne $before[$name]) { throw 'fixture_failed' } }

    [Console]::Error.WriteLine('n08_material_phase=collision_checked')

    [Console]::Error.WriteLine('n08_material_phase=lease_compile_started')
    Initialize-HpmN08ArtifactLease
    [Console]::Error.WriteLine('n08_material_phase=lease_compiled')
    $other = Join-Path $root 'other'
    New-Item -ItemType Directory -Path $other | Out-Null
    $wrongLease = [HpmN08ArtifactLease]::new($other, $true)
    $leases += $wrongLease
    $rejected = $false
    try { Remove-HpmN08CreatedMaterials $existing $true $wrongLease @{} } catch { $rejected = $true }
    if (-not $rejected) { throw 'fixture_failed' }
    foreach ($name in $before.Keys) { if ((Get-FileHash -LiteralPath (Join-Path $existing $name) -Algorithm SHA256).Hash -cne $before[$name]) { throw 'fixture_failed' } }

    [Console]::Error.WriteLine('n08_material_phase=identity_checked')

    $owned = Join-Path $root 'owned'
    New-Item -ItemType Directory -Path $owned | Out-Null
    $directoryLease = [HpmN08ArtifactLease]::new($owned, $true)
    $leases += $directoryLease
    $materials = @{}
    foreach ($name in @('server.pfx', '.pfx-password', 'ca.pem')) {
        $file = Join-Path $owned $name
        [IO.File]::WriteAllText($file, 'SYNTHETIC_OWNED_' + $name)
        $materials[$name] = [HpmN08ArtifactLease]::new($file, $false)
        $leases += $materials[$name]
    }
    Remove-HpmN08CreatedMaterials $owned $true $directoryLease $materials
    if (@(Get-ChildItem -LiteralPath $owned -Force).Count -ne 0) { throw 'fixture_failed' }
    [Console]::Error.WriteLine('n08_material_phase=materials_removed')
    [Console]::Out.WriteLine('{"collisionPreserved":true,"identityMismatchPreserved":true,"ownedMaterialsRemoved":true}')
} catch {
    [Console]::Error.WriteLine('n08_material_fixture_failed')
    exit 1
} finally {
    foreach ($lease in $leases) { $lease.Dispose() }
    $resolved = [IO.Path]::GetFullPath($root)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($resolved) -cne $temp -or [IO.Path]::GetFileName($resolved) -cnotmatch '\Ahpm-n08-material-fixture-[a-f0-9]{32}\z') { throw 'fixture_cleanup_rejected' }
    if (Test-Path -LiteralPath $resolved) { Assert-HpmN08MaterialPath $resolved $true; Remove-Item -LiteralPath $resolved -Recurse -Force }
    [Console]::Error.WriteLine('n08_material_phase=cleanup_finished')
}
