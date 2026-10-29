Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'persistent-io-schema.psm1')
Import-Module (Join-Path $PSScriptRoot 'persistent-io-schema-process.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -DisableNameChecking
function Test-HpmSchemaAuthority {
    return ($env:GITHUB_JOB -ceq 'minifilter-schema-discovery' -and $env:GITHUB_WORKFLOW_REF -cmatch '\Acbhandsun/https-proxy/\.github/workflows/windows-persistent-io-coverage\.yml@refs/(?:heads|tags)/[A-Za-z0-9_./-]+\z' -and $env:GITHUB_SHA -cmatch '\A[a-f0-9]{40}\z')
}
function Get-HpmSchemaHost {
    if(-not (Test-HpmSchemaAuthority) -or -not $IsWindows -or $env:CI -cne 'true' -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or $env:GITHUB_REPOSITORY -cne 'cbhandsun/https-proxy' -or $env:GITHUB_SHA -cnotmatch '\A[a-f0-9]{40}\z'){throw 'io_schema_failed'}
    if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'io_schema_failed'}
    $workspace=[IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
    $parent=[IO.Path]::GetFullPath($env:RUNNER_TEMP)
    Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($parent)) $parent 'Container'
    Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($workspace)) $workspace 'Container'
    $git=(Get-Command git -CommandType Application -ErrorAction Stop).Source
    $identity=Invoke-HpmSchemaCaptureProcess $git @('-C',$workspace,'rev-parse','HEAD') 30000 16384
    if($identity.ExitCode -ne 0 -or $identity.Output.Trim() -cne $env:GITHUB_SHA){throw 'io_schema_failed'}
    $wpr=Join-Path $env:SystemRoot 'System32/wpr.exe'
    Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($wpr)) $wpr 'Leaf'
    $node=(Get-Command node -CommandType Application -ErrorAction Stop).Source
    Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($node)) $node 'Leaf'
    return @{workspace=$workspace;parent=$parent;wpr=$wpr;node=$node;sha=$env:GITHUB_SHA;wprHash=(Get-FileHash $wpr).Hash}
}
function Invoke-HpmSchemaWpr($HostInfo,[string]$Instance,[string[]]$Arguments){
    if($Instance -cnotmatch '\AHpmIoSchema[a-f0-9]{32}\z' -or (Get-FileHash $HostInfo.wpr).Hash -cne $HostInfo.wprHash){throw 'io_schema_failed'}
    $result=Invoke-HpmSchemaCaptureProcess $HostInfo.wpr @($Arguments+@('-instancename',$Instance)) 30000 16384
    if($result.ExitCode -ne 0 -or (Get-FileHash $HostInfo.wpr).Hash -cne $HostInfo.wprHash){throw 'io_schema_failed'}
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
function Invoke-HpmPersistentIoSchemaDiscovery {
    $ErrorActionPreference='Stop';$root=$null;$lease=$null;$hostInfo=$null;$owned=$false;$phase='host';$failed=$false;$testExit=$null;$testTreeClosed=$true
    $state=New-HpmIoSchemaState
    $receipt=[ordered]@{schemaVersion=1;scope='hosted_minifilter_schema_discovery';sourceSha=$null;phase='host';failed=$true;originalTestsPassed=$false;schema=$null;cleanupVerified=$false;eventSchemaVerified=$false;filterAttributionQualified=$false;fiveSecondQualified=$false;installedQualified=$false;realProviderQualified=$false;realModelRequests=0}
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
        $phase='trace-stop';Invoke-HpmSchemaWpr $hostInfo $instance @('-stop',$trace,'owned synthetic I/O schema','-skipPdbGen');$owned=$false
        $phase='trace-file';Assert-HpmLifecycleArtifactPath $root $trace 'Leaf'
        if((Get-Item -LiteralPath $trace).Length -gt 268435456){throw 'io_schema_failed'}
        $phase='schema';Read-HpmSchemaEvents $trace $state
        if($state.events -eq 0){throw 'io_schema_failed'}
        if($testExit -ne 0){$phase='original-tests';throw 'io_schema_failed'}
        $phase='complete'
    } catch {$failed=$true;if($_.Exception.Message -ceq 'persistent_io_schema_cleanup_failed'){$testTreeClosed=$false}}
    finally {
        $cleanup=$true
        if($owned){try{Invoke-HpmSchemaWpr $hostInfo $instance @('-cancel')}catch{$cleanup=$false}}
        if($null -ne $lease){try{$lease.Dispose()}catch{$cleanup=$false}}
        if($null -ne $root){try{Remove-HpmSchemaRoot $hostInfo.parent $root}catch{$cleanup=$false}}
        $cleanup=$cleanup -and $testTreeClosed
        $receipt.cleanupVerified=$cleanup
        if(-not $cleanup){$failed=$true;$phase='cleanup'}
    }
    $receipt.phase=$phase;$receipt.failed=$failed;$receipt.schema=Get-HpmIoSchemaSummary $state
    $json=$receipt|ConvertTo-Json -Depth 12 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536){throw 'io_schema_failed'}
    [Console]::Out.WriteLine('HPM_IO_SCHEMA='+$json)
    if($failed){throw 'io_schema_failed'}
}
Export-ModuleMember -Function Invoke-HpmPersistentIoSchemaDiscovery
