param([string]$Script,[string]$Repository,[string]$FixtureRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
class HpmN08ArtifactLease {
    [string]$Path
    HpmN08ArtifactLease([string]$path,[bool]$directory){$this.Path=$path}
    [void]Verify([string]$path){if($path -cne $this.Path){throw 'private'}}
    [void]Dispose(){}
}
class HpmHostedEgressLease {
    static [int]$Created
    static [int]$Disposed
    static [int]$FailAt
    static [HpmHostedEgressLease]ForInstalledClient([string]$program){
        [HpmHostedEgressLease]::Created++
        if([HpmHostedEgressLease]::Created -eq [HpmHostedEgressLease]::FailAt){throw 'private'}
        return [HpmHostedEgressLease]::new()
    }
    [void]Dispose(){[HpmHostedEgressLease]::Disposed++}
}
# Execute production composition with only platform-native effects replaced.
# Its staging identity, fixed programs, mutation and finally blocks stay intact.
$body=[IO.File]::ReadAllText($Script)
$start=$body.IndexOf('        if (-not $IsWindows')
$end=$body.IndexOf("        `$networkStage = 'staging_identity'",$start)
if($start -lt 0 -or $end -le $start){throw 'fixture_invalid'}
$body=$body.Remove($start,$end-$start)
$start=$body.IndexOf('        $acl = [Security.AccessControl.DirectorySecurity]::new()')
$end=$body.IndexOf("        `$networkStage = 'synthetic_certificates'",$start)
if($start -lt 0 -or $end -le $start){throw 'fixture_invalid'}
$body=$body.Remove($start,$end-$start)
$start=$body.IndexOf("        `$networkStage = 'exclusive_port'")
$end=$body.IndexOf("        `$networkStage = 'owned_materials'",$start)
if($start -lt 0 -or $end -le $start){throw 'fixture_invalid'}
$body=$body.Remove($start,$end-$start)
. ([scriptblock]::Create($body))
function Write-Information {param($MessageData,$InformationAction) if($MessageData -cmatch '^codex_stop_network_failed_stage=([a-z_]+)$'){$global:diagnosticStage=$Matches[1]}}
function git {param($C,$Directory,$Command,$Head) $global:LASTEXITCODE=0;return 'a'*40}
function Add-Type {param($Path,$ErrorAction)}
function Get-NetTCPConnection {param($LocalPort,$State,$ErrorAction)}
function Get-NetFirewallProfile {[pscustomobject]@{Name='Public';Enabled=$false}}
function Set-NetFirewallProfile {param($Name,$Enabled) $global:profileEnabled=[bool]$Enabled}
function Get-NetFirewallRule {param($Name,$ErrorAction) if($global:rules.ContainsKey($Name)){return $global:rules[$Name]}}
function New-NetFirewallRule {
    param($Name,$DisplayName,$Direction,$Action,$Enabled,$Profile,$Program,$RemoteAddress)
    if($global:mode -eq 'create'){throw 'private'}
    if(($RemoteAddress -join ',') -cne '0.0.0.0-127.0.0.0,127.0.0.2-255.255.255.255,::/1,8000::/1'){throw 'fixture_invalid'}
    $global:rules[$Name]=[pscustomobject]@{Enabled='True';Action='Block';Direction='Outbound';Program=$Program}
}
function Get-NetFirewallApplicationFilter {param([Parameter(ValueFromPipeline)]$Rule) process {return @{Program=$Rule.Program}}}
function Remove-NetFirewallRule {param($Name,$ErrorAction) if($global:mode -eq 'remove'){throw 'private'};$global:rules.Remove($Name)}
function Clear-DnsClientCache {}
function New-SelfSignedCertificate {
    param($Type,$Subject,$CertStoreLocation,$KeyAlgorithm,$KeyLength,$HashAlgorithm,$KeyExportPolicy,$KeyUsage,$TextExtension,$NotAfter,$DnsName,$Signer)
    if($global:mode -eq 'cert'){throw 'private'}
    if($Type -eq 'SSLServerAuthentication' -and ($DnsName -join ',') -cne 'api.openai.com,n08-target.invalid,api.anthropic.com'){throw 'fixture_invalid'}
    return [pscustomobject]@{RawData=[byte[]](1..128);Thumbprint=[Guid]::NewGuid().ToString('N')}
}
function Export-PfxCertificate {param($Cert,$FilePath,$Password) [IO.File]::WriteAllBytes($FilePath,[byte[]](1..128))}
function Remove-Item {
    param($LiteralPath,[switch]$DeleteKey,[switch]$Force,$ErrorAction)
    if($LiteralPath.StartsWith('Cert:')){$global:certRemoved++;return}
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force
}
$env:GITHUB_WORKSPACE=Join-Path $FixtureRoot 'workspace'
$env:RUNNER_TEMP=Join-Path $FixtureRoot 'runner'
$env:GITHUB_SHA='a'*40
$env:SystemRoot=Join-Path $FixtureRoot 'system'
$candidate=Join-Path $env:GITHUB_WORKSPACE 'current'
$shared=Join-Path $candidate 'scripts/context-hosted/shared'
[IO.Directory]::CreateDirectory($shared)|Out-Null
[IO.Directory]::CreateDirectory($env:RUNNER_TEMP)|Out-Null
foreach($name in @('hosted-materials.ps1','installed-client-network.ps1')){[IO.File]::Copy((Join-Path $Repository ('scripts/context-hosted/shared/'+$name)),(Join-Path $shared $name))}
$hosts=Join-Path $env:SystemRoot 'System32/drivers/etc/hosts'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($hosts))|Out-Null
$observed=@()
foreach($global:mode in @('success','staging','cert','create','wfp','hosts','scenario','receipt','stop','remove','foreign-host-change')){
    $root=Join-Path $env:RUNNER_TEMP 'hpm-installed-clients'
    if([IO.Directory]::Exists($root)){Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force}
    foreach($dir in @('payload/runtime/node','clients')){[IO.Directory]::CreateDirectory((Join-Path $root $dir))|Out-Null}
    foreach($name in @('payload/runtime/node/node.exe','payload/release-runtime-manifest.json','clients/codex.exe','clients/claude.exe')){[IO.File]::WriteAllText((Join-Path $root $name),'synthetic')}
    $hash=(Get-FileHash -LiteralPath (Join-Path $root 'clients/codex.exe')).Hash.ToLowerInvariant()
    $receipt=@{schemaVersion=1;scope='noninstalled_staged_codex_stop_diagnostic';sourceSha=('a'*40);manifestSha256=$hash;nodeSha256=$hash;codexSha256=$hash;claudeSha256=$hash;installedQualified=$false;realProvider=$false;modelRequests=$(if($global:mode -eq 'staging'){1}else{0});npmLocked=$true;stagingValidated=$true}
    $file=Join-Path $root 'staging-identity.json';[IO.File]::WriteAllText($file,($receipt|ConvertTo-Json -Compress))
    $sha=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()
    $before=if($global:mode -eq 'hosts'){'127.0.0.1 api.openai.com'}else{'# synthetic original'}
    [IO.File]::WriteAllText($hosts,$before)
    $global:rules=@{};$global:profileEnabled=$false;$global:certRemoved=0;$global:stopCalls=0
    [HpmHostedEgressLease]::Created=0;[HpmHostedEgressLease]::Disposed=0;[HpmHostedEgressLease]::FailAt=$(if($global:mode -eq 'wfp'){2}else{-1})
    $failed=$false;$global:diagnosticStage='unobserved'
    try{
        $result=Invoke-HpmCodexStopDiagnosticNetwork -OwnedRoot $root -StagingReceiptSha256 $sha -CandidateRoot $candidate -RunOwnedScenario {
            param($materials)
            if($global:mode -eq 'scenario'){throw 'private'}
            if($global:mode -eq 'foreign-host-change'){[IO.File]::WriteAllText($hosts,'foreign')}
            return @{diagnosticPassed=($global:mode -ne 'receipt');installedQualified=$false;realProvider=$false;modelRequests=0;probesPassed=$true;tlsVerified=$true;nonLoopbackBlocked=$true;listenerOwned=$true;ownedTreeEmpty=$true;syntheticSocketsClosed=$true}
        } -StopOwnedScenario {$global:stopCalls++;return $global:mode -ne 'stop'} 6>$null
        if($result.phase -cne 'codex_stop_diagnostic_network_finished'){throw 'fixture_invalid'}
    }catch{$failed=$true}
    $observed+=@{stage=$global:diagnosticStage;mode=$global:mode;failed=$failed;rules=$global:rules.Count;profileEnabled=$global:profileEnabled;hostsRestored=([IO.File]::ReadAllText($hosts) -ceq $before);wfpCreated=[HpmHostedEgressLease]::Created;wfpDisposed=[HpmHostedEgressLease]::Disposed;stopCalls=$global:stopCalls;certRemoved=$global:certRemoved}
}
$observed|ConvertTo-Json -Compress
