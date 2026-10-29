Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function ConvertFrom-HpmCodexStopDiagnosticReceipt {
    param([string]$Text,$Contract)
    $doc=$null
    try {
        if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt 4096) { throw 'invalid' }
        $doc=[Text.Json.JsonDocument]::Parse($Text)
        $remaining=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach($field in $Contract.FIELDS){if(-not $remaining.Add($field)){throw 'invalid'}}
        foreach($property in $doc.RootElement.EnumerateObject()){if(-not $remaining.Remove($property.Name)){throw 'invalid'}}
        if($remaining.Count -ne 0){throw 'invalid'}
        $item=$doc.RootElement
        if($item.GetProperty('schemaVersion').GetInt32() -ne 1 -or $item.GetProperty('scope').GetString() -cne 'staged_codex_enhanced_stop_diagnostic' -or $item.GetProperty('modelRequests').GetInt32() -ne 0){throw 'invalid'}
        foreach($key in @('installedQualified','realProvider','retention24hQualified')){if($item.GetProperty($key).GetBoolean()){throw 'invalid'}}
        foreach($key in @('diagnosticPassed','ownedTreeEmpty','syntheticSocketsClosed','probesPassed','tlsVerified','nonLoopbackBlocked','listenerOwned')){$null=$item.GetProperty($key).GetBoolean()}
        $report=$Text|ConvertFrom-Json
        if(($null -ne $report.failedPhase -and $report.failedPhase -cnotin $Contract.DIAGNOSTIC_PHASES) -or ($null -ne $report.failureCode -and $report.failureCode -cnotin $Contract.OWNED_STOP_CODES)){throw 'invalid'}
        if($report.diagnosticPassed){
            if($null -ne $report.failedPhase -or $null -ne $report.failureCode){throw 'invalid'}
            foreach($key in @('ownedTreeEmpty','syntheticSocketsClosed','probesPassed','tlsVerified','nonLoopbackBlocked','listenerOwned')){if(-not $report.$key){throw 'invalid'}}
        }elseif($null -eq $report.failedPhase){throw 'invalid'}
        return $report
    }catch{throw 'codex_stop_receipt_rejected'}finally{if($null -ne $doc){$doc.Dispose()}}
}
function Invoke-HpmCodexStopDiagnosticOwnedProcess {
    param([Diagnostics.ProcessStartInfo]$Start)
    $module=Import-Module (Join-Path $PSScriptRoot 'nsis-installed-daemon-http.psm1') -Force -PassThru
    return & $module {param($s) Invoke-HpmInstalledHttpDriverProcess $s -RequireNaturalExit} $Start
}
function Invoke-HpmCodexStopDiagnosticDriver {
    param([string]$Root,[string]$Candidate,$Materials,[hashtable]$State,$Contract,[string]$ContractSha256)
    $contractFile=Join-Path $Root 'diagnostic-contract.json'
    if((Get-FileHash -LiteralPath $contractFile).Hash.ToLowerInvariant() -cne $ContractSha256){throw 'codex_stop_contract_identity'}
    $staging=Get-Content -LiteralPath (Join-Path $Root 'staging-identity.json') -Raw|ConvertFrom-Json
    $case=Join-Path $Root 'driver-parent'
    New-Item -ItemType Directory -Path $case|Out-Null
    foreach($dir in @('home','appdata','localappdata','tmp','config','runtime')){New-Item -ItemType Directory -Path (Join-Path $case $dir)|Out-Null}
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=Join-Path $Root 'payload/runtime/node/node.exe'
    $start.WorkingDirectory=Join-Path $Root 'payload'
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $module=Import-Module (Join-Path $PSScriptRoot 'nsis-installed-daemon-http.psm1') -Force -PassThru
    & $module {param($s,$c) Set-HpmInstalledHttpDriverEnvironment $s $c} $start $case
    foreach($key in @('GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','RUNNER_TEMP','GITHUB_WORKSPACE','CI')){$start.Environment[$key]=[Environment]::GetEnvironmentVariable($key)}
    foreach($arg in @((Join-Path $Candidate 'scripts/diagnose-codex-stop.js'),$Root,(Join-Path $Root 'payload'),$staging.manifestSha256,$Materials.networkRoot,$Materials.caSha256,$Materials.leafSha256,$staging.codexSha256,$staging.claudeSha256)){$start.ArgumentList.Add($arg)}
    $State.treeEmpty=$false
    try{$text=Invoke-HpmCodexStopDiagnosticOwnedProcess $start;$State.treeEmpty=$true}
    catch{
        if($_.Exception.Message -cmatch '\Ainstalled_daemon_http_process_failed:cause=(resources_failed|start_failed|job_assign_failed|gate_release_failed|deadline|pipe_failed|output_limit|exit_failed|output_invalid|none);cleanup=confirmed\z'){$State.treeEmpty=$true}
        throw 'codex_stop_owned_driver_failed'
    }
    if((Get-FileHash -LiteralPath $contractFile).Hash.ToLowerInvariant() -cne $ContractSha256){throw 'codex_stop_contract_identity'}
    $report=ConvertFrom-HpmCodexStopDiagnosticReceipt $text $Contract
    $State.report=$report
    Write-Information ('CODEX_STOP_DIAGNOSTIC='+($report|ConvertTo-Json -Compress)) -InformationAction Continue
    return $report
}
function Invoke-HpmCodexStopDiagnostic {
    if(-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:CI -cne 'true'){throw 'codex_stop_environment_refused'}
    $root=Join-Path $env:RUNNER_TEMP 'hpm-installed-clients'
    $candidate=[IO.Path]::GetFullPath((Join-Path $env:GITHUB_WORKSPACE 'current'))
    $nodeCode="const fs=require('node:fs'),path=require('node:path');const root=path.join(process.env.RUNNER_TEMP,'hpm-installed-clients');fs.writeFileSync(path.join(root,'diagnostic-network.ps1'),require('./scripts/lib/codex-stop-diagnostic-network').NETWORK_SCRIPT,{flag:'wx'});fs.writeFileSync(path.join(root,'diagnostic-contract.json'),JSON.stringify(require('./scripts/lib/codex-stop-diagnostic-contract')),{flag:'wx'});"
    & node -e $nodeCode
    if($LASTEXITCODE -ne 0){throw 'codex_stop_composition_failed'}
    . (Join-Path $candidate 'scripts/context-hosted/shared/hosted-materials.ps1')
    Initialize-HpmN08ArtifactLease
    $rootLease=$null;$payloadLease=$null;$contractLease=$null
    try{
        $rootLease=[HpmN08ArtifactLease]::new($root,$true)
        $payloadLease=[HpmN08ArtifactLease]::new((Join-Path $root 'payload'),$true)
        $contractFile=Join-Path $root 'diagnostic-contract.json'
        Assert-HpmN08MaterialPath $contractFile $false
        if((Get-Item -LiteralPath $contractFile).Length -gt 16384){throw 'codex_stop_contract_identity'}
        $contractLease=[HpmN08ArtifactLease]::new($contractFile,$false)
        $contractSha=(Get-FileHash -LiteralPath $contractFile).Hash.ToLowerInvariant()
        $contract=Get-Content -LiteralPath $contractFile -Raw|ConvertFrom-Json
        . (Join-Path $root 'diagnostic-network.ps1')
        $state=@{treeEmpty=$true;report=$null}
        $owner=$ExecutionContext.SessionState.Module
        $run={param($materials) & $owner {param($r,$c,$m,$s,$contract,$sha) Invoke-HpmCodexStopDiagnosticDriver $r $c $m $s $contract $sha} $root $candidate $materials $state $contract $contractSha}.GetNewClosure()
        $stop={return $state.treeEmpty -ceq $true}.GetNewClosure()
        $sha=(Get-FileHash -LiteralPath (Join-Path $root 'staging-identity.json')).Hash.ToLowerInvariant()
        $result=Invoke-HpmCodexStopDiagnosticNetwork -OwnedRoot $root -StagingReceiptSha256 $sha -CandidateRoot $candidate -RunOwnedScenario $run -StopOwnedScenario $stop
        $rootLease.Verify($root);$payloadLease.Verify((Join-Path $root 'payload'));$contractLease.Verify($contractFile)
        if((Get-FileHash -LiteralPath $contractFile).Hash.ToLowerInvariant() -cne $contractSha){throw 'codex_stop_contract_identity'}
        if($result.phase -cne 'codex_stop_diagnostic_network_finished' -or $state.treeEmpty -cne $true -or $state.report.diagnosticPassed -cne $true){throw 'codex_stop_diagnostic_failed'}
    }finally{foreach($lease in @($contractLease,$payloadLease,$rootLease)){if($null -ne $lease){$lease.Dispose()}}}
}
Export-ModuleMember -Function Invoke-HpmCodexStopDiagnostic, ConvertFrom-HpmCodexStopDiagnosticReceipt
