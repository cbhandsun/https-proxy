Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-private-artifact.psm1')
function Assert-HpmLegacyPhysicalPath {
    param([string]$Path)
    $part = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    while ($null -ne $part) {
        if ($part.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'legacy_runtime_archive_refused' }
        $part = if ($part -is [IO.FileInfo]) { $part.Directory } else { $part.Parent }
    }
}
function Expand-HpmDeclaredLegacyRuntime {
    param([string]$Archive, [string]$Destination, [string]$ArchiveSha256, [string]$ManifestSha256)
    $zip = $null; $document = $null
    try {
        if ($ArchiveSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or
            -not [IO.Path]::IsPathFullyQualified($Archive) -or -not [IO.Path]::IsPathFullyQualified($Destination) -or
            $Archive -match '^[\\/]{2}' -or $Destination -match '^[\\/]{2}' -or
            [IO.Path]::GetFullPath($Archive) -cne $Archive -or [IO.Path]::GetFullPath($Destination) -cne $Destination -or
            (Test-Path -LiteralPath $Destination)) { throw 'invalid' }
        Assert-HpmLegacyPhysicalPath $Archive
        Assert-HpmLegacyPhysicalPath ([IO.Path]::GetDirectoryName($Destination))
        if ((Get-Item -LiteralPath $Archive).Length -gt 2097152 -or (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ArchiveSha256) { throw 'invalid' }
        $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
        if ($zip.Entries.Count -ne 585) { throw 'invalid' }
        $manifests = @($zip.Entries | Where-Object { $_.FullName -ceq 'release-runtime-manifest.json' })
        if ($manifests.Count -ne 1 -or $manifests[0].Length -le 0 -or $manifests[0].Length -gt 131072) { throw 'invalid' }
        $stream = $manifests[0].Open(); $memory = [IO.MemoryStream]::new()
        try { Copy-HpmBoundedArchiveEntry $stream $memory $manifests[0].Length 131072; $bytes = $memory.ToArray() } finally { $stream.Dispose(); $memory.Dispose() }
        if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $ManifestSha256) { throw 'invalid' }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $document = [Text.Json.JsonDocument]::Parse($text)
        if ($document.RootElement.GetProperty('schemaVersion').GetInt32() -ne 2) { throw 'invalid' }
        $expected = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $sources = @($document.RootElement.GetProperty('sourceSha256').EnumerateObject())
        if ($sources.Count -ne 582) { throw 'invalid' }
        foreach ($item in $sources) {
            if ($item.Name -cnotmatch '\A(?:openai-proxy\.js|proxy\.bat|proxy\.ps1|proxy\.config\.example\.json|lib/proxy/[A-Za-z0-9_./-]+\.js)\z' -or
                @($item.Name.Split('/') | Where-Object { $_ -cin @('','.','..') }).Count -ne 0 -or -not $names.Add($item.Name) -or
                $item.Value.GetString() -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
            $expected.Add($item.Name, $item.Value.GetString())
        }
        foreach ($pair in @(@('runtime/native/hpm-context-recovery-key.exe','contextRecoveryNativeSha256'), @('package-lock.json','packageLockSha256'))) {
            $hash = $document.RootElement.GetProperty($pair[1]).GetString()
            if ($hash -cnotmatch '\A[a-f0-9]{64}\z' -or -not $names.Add($pair[0])) { throw 'invalid' }
            $expected.Add($pair[0], $hash)
        }
        $expected.Add('release-runtime-manifest.json', $ManifestSha256)
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        [long]$total = 0
        foreach ($entry in $zip.Entries) {
            $kind = ($entry.ExternalAttributes -shr 16) -band 61440
            $total += $entry.Length
            if (-not $expected.ContainsKey($entry.FullName) -or -not $seen.Add($entry.FullName) -or
                $entry.Length -lt 0 -or $entry.Length -gt 4194304 -or $total -gt 16777216 -or ($kind -ne 0 -and $kind -ne 32768)) { throw 'invalid' }
        }
        New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
        foreach ($entry in $zip.Entries) {
            $target = Join-Path $Destination $entry.FullName
            $parent = [IO.Path]::GetDirectoryName($target)
            [IO.Directory]::CreateDirectory($parent) | Out-Null
            Assert-HpmLegacyPhysicalPath $parent
            $inputStream = $entry.Open(); $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
            try { Copy-HpmBoundedArchiveEntry $inputStream $output $entry.Length 4194304 } finally { $output.Dispose(); $inputStream.Dispose() }
            Assert-HpmLegacyPhysicalPath $target
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected[$entry.FullName]) { throw 'invalid' }
        }
        Assert-HpmLegacyPhysicalPath $Archive
        if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ArchiveSha256) { throw 'invalid' }
    } catch { throw 'legacy_runtime_archive_refused' }
    finally { if ($null -ne $zip) { $zip.Dispose() }; if ($null -ne $document) { $document.Dispose() } }
}
Export-ModuleMember -Function Expand-HpmDeclaredLegacyRuntime, Assert-HpmLegacyPhysicalPath
