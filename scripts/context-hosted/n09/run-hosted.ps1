param(
    [Parameter(Mandatory)][string]$OwnedRoot,
    [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$ReviewPlanSha256,
    [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$BuildReceiptSha256,
    [ValidateSet('original', 'sending-ack', 'finished-ack', 'withdrawn-ack', 'uncertain-ack')][string]$PublicationGroup = 'original'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    $OwnedRoot = [IO.Path]::GetFullPath($OwnedRoot)
    $reviewFile = Join-Path $OwnedRoot 'n09-hosted-review-plan.json'
    $executionFile = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'hosted-execution.ps1'))
    foreach ($file in @($reviewFile, $executionFile, $PSCommandPath)) {
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
    if ((Get-Item -LiteralPath $reviewFile).Length -gt 131072 -or
        (Get-FileHash -LiteralPath $reviewFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ReviewPlanSha256) { throw 'invalid' }
    $review = [IO.File]::ReadAllText($reviewFile, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json -AsHashtable
    foreach ($file in @($executionFile, $PSCommandPath)) {
        if (-not $review.libraryPins.ContainsKey($file) -or $review.libraryPins[$file] -cnotmatch '\A[a-f0-9]{64}\z' -or
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $review.libraryPins[$file]) { throw 'invalid' }
    }
    . $executionFile
    Invoke-HpmN09HostedExecution -OwnedRoot $OwnedRoot -ReviewPlanSha256 $ReviewPlanSha256 -BuildReceiptSha256 $BuildReceiptSha256 -PublicationGroup $PublicationGroup
} catch { throw 'n09_hosted_entry_rejected' }
