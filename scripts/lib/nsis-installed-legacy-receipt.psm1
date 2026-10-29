Set-StrictMode -Version Latest
function ConvertFrom-HpmInstalledLegacy582Receipt {
    param([string]$Text, [string]$ManifestSha256)
    $document = $null
    try {
        if ($Text.Length -gt 4096 -or $ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse($Text)
        $literal = @{ schemaVersion = '1'; passed = 'true'; stages = '8'; baselineSourceCount = '582'; modelRequests = '0'; layoutBefore = '1'; layoutAfter = '3'; revisionDelta = '1'; nsisQualified = 'false'; workerQualified = 'true'; retention24hQualified = 'false'; clientQualified = 'false' }
        $strings = @{ scope = 'packaged_runtime_default_worker_legacy_layout_migration'; baselineManifestSha256 = '4eb1ea482224541c14e7ccddabbb94d75dd2cb698a14a78f6745f11eef43b66f'; currentManifestSha256 = $ManifestSha256 }
        $names = @($document.RootElement.EnumerateObject() | ForEach-Object { $_.Name })
        if (($names | Sort-Object) -join ',' -cne ((@($literal.Keys) + @($strings.Keys) | Sort-Object) -join ',')) { throw 'invalid' }
        foreach ($name in $literal.Keys) { if ($document.RootElement.GetProperty($name).GetRawText() -cne $literal[$name]) { throw 'invalid' } }
        foreach ($name in $strings.Keys) { if ($document.RootElement.GetProperty($name).GetString() -cne $strings[$name]) { throw 'invalid' } }
        return $Text | ConvertFrom-Json -ErrorAction Stop
    } catch { throw 'installed_legacy_582_receipt_rejected' }
    finally { if ($null -ne $document) { $document.Dispose() } }
}
Export-ModuleMember -Function ConvertFrom-HpmInstalledLegacy582Receipt
