Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'persistent-io-schema.psm1')
Import-Module (Join-Path $PSScriptRoot 'persistent-io-schema-process.psm1')
Import-Module (Join-Path $PSScriptRoot 'persistent-io-schema-tool.psm1')
Import-Module (Join-Path $PSScriptRoot 'persistent-io-schema-tdh.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -DisableNameChecking
function Test-HpmSchemaAuthority {
    return ($env:GITHUB_JOB -ceq 'minifilter-schema-discovery' -and $env:GITHUB_WORKFLOW_REF -cmatch '\Acbhandsun/https-proxy/\.github/workflows/windows-persistent-io-coverage\.yml@refs/(?:heads|tags)/[A-Za-z0-9_./-]+\z' -and $env:GITHUB_SHA -cmatch '\A[a-f0-9]{40}\z')
}
function Assert-HpmSchemaPlatform {
    if(-not $IsWindows -or $env:CI -cne 'true' -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or $env:GITHUB_REPOSITORY -cne 'cbhandsun/https-proxy'){throw 'io_schema_failed'}
}
function Test-HpmSchemaAdministrator {
    return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-HpmSchemaTool([string]$Name) { return (Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
function Set-HpmSchemaToolWitness([string]$Name,[string]$Path){
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $link=$item.PSObject.Properties['LinkType']
    $script:SchemaHostWitness[$Name+'HardLink']=($null -ne $link -and $link.Value -ceq 'HardLink')
    $script:SchemaHostWitness[$Name+'Reparse']=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Get-HpmSchemaHost {
    $script:SchemaHostCause='authority'
    if(-not (Test-HpmSchemaAuthority)){throw 'io_schema_failed'}
    $script:SchemaHostCause='platform';Assert-HpmSchemaPlatform
    $script:SchemaHostCause='administrator';if(-not (Test-HpmSchemaAdministrator)){throw 'io_schema_failed'}
    $script:SchemaHostCause='temp-path';$parent=[IO.Path]::GetFullPath($env:RUNNER_TEMP)
    Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($parent)) $parent 'Container'
    $script:SchemaHostCause='workspace-path';$workspace=[IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
    Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($workspace)) $workspace 'Container'
    $script:SchemaHostCause='git-discovery';$git=Get-HpmSchemaTool 'git'
    $script:SchemaHostCause='git-query';$identity=Invoke-HpmSchemaCaptureProcess $git @('-C',$workspace,'rev-parse','HEAD') 30000 16384
    $script:SchemaHostCause='source-identity'
    if($identity.ExitCode -ne 0 -or $identity.Output.Trim() -cne $env:GITHUB_SHA){throw 'io_schema_failed'}
    $script:SchemaHostCause='wpr-path';$wpr=Join-Path $env:SystemRoot 'System32/wpr.exe'
    Set-HpmSchemaToolWitness 'wpr' $wpr
    Assert-HpmSchemaWprTool $wpr
    $script:SchemaHostCause='node-discovery';$node=Get-HpmSchemaTool 'node'
    $script:SchemaHostCause='node-path';Set-HpmSchemaToolWitness 'node' $node
    Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($node)) $node 'Leaf'
    $script:SchemaHostCause='wpr-hash'
    $identityLease=[IO.File]::Open($wpr,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$hash=Get-HpmSchemaWprHash $wpr;if((Get-HpmSchemaWprHash $wpr) -cne $hash){throw 'io_schema_failed'}}finally{$identityLease.Dispose()}
    $script:SchemaHostCause='complete'
    return @{workspace=$workspace;parent=$parent;wpr=$wpr;node=$node;sha=$env:GITHUB_SHA;wprHash=$hash}
}
function Invoke-HpmSchemaWpr($HostInfo,[string]$Instance,[string[]]$Arguments){
    if($Instance -cnotmatch '\AHpmIoSchema[a-f0-9]{32}\z' -or (Get-HpmSchemaWprHash $HostInfo.wpr) -cne $HostInfo.wprHash){throw 'io_schema_failed'}
    $result=Invoke-HpmSchemaCaptureProcess $HostInfo.wpr @($Arguments+@('-instancename',$Instance)) 30000 16384
    if($result.ExitCode -ne 0 -or (Get-HpmSchemaWprHash $HostInfo.wpr) -cne $HostInfo.wprHash){throw 'io_schema_failed'}
}
function New-HpmSchemaOwnedJob {
    if(-not $IsWindows){throw 'io_schema_failed'}
    if(-not ('HpmRuntimeBoundaryJob' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'nsis-runtime-boundary-job.cs') -ErrorAction Stop}
    return [HpmRuntimeBoundaryJob]::new()
}
function Invoke-HpmSchemaOriginalTests($HostInfo){
    $gate=Join-Path $PSScriptRoot 'persistent-io-schema-tests.cjs'
    Assert-HpmLifecycleArtifactPath $HostInfo.workspace $gate 'Leaf'
    Initialize-HpmSchemaCaptureProcess
    $job=New-HpmSchemaOwnedJob
    return Invoke-HpmSchemaCaptureProcess $HostInfo.node @($gate) 600000 2097152 $job
}
function Read-HpmSchemaEvents([string]$Trace,[hashtable]$State){
    Get-WinEvent -Path $Trace -Oldest -ErrorAction Stop | ForEach-Object {
        if($null -eq $_.ProviderId -or $null -eq $_.Id -or $null -eq $_.Version -or $null -eq $_.Opcode){throw 'io_schema_failed'}
        Add-HpmIoSchemaRecord -State $State -Provider $_.ProviderId -Id $_.Id -Version $_.Version -Opcode $_.Opcode -Text ($_.ToXml())
    }
}
function Remove-HpmSchemaRoot([string]$Parent,[string]$Root){
    Assert-HpmLifecycleArtifactPath $Parent $Root 'Container'
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
}
function Initialize-HpmSchemaHostObservation {
    $script:SchemaHostCause='unobserved';$script:SchemaHostWitness=@{wprHardLink=$null;wprReparse=$null;nodeHardLink=$null;nodeReparse=$null}
}
function Invoke-HpmPersistentIoSchemaPreflight {
    $ErrorActionPreference='Stop';Initialize-HpmSchemaHostObservation
    $passed=$false;$source=$null
    try{$value=Get-HpmSchemaHost;$source=$value.sha;$passed=$true}catch{}
    $receipt=@{schemaVersion=1;scope='hosted_minifilter_schema_preflight';sourceSha=$source;passed=$passed;hostCause=$script:SchemaHostCause;hostToolWitness=$script:SchemaHostWitness;recordingStarted=$false;realModelRequests=0;filterAttributionQualified=$false}
    [Console]::Out.WriteLine('HPM_IO_SCHEMA_PREFLIGHT='+($receipt|ConvertTo-Json -Depth 4 -Compress))
    if(-not $passed){throw 'io_schema_failed'}
}
function Invoke-HpmPersistentIoSchemaDiscovery {
    $ErrorActionPreference='Stop';$root=$null;$lease=$null;$tracePins=$null;$hostInfo=$null;$owned=$false;$phase='host';$failed=$false;$testExit=$null;$testTreeClosed=$true
    Initialize-HpmSchemaHostObservation
    $state=New-HpmIoSchemaState
    $receipt=[ordered]@{schemaVersion=1;scope='hosted_minifilter_schema_discovery';sourceSha=$null;phase='host';failed=$true;originalTestsPassed=$false;originalTestsExitCode=$null;schema=$null;tdhMetadata=$null;cleanupVerified=$false;eventSchemaVerified=$false;filterAttributionQualified=$false;fiveSecondQualified=$false;installedQualified=$false;realProviderQualified=$false;realModelRequests=0}
    try {
        $hostInfo=Get-HpmSchemaHost;$receipt.sourceSha=$hostInfo.sha
        $phase='paths';$root=Join-Path $hostInfo.parent ('hpm-io-schema-'+[Guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Path $root -ErrorAction Stop)
        $trace=Join-Path $root 'owned.etl';$instance='HpmIoSchema'+[Guid]::NewGuid().ToString('N')
        $profile=Join-Path $PSScriptRoot '../fixtures/persistent-io-schema.wprp'
        Assert-HpmLifecycleArtifactPath $hostInfo.workspace $profile 'Leaf'
        $lease=[IO.File]::Open($hostInfo.wpr,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $phase='trace-start';$owned=$true;Invoke-HpmSchemaWpr $hostInfo $instance @('-start',($profile+'!HpmIoSchema'))
        $phase='original-tests';$result=Invoke-HpmSchemaOriginalTests $hostInfo;$testExit=$result.ExitCode;$result=$null
        $receipt.originalTestsPassed=$testExit -eq 0
        $receipt.originalTestsExitCode=$testExit
        $phase='trace-stop';Invoke-HpmSchemaWpr $hostInfo $instance @('-stop',$trace,'owned synthetic I/O schema','-skipPdbGen');$owned=$false
        $phase='trace-file';Assert-HpmLifecycleArtifactPath $root $trace 'Leaf'
        if((Get-Item -LiteralPath $trace).Length -gt 268435456){throw 'io_schema_failed'}
        $tracePins=New-HpmSchemaTracePins $hostInfo $root $trace
        $phase='schema';Read-HpmSchemaEvents $trace $state
        if($state.events -eq 0){throw 'io_schema_failed'}
        if($state.named -eq 0 -and $state.unsupported -gt 0){
            $phase='tdh-metadata';$receipt.tdhMetadata=Invoke-HpmSchemaTdhMetadata $hostInfo $root $trace
        }
        $tracePins.Verify()
        if($testExit -ne 0){$phase='original-tests';throw 'io_schema_failed'}
        $phase='complete'
    } catch {$failed=$true;if($_.Exception.Message -ceq 'persistent_io_schema_cleanup_failed'){$testTreeClosed=$false}}
    finally {
        $cleanup=$true
        if($owned){try{Invoke-HpmSchemaWpr $hostInfo $instance @('-cancel')}catch{$cleanup=$false}}
        if($null -ne $lease){try{$lease.Dispose()}catch{$cleanup=$false}}
        if($null -ne $tracePins){try{$tracePins.Dispose()}catch{$cleanup=$false}}
        if($null -ne $root){try{Remove-HpmSchemaRoot $hostInfo.parent $root}catch{$cleanup=$false}}
        $cleanup=$cleanup -and $testTreeClosed
        $receipt.cleanupVerified=$cleanup
        if(-not $cleanup){$failed=$true;$phase='cleanup'}
    }
    if($script:SchemaHostCause -cnotin @('unobserved','authority','platform','administrator','temp-path','workspace-path','git-discovery','git-query','source-identity','wpr-path','node-discovery','node-path','wpr-hash','complete')){throw 'io_schema_failed'}
    $receipt.hostCause=$script:SchemaHostCause;$receipt.hostToolWitness=$script:SchemaHostWitness
    $receipt.phase=$phase;$receipt.failed=$failed;$receipt.schema=Get-HpmIoSchemaSummary $state
    $json=$receipt|ConvertTo-Json -Depth 12 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536){throw 'io_schema_failed'}
    [Console]::Out.WriteLine('HPM_IO_SCHEMA='+$json)
    if($failed){throw 'io_schema_failed'}
}
Export-ModuleMember -Function Invoke-HpmPersistentIoSchemaDiscovery,Invoke-HpmPersistentIoSchemaPreflight
