Set-StrictMode -Version Latest
function ConvertFrom-HpmLegacyRuntimeLock {
    param([string]$Text)
    try {
        if ([string]::IsNullOrEmpty($Text) -or [Text.Encoding]::UTF8.GetByteCount($Text) -gt 4194304) { throw 'invalid' }
        $value = ConvertFrom-Json -InputObject $Text -AsHashtable -ErrorAction Stop
        if ($value -isnot [Collections.IDictionary] -or
            ($value['lockfileVersion'] -isnot [int] -and $value['lockfileVersion'] -isnot [long]) -or
            $value['lockfileVersion'] -ne 3 -or $value['name'] -cne 'https-proxy-manager' -or $value['version'] -cne '0.1.0' -or
            $value['packages'] -isnot [Collections.IDictionary] -or -not $value['packages'].Contains('')) { throw 'invalid' }
        $root = $value['packages']['']
        if ($root -isnot [Collections.IDictionary] -or $root['name'] -cne $value['name'] -or $root['version'] -cne $value['version'] -or $root['dependencies'] -isnot [Collections.IDictionary]) { throw 'invalid' }
        return $value
    } catch { throw 'legacy_runtime_lock_refused' }
}
function Restore-HpmLegacyRuntime {
    $ErrorActionPreference = 'Stop'
    $phase = 'host'
    try {
        if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'cbhandsun/https-proxy') { throw 'invalid' }
        $phase = 'module-imports'
        Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -Force
        Import-Module (Join-Path $PSScriptRoot 'legacy-runtime-archive.psm1') -Force
        $transfer = Join-Path $env:GITHUB_WORKSPACE 'legacy-582-transfer'
        $destination = Join-Path $env:GITHUB_WORKSPACE 'legacy-582'
        $phase = 'transfer-path'
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $transfer 'Container'
        $node = Join-Path $transfer 'node.exe'
        Assert-HpmLifecycleArtifactPath $transfer $node 'Leaf'
        $phase = 'node-identity'
        if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b') { throw 'invalid' }
        $phase = 'archive'
        Expand-HpmDeclaredLegacyRuntime -Archive (Join-Path $transfer 'hpm-582-public-runtime-without-node.zip') -Destination $destination -ArchiveSha256 'ced2c62a472107876b75dad73bd3161954988fa341f526d918f85b7be6812abb' -ManifestSha256 '4eb1ea482224541c14e7ccddabbb94d75dd2cb698a14a78f6745f11eef43b66f'
        $phase = 'node-copy'
        [IO.Directory]::CreateDirectory((Join-Path $destination 'runtime/node')) | Out-Null
        [IO.File]::Copy($node, (Join-Path $destination 'runtime/node/node.exe'), $false)
        $phase = 'metadata'
        $manifest = Get-Content -LiteralPath (Join-Path $destination 'release-runtime-manifest.json') -Raw | ConvertFrom-Json
        $lock = ConvertFrom-HpmLegacyRuntimeLock (Get-Content -LiteralPath (Join-Path $destination 'package-lock.json') -Raw)
        if ($manifest.nodeVersion -cne 'v22.22.3' -or $manifest.nodeSha256 -cne '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b') { throw 'invalid' }
        $phase = 'package-metadata'
        # No old package script is executed. npm ci consumes the immutable old lock.
        @{ name = $lock.name; version = $lock.version; private = $true; dependencies = $manifest.dependencies } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $destination 'package.json') -Encoding utf8
        $phase = 'dependencies'
        & npm ci --prefix $destination --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'invalid' }
        $phase = 'complete-identity'
        & node (Join-Path $PSScriptRoot '../verify-legacy-runtime.cjs') $destination
        if ($LASTEXITCODE -ne 0) { throw 'invalid' }
        Write-Output 'legacy_582_runtime_restored'
    } catch { throw ('legacy_runtime_restore_refused:phase=' + $phase) }
}
Export-ModuleMember -Function Restore-HpmLegacyRuntime, ConvertFrom-HpmLegacyRuntimeLock
