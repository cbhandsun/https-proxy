# Loaded only as pinned source appended to the disposable N09 controller copy.
function Initialize-HpmN09AckBootstrap {
    param([string]$OwnedRoot, [string]$CaseRoot, [int]$ProcessId, [string]$Token, [string]$ManifestSha256)
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:RUNNER_OS -cne 'Windows' -or $ProcessId -le 0 -or
        $Token -cnotmatch '\A[a-zA-Z0-9_-]{32,256}\z' -or
        $ManifestSha256 -cne '__N09_MANIFEST_SHA256__') { throw 'n09_bootstrap_rejected' }
    Assert-HpmLifecycleArtifactPath $OwnedRoot $CaseRoot 'Container'
    $candidate = '__N09_CANDIDATE__'
    $pins = ConvertFrom-Json -InputObject '__N09_SOURCE_PINS__' -AsHashtable
    foreach ($name in $pins.Keys) {
        $file = Join-Path $candidate $name
        Assert-HpmLifecycleArtifactPath $candidate $file 'Leaf'
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pins[$name]) { throw 'n09_bootstrap_rejected' }
    }
    $directory = Join-Path $CaseRoot 'n09-ack'
    Assert-HpmLifecycleChildPath $CaseRoot $directory
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null }
    Assert-HpmLifecycleArtifactPath $CaseRoot $directory 'Container'
    $payload = [ordered]@{
        version = 1; pid = $ProcessId; epoch = [Guid]::NewGuid().ToString('N')
        manifestSha256 = $ManifestSha256; sourcePins = $pins
    }
    $json = ConvertTo-Json -InputObject $payload -Depth 8 -Compress
    $key = [Text.Encoding]::UTF8.GetBytes($Token)
    $hmac = [Security.Cryptography.HMACSHA256]::new($key)
    try { $signature = [Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("hpm.n09.bootstrap.v1`0" + $json))).ToLowerInvariant() }
    finally { $hmac.Dispose(); [Array]::Clear($key, 0, $key.Length) }
    $envelope = ConvertTo-Json -InputObject ([ordered]@{ payload = $payload; signature = $signature }) -Depth 8 -Compress
    $file = Join-Path $directory ('bootstrap-' + $ProcessId + '.json')
    Assert-HpmLifecycleChildPath $directory $file
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($envelope)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    Assert-HpmLifecycleArtifactPath $directory $file 'Leaf'
}
