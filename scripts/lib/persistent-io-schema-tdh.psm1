Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'persistent-io-schema-process.psm1')
Import-Module (Join-Path $PSScriptRoot 'persistent-io-schema-tdh-contract.psm1')
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -DisableNameChecking

function Close-HpmTdhLeases($Leases) {
    $closed=$true
    foreach($lease in $Leases){try{$lease.Dispose()}catch{$closed=$false}}
    return $closed
}
function New-HpmSchemaTracePins($HostInfo,[string]$Root,[string]$Trace) {
    $lease=$null;$pins=$null;$failed=$false;$cleanupFailed=$false
    try {
        Assert-HpmLifecycleArtifactPath $HostInfo.parent $Root 'Container'
        Assert-HpmLifecycleArtifactPath $Root $Trace 'Leaf'
        $file=Join-Path $PSScriptRoot 'persistent-io-schema-tdh-path.cs'
        Assert-HpmLifecycleArtifactPath $HostInfo.workspace $file 'Leaf'
        $lease=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        if(-not ('HpmIoSchemaTdh.TracePins' -as [type])){Add-Type -Path $file -ErrorAction Stop}
        $pins=[HpmIoSchemaTdh.TracePins]::OpenOwned($Trace)
    } catch {$failed=$true}
    finally {if($null -ne $lease){try{$lease.Dispose()}catch{$cleanupFailed=$true}}}
    if($failed -or $cleanupFailed){
        if($null -ne $pins){try{$pins.Dispose()}catch{$cleanupFailed=$true}}
        if($cleanupFailed){throw 'persistent_io_schema_cleanup_failed'}
        throw 'io_schema_tdh_failed'
    }
    return $pins
}
function Stop-HpmTdhFailure($Result) {
    if($Result.ExitCode -eq 1){
        $failure=ConvertFrom-HpmTdhMetadataFailure $Result.Output
        [Console]::Out.WriteLine('HPM_IO_SCHEMA_TDH_FAILURE='+($failure|ConvertTo-Json -Compress))
    }
    throw 'io_schema_tdh_failed'
}
function Invoke-HpmSchemaTdhMetadata($HostInfo,[string]$Root,[string]$Trace) {
    $leases=[Collections.Generic.List[IDisposable]]::new()
    $failed=$false;$cleanupFailed=$false;$summary=$null
    try {
        if(-not $IsWindows -or $Root -cne [IO.Path]::GetFullPath($Root) -or [IO.Path]::GetDirectoryName($Root) -cne [IO.Path]::GetFullPath($env:RUNNER_TEMP) -or [IO.Path]::GetFileName($Root) -cnotmatch '\Ahpm-io-schema-[a-f0-9]{32}\z' -or $Trace -cne (Join-Path $Root 'owned.etl')){throw 'refused'}
        Assert-HpmLifecycleArtifactPath $HostInfo.parent $Root 'Container'
        Assert-HpmLifecycleArtifactPath $Root $Trace 'Leaf'
        $names=@('persistent-io-schema-tdh-native.cs','persistent-io-schema-tdh-metadata.cs','persistent-io-schema-tdh-path.cs','persistent-io-schema-tdh-reader.cs')
        $pins=[ordered]@{}
        foreach($name in @('persistent-io-schema-tdh-child.ps1')+$names){
            $file=Join-Path $PSScriptRoot $name
            Assert-HpmLifecycleArtifactPath $HostInfo.workspace $file 'Leaf'
            $leases.Add([IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read))
            if($name -cin $names){$pins[$name]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
        $pwsh=[Environment]::ProcessPath
        Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($pwsh)) $pwsh 'Leaf'
        $leases.Add([IO.File]::Open($pwsh,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read))
        if(-not ('HpmRuntimeBoundaryJob' -as [type])){throw 'refused'}
        $job=[HpmRuntimeBoundaryJob]::new()
        $result=Invoke-HpmSchemaCaptureProcess $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'persistent-io-schema-tdh-child.ps1'),'-Root',$Root,'-Trace',$Trace,'-SourceSha',$HostInfo.sha,'-SourcePins',($pins|ConvertTo-Json -Compress)) 30000 16384 $job
        if($result.ExitCode -ne 0){Stop-HpmTdhFailure $result}
        $summary=ConvertFrom-HpmTdhMetadataSummary $result.Output
        foreach($name in $names){if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pins[$name]){throw 'refused'}}
        Assert-HpmLifecycleArtifactPath $Root $Trace 'Leaf'
    } catch {
        $failed=$true
        if($_.Exception.Message -ceq 'persistent_io_schema_cleanup_failed'){$cleanupFailed=$true}
    } finally {if(-not (Close-HpmTdhLeases $leases)){$cleanupFailed=$true}}
    if($cleanupFailed){throw 'persistent_io_schema_cleanup_failed'}
    if($failed){throw 'io_schema_tdh_failed'}
    return $summary
}
Export-ModuleMember -Function Invoke-HpmSchemaTdhMetadata,New-HpmSchemaTracePins
