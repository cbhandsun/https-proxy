Set-StrictMode -Version Latest
$boundaryModule = Import-Module (Join-Path $PSScriptRoot 'nsis-runtime-boundary.psm1') -PassThru

function ConvertFrom-HpmSettingsMatrixResult {
    param([string]$Output, [string]$Combination, [string]$ManifestSha256)
    $document = $null
    try {
        if ($Combination -cnotin @('00', '01', '10', '11') -or $ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or [string]::IsNullOrEmpty($Output) -or [Text.UTF8Encoding]::new($false, $true).GetByteCount($Output) -gt 4096) { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse($Output)
        $root = $document.RootElement
        if ($root.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'invalid' }
        $names = @($root.EnumerateObject() | ForEach-Object { $_.Name })
        if ($names.Count -ne 7 -or ($names | Sort-Object) -join ',' -cne 'checks,combination,dependencyIdentity,manifestSha256,restartRetention,schemaVersion,scope') { throw 'invalid' }
        if ($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or $root.GetProperty('combination').GetString() -cne $Combination -or $root.GetProperty('manifestSha256').GetString() -cne $ManifestSha256 -or $root.GetProperty('scope').GetString() -cne 'verified_payload_module_api' -or $root.GetProperty('dependencyIdentity').GetString() -cne 'lock_only' -or $root.GetProperty('restartRetention').GetBoolean()) { throw 'invalid' }
        $expected = @('policy_applied', 'storage_boundary', 'shutdown_acknowledged')
        $checks = $root.GetProperty('checks')
        if ($checks.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $checks.GetArrayLength() -ne $expected.Count) { throw 'invalid' }
        for ($index = 0; $index -lt $expected.Count; $index++) { if ($checks[$index].GetString() -cne $expected[$index]) { throw 'invalid' } }
        return [pscustomobject]@{ schemaVersion = 1; combination = $Combination; manifestSha256 = $ManifestSha256; scope = 'verified_payload_module_api'; dependencyIdentity = 'lock_only'; checks = $expected; restartRetention = $false }
    } catch { throw 'Settings matrix result rejected.' } finally { if ($null -ne $document) { $document.Dispose() } }
}

function Invoke-HpmPayloadSettingsMatrix {
    param([string]$OwnedRoot, [string]$InstallDirectory, [string]$ManifestSha256)
    try {
        $ErrorActionPreference = 'Stop'
        if ($ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or -not [IO.Path]::IsPathFullyQualified($OwnedRoot)) { throw 'invalid' }
        # Invoke reviewed private infrastructure within its module scope. Do not
        # duplicate process/job/gate code or expose a caller-supplied executable.
        $node = & $boundaryModule {
            param($owned, $install, $sha)
            Assert-HpmLifecycleChildPath ([IO.Path]::GetPathRoot($owned)) $owned
            Assert-HpmLifecycleChildPath $owned $install
            if (-not (Test-Path -LiteralPath $owned -PathType Container)) { throw 'invalid' }
            $node = Get-HpmRuntimeBoundaryNode $owned $install $sha
            $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText((Join-Path $install 'release-runtime-manifest.json')))
            try {
                $helper = Join-Path $install 'runtime/native/hpm-context-recovery-key.exe'
                Assert-HpmLifecycleArtifactPath $owned $helper 'Leaf'
                $expected = $document.RootElement.GetProperty('contextRecoveryNativeSha256').GetString()
                if ($expected -cnotmatch '\A[a-f0-9]{64}\z' -or (Get-Item -LiteralPath $helper).Length -gt 16777216 -or (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'invalid' }
            } finally { $document.Dispose() }
            return $node
        } $OwnedRoot $InstallDirectory $ManifestSha256
        $results = @()
        foreach ($combination in @('00', '01', '10', '11')) {
            $caseRoot = Join-Path $OwnedRoot ('settings-' + $combination + '-' + [Guid]::NewGuid().ToString('N'))
            & $boundaryModule { param($owned, $candidate) Assert-HpmLifecycleChildPath $owned $candidate } $OwnedRoot $caseRoot
            New-Item -ItemType Directory -Path $caseRoot -ErrorAction Stop | Out-Null
            foreach ($name in @('config', 'data')) { New-Item -ItemType Directory -Path (Join-Path $caseRoot $name) -ErrorAction Stop | Out-Null }
            $start = [Diagnostics.ProcessStartInfo]::new()
            $start.FileName = $node
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardInput = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
            foreach ($key in @($start.Environment.Keys)) { if ($key -like 'PROXY_*' -or $key -cin @('NODE_OPTIONS', 'NODE_PATH')) { $start.Environment.Remove($key) | Out-Null } }
            $start.Environment['HPM_NSIS_BOUNDARY_OWNED_ROOT'] = $OwnedRoot
            $start.Environment['HPM_NSIS_BOUNDARY_START_GATE'] = '1'
            foreach ($argument in @((Join-Path $PSScriptRoot 'nsis-settings-matrix.cjs'), $combination, $InstallDirectory, $caseRoot, $ManifestSha256)) { $start.ArgumentList.Add($argument) }
            $output = & $boundaryModule { param($startInfo) Invoke-HpmBoundedRuntimeChild $startInfo } $start
            $results += ConvertFrom-HpmSettingsMatrixResult $output $combination $ManifestSha256
        }
        return $results
    } catch { throw 'Payload settings matrix failed.' }
}

Export-ModuleMember -Function ConvertFrom-HpmSettingsMatrixResult, Invoke-HpmPayloadSettingsMatrix
