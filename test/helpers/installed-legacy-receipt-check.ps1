param([string]$ModulePath)
$ErrorActionPreference = 'Stop'; $WarningPreference = 'SilentlyContinue'
Import-Module $ModulePath -Force
$hash = 'a' * 64
$fixture = @{ schemaVersion = 1; scope = 'packaged_runtime_default_worker_legacy_layout_migration'; passed = $true; stages = 8; baselineSourceCount = 582; baselineManifestSha256 = '4eb1ea482224541c14e7ccddabbb94d75dd2cb698a14a78f6745f11eef43b66f'; currentManifestSha256 = $hash; modelRequests = 0; layoutBefore = 1; layoutAfter = 3; revisionDelta = 1; nsisQualified = $false; workerQualified = $true; retention24hQualified = $false; clientQualified = $false }
$text = $fixture | ConvertTo-Json -Compress
$parsed = ConvertFrom-HpmInstalledLegacy582Receipt $text $hash
if ($parsed.passed -isnot [bool] -or $parsed.passed -cne $true) { throw 'receipt_valid_failed' }
$count = 1
foreach ($name in $fixture.Keys) {
    foreach ($value in @($null, '', 'true', '1', [long]::MaxValue)) {
        $changed = $fixture.Clone(); $changed[$name] = $value; $bad = $changed | ConvertTo-Json -Compress
        $rejected = $false
        try { $null = ConvertFrom-HpmInstalledLegacy582Receipt $bad $hash } catch { if ($_.Exception.Message -cne 'installed_legacy_582_receipt_rejected') { throw 'receipt_diagnostic_failed' }; $rejected = $true }
        if (-not $rejected) { throw 'receipt_invalid_accepted' }; $count++
    }
}
foreach ($bad in @('', '{}', 'null', '[]', ($text.Substring(0,$text.Length-1) + ',"extra":1}'), ($text.Substring(0,$text.Length-1) + ',"passed":true}'), ('x' * 4097))) {
    $rejected = $false
    try { $null = ConvertFrom-HpmInstalledLegacy582Receipt $bad $hash } catch { if ($_.Exception.Message -cne 'installed_legacy_582_receipt_rejected') { throw 'receipt_diagnostic_failed' }; $rejected = $true }
    if (-not $rejected) { throw 'receipt_shape_accepted' }; $count++
}
@{ passedCases = $count } | ConvertTo-Json -Compress
