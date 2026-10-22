Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Function-only composition. Uses the ORIGINAL bounded runtime Job helper,
# including its stdin grant, bounded pipes, StopAndWait and kill-on-close.
function Invoke-HpmN08OwnedScenario {
    param(
        [Parameter(Mandatory)][string]$OwnedRoot,
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$PlanSha256,
        [Parameter(Mandatory)][hashtable]$SourcePins
    )
    try {
        if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
            $env:RUNNER_OS -cne 'Windows' -or [string]::IsNullOrEmpty($env:RUNNER_TEMP)) { throw 'invalid' }
        $OwnedRoot = [IO.Path]::GetFullPath($OwnedRoot)
        $tempPrefix = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
        if (-not $OwnedRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'invalid' }
        $Candidate = [IO.Path]::GetFullPath($Candidate)
        $fixed = @(
            (Join-Path $Candidate 'scripts/lib/nsis-runtime-boundary.psm1'),
            (Join-Path $Candidate 'scripts/lib/nsis-runtime-boundary-job.cs'),
            (Join-Path $Candidate 'scripts/lib/nsis-lifecycle.psm1'),
            (Join-Path $PSScriptRoot 'owned-entry.js'),
            (Join-Path $OwnedRoot 'payload/runtime/node/node.exe')
        )
        if ($SourcePins.Count -ne $fixed.Count) { throw 'invalid' }
        foreach ($file in $fixed) {
            # No symlink/junction ancestors and no caller-selected executable.
            $current = [IO.Path]::GetFullPath($file)
            if ($current.StartsWith('\\')) { throw 'invalid' }
            while ($true) {
                $item = Get-Item -LiteralPath $current -Force
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid' }
                $parent = [IO.Path]::GetDirectoryName($current)
                if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
                $current = $parent
            }
            if (-not $SourcePins.ContainsKey($file) -or $SourcePins[$file] -cnotmatch '\A[a-f0-9]{64}\z' -or
                (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $SourcePins[$file]) { throw 'invalid' }
        }
        Import-Module $fixed[0] -Force
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $fixed[4]
        $start.WorkingDirectory = $OwnedRoot
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.Environment.Clear()
        foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP')) {
            $value = [Environment]::GetEnvironmentVariable($name)
            if (-not [string]::IsNullOrEmpty($value)) { $start.Environment[$name] = $value }
        }
        $start.Environment['GITHUB_ACTIONS'] = 'true'
        $start.Environment['RUNNER_ENVIRONMENT'] = 'github-hosted'
        $start.Environment['RUNNER_OS'] = 'Windows'
        $start.ArgumentList.Add($fixed[3])
        $start.ArgumentList.Add($OwnedRoot)
        $start.ArgumentList.Add($PlanSha256)
        # Existing 120s outer bound, never extended/reset. Each nested original
        # daemon controller retains its existing case/session deadlines.
        $output = Invoke-HpmBoundedRuntimeChild $start 120000
        # This line is reached only AFTER the original helper's finally has
        # StopAndWait(5000)-verified its entire owned tree and drained pipes.
        $treeEmpty = $true
        if ([string]::IsNullOrEmpty($output) -or [Text.Encoding]::UTF8.GetByteCount($output) -gt 4096) { throw 'invalid' }
        $document = [Text.Json.JsonDocument]::Parse($output)
        try {
            $root = $document.RootElement
            $names = @($root.EnumerateObject() | ForEach-Object { $_.Name })
            if ($names.Count -ne 9 -or ($names | Sort-Object) -join ',' -cne 'cases,listenerOwned,n08Qualified,nonLoopbackBlocked,phase,probesPassed,schemaVersion,syntheticSocketsClosed,tlsVerified') { throw 'invalid' }
            if ($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or $root.GetProperty('phase').GetString() -cne 'n08_owned_scenario_closed' -or
                $root.GetProperty('cases').GetInt32() -ne 6 -or $root.GetProperty('n08Qualified').GetBoolean() -ne $false) { throw 'invalid' }
            foreach ($name in @('probesPassed', 'tlsVerified', 'nonLoopbackBlocked', 'listenerOwned', 'syntheticSocketsClosed')) {
                if ($root.GetProperty($name).GetBoolean() -ne $true) { throw 'invalid' }
            }
            # Explicit flat PS receipt conversion, from the pinned fixed child
            # protocol only after authoritative outer Job cleanup, not callback
            # booleans or a deserialized replacement for its WeakSet capability.
            return [pscustomobject]@{ probesPassed = $true; tlsVerified = $true; nonLoopbackBlocked = $true;
                listenerOwned = $true; ownedTreeEmpty = $treeEmpty; syntheticSocketsClosed = $true; n08Qualified = $false }
        } finally { $document.Dispose() }
    } catch { throw 'n08_owned_job_rejected' }
}
