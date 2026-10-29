param([string]$Repository,[string]$FixtureRoot,[string]$ContractFile,[string]$CasesFile,[ValidateSet('codex','claude')][string]$Client='codex')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $Repository 'scripts/lib/codex-stop-diagnostic-run.psm1') -Force -PassThru
$global:diagnosticClient=$Client
$contract=Get-Content -LiteralPath $ContractFile -Raw|ConvertFrom-Json
$cases=Get-Content -LiteralPath $CasesFile -Raw|ConvertFrom-Json
$parsed=@()
foreach($row in $cases){
    $rejected=$false
    try{$null=ConvertFrom-HpmCodexStopDiagnosticReceipt $row.text $contract}catch{if($_.Exception.Message -cne 'codex_stop_receipt_rejected'){throw 'fixture_invalid'};$rejected=$true}
    $parsed+=@{name=$row.name;rejected=$rejected}
}
& $module {
    function script:Invoke-HpmCodexStopDiagnosticOwnedProcess {
        param($Start)
        if(-not $Start.ArgumentList[0].EndsWith($(if($global:diagnosticClient -ceq 'codex'){'diagnose-codex-stop.js'}else{'diagnose-claude-context.js'}))){throw 'fixture_invalid'}
        if($Start.ArgumentList.Count -ne 9 -or -not $Start.RedirectStandardInput -or -not $Start.RedirectStandardOutput -or -not $Start.RedirectStandardError -or $Start.Environment.ContainsKey('NODE_OPTIONS')){throw 'fixture_invalid'}
        if($global:mode -eq 'confirmed'){throw 'installed_daemon_http_process_failed:cause=exit_failed;cleanup=confirmed'}
        if($global:mode -eq 'unconfirmed'){throw 'installed_daemon_http_process_failed:cause=exit_failed;cleanup=failed'}
        if($global:mode -eq 'contract-changed'){[IO.File]::WriteAllText($global:contractTarget,'{"FIELDS":[]}')}
        return $global:positiveReceipt
    }
}
$global:positiveReceipt=$cases[0].text
$driven=@()
foreach($global:mode in @('success','confirmed','unconfirmed','contract-changed','cross-contract')){
    $root=Join-Path $FixtureRoot $global:mode
    [IO.Directory]::CreateDirectory((Join-Path $root 'payload/runtime/node'))|Out-Null
    $global:contractTarget=Join-Path $root 'diagnostic-contract.json'
    [IO.File]::Copy($ContractFile,$global:contractTarget)
    [IO.File]::WriteAllText((Join-Path $root 'staging-identity.json'),'{}')
    $staging=@{manifestSha256=('a'*64);codexSha256=('b'*64);claudeSha256=('c'*64)}
    [IO.File]::WriteAllText((Join-Path $root 'staging-identity.json'),($staging|ConvertTo-Json -Compress))
    $sha=(Get-FileHash -LiteralPath $global:contractTarget).Hash.ToLowerInvariant()
    $materials=@{networkRoot=(Join-Path $root 'n08-hosted-network');caSha256=('d'*64);leafSha256=('e'*64)}
    $state=@{treeEmpty=$true;report=$null};$failed=$false
    $usedContract=$contract
    if($global:mode -eq 'cross-contract'){$usedContract=$contract|ConvertTo-Json -Depth 6|ConvertFrom-Json;$usedContract.SCOPE=if($Client -ceq 'codex'){'staged_claude_enhanced_protocol_diagnostic'}else{'staged_codex_enhanced_stop_diagnostic'}}
    try{$null=& $module {param($r,$c,$m,$s,$contract,$sha,$client) Invoke-HpmCodexStopDiagnosticDriver $r $c $m $s $contract $sha $client} $root $Repository $materials $state $usedContract $sha $Client 6>$null}catch{$failed=$true}
    $driven+=@{mode=$global:mode;failed=$failed;treeEmpty=$state.treeEmpty;reportPresent=($null -ne $state.report)}
}
@{parsed=$parsed;driven=$driven}|ConvertTo-Json -Compress -Depth 5
