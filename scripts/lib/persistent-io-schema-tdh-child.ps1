param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][string]$Trace,[Parameter(Mandatory)][string]$SourceSha,[Parameter(Mandatory)][string]$SourcePins)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$leases=[Collections.Generic.List[IDisposable]]::new()
$failed=$false;$json=$null;$failurePhase='abi';$failureStatus=$null
try {
    # This original one-byte grant is written only after Job assignment.
    $inputStream=[Console]::OpenStandardInput()
    if($inputStream.ReadByte() -ne 49 -or $inputStream.ReadByte() -ne -1){throw 'refused'}
    if(-not $IsWindows -or $env:CI -cne 'true' -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or $env:GITHUB_REPOSITORY -cne 'cbhandsun/https-proxy' -or $env:GITHUB_JOB -cne 'minifilter-schema-discovery' -or $env:GITHUB_WORKFLOW_REF -cnotmatch '\Acbhandsun/https-proxy/\.github/workflows/windows-persistent-io-coverage\.yml@refs/(?:heads|tags)/[A-Za-z0-9_./-]+\z' -or $SourceSha -cnotmatch '\A[a-f0-9]{40}\z' -or $SourceSha -cne $env:GITHUB_SHA){throw 'refused'}
    Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -DisableNameChecking
    $parent=[IO.Path]::GetFullPath($env:RUNNER_TEMP)
    if($Root -cne [IO.Path]::GetFullPath($Root) -or [IO.Path]::GetDirectoryName($Root) -cne $parent -or [IO.Path]::GetFileName($Root) -cnotmatch '\Ahpm-io-schema-[a-f0-9]{32}\z' -or $Trace -cne (Join-Path $Root 'owned.etl')){throw 'refused'}
    Assert-HpmLifecycleArtifactPath $parent $Root 'Container'
    Assert-HpmLifecycleArtifactPath $Root $Trace 'Leaf'
    $names=@('persistent-io-schema-tdh-native.cs','persistent-io-schema-tdh-metadata.cs','persistent-io-schema-tdh-path.cs','persistent-io-schema-tdh-reader.cs')
    if($SourcePins.Length -gt 2048){throw 'refused'}
    $pins=ConvertFrom-Json -InputObject $SourcePins -AsHashtable
    if($pins.Count -ne $names.Count -or @($pins.Keys|Where-Object {$_ -cnotin $names}).Count){throw 'refused'}
    $paths=@()
    foreach($name in $names){
        $file=Join-Path $PSScriptRoot $name
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $file 'Leaf'
        if($pins[$name] -isnot [string] -or $pins[$name] -cnotmatch '\A[a-f0-9]{64}\z'){throw 'refused'}
        $leases.Add([IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read))
        if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pins[$name]){throw 'refused'}
        $paths+=$file
    }
    Add-Type -Path $paths -ErrorAction Stop
    $failurePhase='metadata'
    $summary=[HpmIoSchemaTdh.Reader]::Read($Trace)
    $failurePhase='serialization'
    $json=ConvertTo-Json -InputObject $summary -Depth 8 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384){throw 'refused'}
} catch {
    $failed=$true
    if('HpmIoSchemaTdh.Failure' -as [type]){
        $cause=[HpmIoSchemaTdh.Failure]::Describe($_.Exception,$failurePhase)
        $failurePhase=$cause.phase;$failureStatus=$cause.status
    }
} finally {
    foreach($lease in $leases){try{$lease.Dispose()}catch{if(-not $failed){$failurePhase='cleanup';$failureStatus=$null};$failed=$true}}
}
if($failed){
    $failure=@{schemaVersion=1;scope='sampled_native_event_metadata_failure';phase=$failurePhase;status=$failureStatus}
    [Console]::Out.Write(($failure|ConvertTo-Json -Compress));exit 1
}
[Console]::Out.Write($json)
