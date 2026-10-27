param([Parameter(Mandatory)][ValidateSet('n08', 'n09', 'n09-sending-ack')][string]$Case)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$qualificationStage = 'environment'
try {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_SHA -cnotmatch '\A[a-f0-9]{40}\z' -or
        [string]::IsNullOrEmpty($env:RUNNER_TEMP)) { throw 'invalid' }
    $qualificationStage = 'source_identity'
    $candidate = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $head = git -C $candidate rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $head -cne $env:GITHUB_SHA) { throw 'invalid' }
    $ownedRoot = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) ('hpm-context-' + $Case)
    $baseCase = if ($Case -ceq 'n09-sending-ack') { 'n09' } else { $Case }
    $publicationGroup = if ($Case -ceq 'n09-sending-ack') { 'sending-ack' } else { 'original' }
    $receiptFile = Join-Path $ownedRoot 'prepared-run.json'
    $reviewFile = Join-Path $ownedRoot ($baseCase + '-hosted-review-plan.json')
    $execution = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('context-hosted/' + $baseCase + '/hosted-execution.ps1')))
    $qualificationStage = 'physical_paths'
    foreach ($file in @($reviewFile, $receiptFile, $execution)) {
        $current = [IO.Path]::GetFullPath($file)
        if ($current.StartsWith('\\')) { throw 'invalid' }
        while ($true) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid' }
            $parent = [IO.Path]::GetDirectoryName($current)
            if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
            $current = $parent
        }
    }
    $qualificationStage = 'prepared_receipt'
    if ((Get-Item -LiteralPath $receiptFile).Length -gt 4096) { throw 'invalid' }
    $receipt = [IO.File]::ReadAllText($receiptFile, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json -AsHashtable
    $expected = @('schemaVersion', 'scenario', 'sourceSha', 'planSha256', 'buildReceiptSha256')
    if ($receipt.Count -ne $expected.Count -or @($expected | Where-Object { -not $receipt.ContainsKey($_) }).Count -ne 0 -or
        $receipt.schemaVersion -ne 1 -or $receipt.scenario -cne $Case -or $receipt.sourceSha -cne $env:GITHUB_SHA -or
        $receipt.planSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $receipt.buildReceiptSha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
    if ((Get-Item -LiteralPath $reviewFile).Length -gt 131072 -or
        (Get-FileHash -LiteralPath $reviewFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.planSha256) { throw 'invalid' }
    $review = [IO.File]::ReadAllText($reviewFile, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json -AsHashtable
    if (-not $review.libraryPins.ContainsKey($execution) -or
        (Get-FileHash -LiteralPath $execution -Algorithm SHA256).Hash.ToLowerInvariant() -cne $review.libraryPins[$execution]) { throw 'invalid' }
    $qualificationStage = 'load_execution'
    . $execution
    $qualificationStage = 'invoke_execution'
    $result = if ($baseCase -ceq 'n08') {
        Invoke-HpmN08HostedExecution -OwnedRoot $ownedRoot -ReviewPlanSha256 $receipt.planSha256 -BuildReceiptSha256 $receipt.buildReceiptSha256
    } else {
        Invoke-HpmN09HostedExecution -OwnedRoot $ownedRoot -ReviewPlanSha256 $receipt.planSha256 -BuildReceiptSha256 $receipt.buildReceiptSha256 -PublicationGroup $publicationGroup
    }
    # Fixed network receipt only. No payload, keys, DBs, native frames or request
    # bodies are written to Actions artifacts or the job summary.
    $result | ConvertTo-Json -Depth 3 -Compress
} catch {
    Write-Information ('hpm_qualification_failed_stage=' + $qualificationStage) -InformationAction Continue
    throw 'context_hosted_qualification_failed'
}
