Set-StrictMode -Version Latest
function ConvertFrom-HpmInstalledClientMatrixReceipt {
    param([string]$Output)
    $doc = $null
    try {
        if ([string]::IsNullOrEmpty($Output) -or [Text.Encoding]::UTF8.GetByteCount($Output) -gt 4096) { throw 'invalid' }
        $doc = [Text.Json.JsonDocument]::Parse($Output)
        $root = $doc.RootElement
        $keys = @($root.EnumerateObject() | ForEach-Object { $_.Name })
        $expected = @('cases','listenerOwned','nonLoopbackBlocked','ownedTreeEmpty','passed','probesPassed','realModelRequests','realProviderQualified','retention24hQualified','schemaVersion','scope','syntheticClientQualified','syntheticSocketsClosed','tlsVerified')
        if ($keys.Count -ne $expected.Count -or ($keys | Sort-Object) -join ',' -cne ($expected -join ',') -or
            $root.GetProperty('schemaVersion').GetInt32() -ne 3 -or $root.GetProperty('scope').GetString() -cne 'installed_native_cli_four_cases' -or $root.GetProperty('realModelRequests').GetInt32() -ne 0) { throw 'invalid' }
        foreach ($key in @('listenerOwned','nonLoopbackBlocked','ownedTreeEmpty','passed','probesPassed','syntheticClientQualified','syntheticSocketsClosed','tlsVerified')) { if (-not $root.GetProperty($key).GetBoolean()) { throw 'invalid' } }
        foreach ($key in @('realProviderQualified','retention24hQualified')) { if ($root.GetProperty($key).GetBoolean()) { throw 'invalid' } }
        $cases = $root.GetProperty('cases')
        if ($cases.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $cases.GetArrayLength() -ne 4) { throw 'invalid' }
        $index = 0
        foreach ($client in @('codex','claude')) {
            foreach ($mode in @('default','enhanced')) {
                $item = $cases[$index++]
                $fields = @($item.EnumerateObject() | ForEach-Object { $_.Name })
                if ($fields.Count -ne 8 -or ($fields | Sort-Object) -join ',' -cne 'client,compactions,defaultZeroRecovery,exactFinalAnswer,mode,privateRead,publicGeneration,restartRetention' -or
                    $item.GetProperty('client').GetString() -cne $client -or $item.GetProperty('mode').GetString() -cne $mode -or
                    $item.GetProperty('compactions').GetInt32() -ne 3 -or -not $item.GetProperty('exactFinalAnswer').GetBoolean() -or
                    $item.GetProperty('defaultZeroRecovery').GetBoolean() -ne ($mode -ceq 'default') -or
                    $item.GetProperty('privateRead').GetBoolean() -ne ($mode -ceq 'enhanced') -or
                    $item.GetProperty('publicGeneration').GetBoolean() -ne ($mode -ceq 'enhanced') -or
                    -not $item.GetProperty('restartRetention').GetBoolean()) { throw 'invalid' }
            }
        }
        return $Output | ConvertFrom-Json -AsHashtable
    } catch { throw 'installed_client_matrix_receipt_rejected' } finally { if ($null -ne $doc) { $doc.Dispose() } }
}

function Write-HpmInstalledClientPhase {
    param([string]$OwnedRoot)
    $phase = 'unobserved'
    $doc = $null
    $stream = $null
    try {
        Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
        $file = Join-Path $OwnedRoot 'matrix-phase.json'
        Assert-HpmLifecycleArtifactPath $OwnedRoot $file 'Leaf'
        $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -gt 512) { throw 'invalid' }
        $bytes = [byte[]]::new($stream.Length)
        $stream.ReadExactly($bytes)
        $doc = [Text.Json.JsonDocument]::Parse([Text.UTF8Encoding]::new($false,$true).GetString($bytes))
        $item = $doc.RootElement
        $keys = @($item.EnumerateObject() | ForEach-Object { $_.Name })
        if ($keys.Count -ne 3 -or ($keys | Sort-Object) -join ',' -cne 'failed,phase,schemaVersion' -or $item.GetProperty('schemaVersion').GetInt32() -ne 1) { throw 'invalid' }
        $null = $item.GetProperty('failed').GetBoolean()
        $allowed = @('identity','listener','probes','controller','cleanup','complete')
        $suffixes = @('configure','auth','cli','observe','stop','cli-seed','cli-compact-1','cli-compact-2','cli-compact-3','cli-between-1','cli-between-2','cli-final')
        foreach ($client in @('codex','claude')) { foreach ($mode in @('default','enhanced')) { foreach ($suffix in $suffixes) { $allowed += $client + '-' + $mode + '-' + $suffix } } }
        $candidate = $item.GetProperty('phase').GetString()
        if ($candidate -cnotin $allowed) { throw 'invalid' }
        $phase = $candidate
    } catch { $phase = 'unobserved' }
    finally {
        if ($null -ne $doc) { try { $doc.Dispose() } catch {} }
        if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
    }
    # Diagnostic failure must not replace or downgrade the authoritative Job,
    # parser, network or installer result; disclose only this finite enum.
    try { Write-Information ('hpm_installed_client_phase=' + $phase) -InformationAction Continue } catch {}
}
Export-ModuleMember -Function ConvertFrom-HpmInstalledClientMatrixReceipt, Write-HpmInstalledClientPhase
