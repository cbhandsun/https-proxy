Set-StrictMode -Version Latest

function Assert-HpmPrivateArtifactInput {
    param([string]$Repository, [string]$ArtifactId, [string]$ApiUrl)
    if ($Repository -cnotmatch '\A[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\z' -or $ArtifactId -cnotmatch '\A[1-9][0-9]{0,15}\z' -or $ApiUrl -cne 'https://api.github.com') { throw 'Private baseline artifact input refused.' }
}

function Assert-HpmPrivateArtifactMetadata {
    param([object]$RepositoryMetadata, [object]$ArtifactMetadata, [string]$ArtifactId)
    if ($RepositoryMetadata.private -isnot [bool] -or -not $RepositoryMetadata.private -or [string]$ArtifactMetadata.id -cne $ArtifactId -or $ArtifactMetadata.name -cne 'hpm-old-nsis-e7dc2ec' -or $ArtifactMetadata.expired -isnot [bool] -or $ArtifactMetadata.expired -or ($ArtifactMetadata.size_in_bytes -isnot [int] -and $ArtifactMetadata.size_in_bytes -isnot [long]) -or $ArtifactMetadata.size_in_bytes -le 0 -or $ArtifactMetadata.size_in_bytes -gt 104857600) { throw 'Private baseline artifact metadata refused.' }
}

function Copy-HpmBoundedArchiveEntry {
    param([IO.Stream]$Source, [IO.Stream]$Output, [long]$DeclaredLength, [long]$Maximum)
    if ($null -eq $Source -or $null -eq $Output -or -not $Source.CanRead -or -not $Output.CanWrite -or $Maximum -lt 1 -or $Maximum -gt 104857600 -or $DeclaredLength -lt 0 -or $DeclaredLength -gt $Maximum) { throw 'Private baseline archive stream bounds refused.' }
    $buffer = [byte[]]::new([int][Math]::Min(65536, $Maximum + 1))
    [long]$total = 0
    while ($true) {
        # At the boundary read at most one extra byte, then reject it before
        # writing. Metadata cannot turn CopyTo into an unbounded decompressor.
        $requested = [int][Math]::Min($buffer.Length, [Math]::Min($DeclaredLength, $Maximum) - $total + 1)
        $count = $Source.Read($buffer, 0, $requested)
        if ($count -lt 0 -or $count -gt $requested) { throw 'Private baseline archive stream failed.' }
        if ($count -eq 0) { break }
        $total += $count
        if ($total -gt $DeclaredLength -or $total -gt $Maximum) { throw 'Private baseline archive expanded beyond its bound.' }
        $Output.Write($buffer, 0, $count)
    }
    if ($total -ne $DeclaredLength) { throw 'Private baseline archive length mismatch.' }
}

function Expand-HpmPrivateBaselineArchive {
    param([string]$ZipPath, [string]$Destination)
    if (Test-Path -LiteralPath $Destination) { throw 'Private baseline destination exists.' }
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $limits = @{ 'HTTPS Proxy Manager_0.1.0_x64-setup.exe' = 104857600; 'identity.json' = 4096 }
        if ($zip.Entries.Count -ne 2) { throw 'Private baseline archive shape refused.' }
        $seen = @{}
        foreach ($entry in $zip.Entries) {
            $kind = ($entry.ExternalAttributes -shr 16) -band 61440
            if ($entry.FullName -cnotin $limits.Keys -or $seen.ContainsKey($entry.FullName) -or $entry.Length -le 0 -or $entry.Length -gt $limits[$entry.FullName] -or ($kind -ne 0 -and $kind -ne 32768)) { throw 'Private baseline archive entry refused.' }
            $seen[$entry.FullName] = $true
        }
        New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
        foreach ($entry in $zip.Entries) {
            $target = Join-Path $Destination $entry.FullName
            $source = $entry.Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
            try { Copy-HpmBoundedArchiveEntry $source $output $entry.Length $limits[$entry.FullName] } finally { $output.Dispose(); $source.Dispose() }
        }
    } finally { $zip.Dispose() }
    $setup = Join-Path $Destination 'HTTPS Proxy Manager_0.1.0_x64-setup.exe'
    if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -ine 'e7dc2ec976df82c2679eb45b336312253caec2f7cf8e7629cc4940e147b85ce6') { throw 'Private baseline installer hash refused.' }
    $identityFile = Join-Path $Destination 'identity.json'
    if ((Get-Item -LiteralPath $identityFile).Length -gt 4096) { throw 'Private baseline identity refused.' }
    $identity = Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json -ErrorAction Stop
    if ((($identity.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'installerSha256,manifestSha256,sourceCount' -or $identity.installerSha256 -cne 'e7dc2ec976df82c2679eb45b336312253caec2f7cf8e7629cc4940e147b85ce6' -or $identity.manifestSha256 -cne '32157042cb8988a035f29c9f94261f0b18ad055670214d3daf33095a70b1f62d' -or ($identity.sourceCount -isnot [int] -and $identity.sourceCount -isnot [long]) -or $identity.sourceCount -ne 625) { throw 'Private baseline identity refused.' }
}

function Receive-HpmPrivateBaselineArtifact {
    param([string]$ArtifactId, [string]$Destination)
    Assert-HpmPrivateArtifactInput $env:GITHUB_REPOSITORY $ArtifactId $env:GITHUB_API_URL
    Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -Force
    Assert-HpmLifecycleIsolation @{ GITHUB_ACTIONS = $env:GITHUB_ACTIONS; RUNNER_ENVIRONMENT = $env:RUNNER_ENVIRONMENT; RUNNER_OS = $env:RUNNER_OS } $false $false
    Assert-HpmLifecycleChildPath $env:GITHUB_WORKSPACE $Destination
    if (-not $env:GH_TOKEN -or (Test-Path -LiteralPath $Destination)) { throw 'Private baseline download refused.' }
    $zipPath = Join-Path $env:RUNNER_TEMP ('hpm-old-baseline-' + [Guid]::NewGuid().ToString('N') + '.zip')
    Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $zipPath
    try {
        $headers = @{ Authorization = 'Bearer ' + $env:GH_TOKEN; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
        $api = $env:GITHUB_API_URL + '/repos/' + $env:GITHUB_REPOSITORY
        $repository = Invoke-RestMethod -Uri $api -Headers $headers -ErrorAction Stop
        $metadata = Invoke-RestMethod -Uri ($api + '/actions/artifacts/' + $ArtifactId) -Headers $headers -ErrorAction Stop
        Assert-HpmPrivateArtifactMetadata $repository $metadata $ArtifactId
        Invoke-WebRequest -Uri ($api + '/actions/artifacts/' + $ArtifactId + '/zip') -Headers $headers -OutFile $zipPath -ErrorAction Stop
        if ((Get-Item -LiteralPath $zipPath).Length -gt 104857600) { throw 'Private baseline download exceeded bounds.' }
        Expand-HpmPrivateBaselineArchive $zipPath $Destination
    } catch { throw 'Private baseline artifact acquisition failed.' }
    finally {
        if (Test-Path -LiteralPath $zipPath) {
            Assert-HpmLifecycleChildPath $env:RUNNER_TEMP $zipPath
            Remove-Item -LiteralPath $zipPath -Force
        }
    }
}

Export-ModuleMember -Function Assert-HpmPrivateArtifactInput, Assert-HpmPrivateArtifactMetadata, Copy-HpmBoundedArchiveEntry, Expand-HpmPrivateBaselineArchive, Receive-HpmPrivateBaselineArtifact
