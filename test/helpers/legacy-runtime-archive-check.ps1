param([string]$ModulePath, [string]$Root)
$ErrorActionPreference = 'Stop'; $WarningPreference = 'SilentlyContinue'
Import-Module $ModulePath -Force
function Hash([byte[]]$Bytes) { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
$normal = [Text.Encoding]::UTF8.GetBytes('x'); $normalHash = Hash $normal
$count = 0
foreach ($mode in @('valid','archive-digest','manifest-digest','missing','duplicate','traversal','unknown','symlink-entry','oversized-entry','expanded-limit','bad-content','bad-json','manifest-limit','existing','linked-parent','relative')) {
    $directory = Join-Path $Root $mode; New-Item -ItemType Directory -Path $directory | Out-Null
    $sources = [ordered]@{}; foreach ($name in @('openai-proxy.js','proxy.bat','proxy.ps1','proxy.config.example.json')) { $sources[$name] = $normalHash }
    for ($i = 0; $i -lt 578; $i++) { $sources['lib/proxy/fixture-' + $i + '.js'] = $normalHash }
    if ($mode -ceq 'traversal') { $sources.Remove('lib/proxy/fixture-0.js'); $sources['lib/proxy/../../escape.js'] = $normalHash }
    $manifest = @{ schemaVersion = 2; sourceSha256 = $sources; contextRecoveryNativeSha256 = $normalHash; packageLockSha256 = $normalHash }
    $manifestBytes = [Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 8 -Compress))
    if ($mode -ceq 'bad-json') { $manifestBytes = [Text.Encoding]::UTF8.GetBytes('{') }
    if ($mode -ceq 'manifest-limit') { $manifestBytes = [byte[]]::new(131073) }
    $archive = Join-Path $directory 'fixture.zip'; $destination = Join-Path $directory 'output'
    $stream = [IO.File]::Open($archive, [IO.FileMode]::CreateNew); $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entries = [Collections.Generic.List[string]]::new(); foreach ($name in $sources.Keys) { $entries.Add($name) }
        $entries.Add('runtime/native/hpm-context-recovery-key.exe'); $entries.Add('package-lock.json'); $entries.Add('release-runtime-manifest.json')
        if ($mode -ceq 'missing') { $entries.RemoveAt(0) }
        if ($mode -ceq 'duplicate') { $entries[0] = $entries[1] }
        if ($mode -ceq 'unknown') { $entries[0] = 'credentials.json' }
        $index = 0
        foreach ($name in $entries) {
            $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
            if ($mode -ceq 'symlink-entry' -and $index -eq 0) { $entry.ExternalAttributes = -1610612736 }
            $bytes = if ($name -ceq 'release-runtime-manifest.json') { $manifestBytes } else { $normal }
            if ($index -eq 0 -and $mode -ceq 'bad-content') { $bytes = [Text.Encoding]::UTF8.GetBytes('bad') }
            if ($index -eq 0 -and $mode -ceq 'oversized-entry') { $bytes = [byte[]]::new(4194305) }
            if ($index -lt 5 -and $mode -ceq 'expanded-limit') { $bytes = [byte[]]::new(4194304) }
            $output = $entry.Open(); try { $output.Write($bytes,0,$bytes.Length) } finally { $output.Dispose() }; $index++
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant(); $manifestHash = Hash $manifestBytes
    if ($mode -ceq 'archive-digest') { $archiveHash = '0' * 64 }
    if ($mode -ceq 'manifest-digest') { $manifestHash = '0' * 64 }
    if ($mode -ceq 'existing') { New-Item -ItemType Directory -Path $destination | Out-Null }
    if ($mode -ceq 'linked-parent') {
        $target = Join-Path $directory 'real-parent'; New-Item -ItemType Directory -Path $target | Out-Null
        $link = Join-Path $directory 'linked'; $kind = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }
        New-Item -ItemType $kind -Path $link -Target $target | Out-Null; $destination = Join-Path $link 'output'
    }
    if ($mode -ceq 'relative') { $destination = 'relative-output-refused' }
    $failed = $false
    try { Expand-HpmDeclaredLegacyRuntime -Archive $archive -Destination $destination -ArchiveSha256 $archiveHash -ManifestSha256 $manifestHash }
    catch { if ($_.Exception.Message -cne 'legacy_runtime_archive_refused') { throw 'unexpected_archive_diagnostic' }; $failed = $true }
    if (($mode -ceq 'valid') -eq $failed) { throw 'archive_case_failed' }
    if ($mode -ceq 'valid' -and @(Get-ChildItem -LiteralPath $destination -File -Recurse).Count -ne 585) { throw 'archive_file_count_failed' }
    if (Test-Path -LiteralPath (Join-Path $directory 'escape.js')) { throw 'archive_escape_failed' }
    $count++
}
@{ passedCases = $count } | ConvertTo-Json -Compress
