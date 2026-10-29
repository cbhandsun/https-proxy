param([Parameter(Mandatory)][string]$RepositoryRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    $root = Join-Path ([IO.Path]::GetFullPath($RepositoryRoot)) 'scripts/context-hosted'
    $files = @(Get-ChildItem -LiteralPath $root -File -Recurse | Where-Object { $_.Extension -in @('.ps1', '.psm1') })
    $files += Get-Item -LiteralPath (Join-Path $RepositoryRoot 'scripts/qualify-context-hosted.ps1')
    if ($files.Count -lt 8) { throw 'invalid' }
    foreach ($file in $files) {
        $tokens = $null
        $parseErrors = $null
        $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
        if ($null -ne $parseErrors -and $parseErrors.Count -ne 0) { throw 'invalid' }
    }
    '{"powershellParsed":true}'
} catch { throw 'context_hosted_powershell_parse_failed' }
