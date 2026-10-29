Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-installed-client-payload.psm1')
$script:publicationReceiptModule = Import-Module (Join-Path $PSScriptRoot 'nsis-client-matrix-receipt.psm1') -PassThru
$script:publicationProcessModule = Import-Module (Join-Path $PSScriptRoot 'nsis-installed-daemon-http.psm1') -PassThru

function ConvertFrom-HpmInstalledPublicationReceipt {
    param([string]$Output, [string]$ManifestSha256)
    $doc = $null
    try {
        if ($Output.Length -gt 4096 -or $ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'invalid' }
        $doc = [Text.Json.JsonDocument]::Parse($Output)
        $root = $doc.RootElement
        & $script:publicationReceiptModule {param($r,$fields) Assert-HpmInstalledClientJsonFields $r $fields} $root @('schemaVersion','scope','passed','manifestSha256','tests','passedTests','failedTests','skippedTests','defaultWorkerQualified','daemonQualified','retention24hQualified','realModelRequests')
        if ($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or $root.GetProperty('scope').GetString() -cne 'installed_payload_publication_interior' -or $root.GetProperty('manifestSha256').GetString() -cne $ManifestSha256) { throw 'invalid' }
        foreach ($name in @('passed','defaultWorkerQualified')) { if (-not $root.GetProperty($name).GetBoolean()) { throw 'invalid' } }
        foreach ($name in @('daemonQualified','retention24hQualified')) { if ($root.GetProperty($name).GetBoolean()) { throw 'invalid' } }
        foreach ($name in @('tests','passedTests')) { if ($root.GetProperty($name).GetInt32() -ne 30) { throw 'invalid' } }
        foreach ($name in @('failedTests','skippedTests','realModelRequests')) { if ($root.GetProperty($name).GetInt32() -ne 0) { throw 'invalid' } }
        return [pscustomobject]@{ schemaVersion=1;scope='installed_payload_publication_interior';passed=$true;manifestSha256=$ManifestSha256;tests=30;passedTests=30;failedTests=0;skippedTests=0;defaultWorkerQualified=$true;daemonQualified=$false;retention24hQualified=$false;realModelRequests=0 }
    } catch { throw 'installed_publication_receipt_rejected' } finally { if ($null -ne $doc) { $doc.Dispose() } }
}

function Invoke-HpmInstalledPublicationScenario {
    param($Material, [hashtable]$State)
    $driver = Join-Path $PSScriptRoot 'nsis-installed-publication.cjs'
    Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $driver 'Leaf'
    $executor = Join-Path $Material.ownedRoot 'publication-driver'
    if (Test-Path -LiteralPath $executor) { throw 'installed_publication_rejected' }
    New-Item -ItemType Directory -Path $executor | Out-Null
    foreach ($name in @('home','appdata','localappdata','tmp','config','runtime')) { New-Item -ItemType Directory -Path (Join-Path $executor $name) | Out-Null }
    $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName=$Material.node; $start.WorkingDirectory=$Material.payload
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $start.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
    & $script:publicationProcessModule { param($s,$r) Set-HpmInstalledHttpDriverEnvironment $s $r } $start $executor
    foreach ($name in @('RUNNER_TEMP','CI','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS')) { $start.Environment[$name]=[Environment]::GetEnvironmentVariable($name) }
    $start.Environment['HPM_INSTALLED_PUBLICATION_RUNTIME']=$Material.payload
    $start.Environment['HPM_INSTALLED_PUBLICATION_MANIFEST']=$Material.manifestSha256
    $start.ArgumentList.Add($driver)
    $State.treeEmpty=$false
    try {
        $output=& $script:publicationProcessModule { param($s) Invoke-HpmInstalledHttpDriverProcess $s -RequireNaturalExit } $start
        $State.treeEmpty=$true
        $State.receipt=ConvertFrom-HpmInstalledPublicationReceipt $output $Material.manifestSha256
        return @{passed=$true}
    } catch {
        if ($_.Exception.Message -cmatch '\Ainstalled_daemon_http_process_failed:cause=(resources_failed|start_failed|job_assign_failed|gate_release_failed|deadline|pipe_failed|output_limit|exit_failed|output_invalid|none);cleanup=confirmed\z') { $State.treeEmpty=$true }
        throw 'installed_publication_rejected'
    }
}

function Invoke-HpmInstalledPublication {
    param([string]$CurrentDirectory, [string]$CurrentRuntimeManifest, [string]$CurrentSha)
    $state=@{treeEmpty=$true;receipt=$null};$owner=$ExecutionContext.SessionState.Module
    $run={param($material) & $owner {param($m,$s) Invoke-HpmInstalledPublicationScenario $m $s} $material $state}.GetNewClosure()
    $stop={return @{treeEmpty=$state.treeEmpty -ceq $true}}.GetNewClosure()
    $result=Invoke-HpmInstalledClientPayload -CurrentDirectory $CurrentDirectory -CurrentRuntimeManifest $CurrentRuntimeManifest -CurrentSha $CurrentSha -RunOwnedScenario $run -StopOwnedScenario $stop
    if ($result.phase -cne 'installed_payload_finished' -or $result.ownedTreeEmpty -cne $true -or $result.uninstalled -cne $true) { throw 'installed_publication_rejected' }
    return @{phase='installed_publication_finished';sourceSha=$CurrentSha;probe=$state.receipt;naturalTreeEmpty=$true;uninstalled=$true;realModelRequests=0}
}
Export-ModuleMember -Function Invoke-HpmInstalledPublication, ConvertFrom-HpmInstalledPublicationReceipt
