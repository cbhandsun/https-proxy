param([string]$Repository)
$ErrorActionPreference='Stop'
$names=@('native','metadata','path','reader')
$files=@($names|ForEach-Object {Join-Path $Repository ('scripts/lib/persistent-io-schema-tdh-'+$_+'.cs')})
$files+=Join-Path $PSScriptRoot 'tdh.cs'
Add-Type -Path $files
$result=[HpmTdhManagedTests]::Run()
Import-Module (Join-Path $Repository 'scripts/lib/persistent-io-schema-tdh-contract.psm1') -Force
$text=$result.summary|ConvertTo-Json -Depth 8 -Compress
$safe=ConvertFrom-HpmTdhMetadataSummary $text
$policy=ConvertFrom-HpmTdhMetadataSummary ($result.policySummary|ConvertTo-Json -Depth 8 -Compress)
if($policy.layouts[0].unsupported -cne 'field_name_policy' -or $policy.layouts[0].fields.Count -ne 0){throw 'policy_qualification_changed'}
if($safe.selectedEvents -ne 2 -or $safe.layouts[0].count -ne 2){throw 'summary_invalid'}
$rejections=0
foreach($scenario in @('empty','unknown','duplicate','name','count','limit','qualification','type','provider','descriptor','reason','selected','encoding')){
    $candidate=ConvertFrom-Json -InputObject $text -AsHashtable
    switch($scenario){
        'empty' {$candidate=$null}
        'unknown' {$candidate.extra='PRIVATE'}
        'duplicate' {$candidate.layouts+=,$candidate.layouts[0]}
        'name' {$candidate.layouts[0].fields[0].name='PRIVATE/PATH'}
        'count' {$candidate.layouts[0].count=3}
        'limit' {$candidate.events=1000001}
        'qualification' {$candidate.fieldTypesVerified=$true}
        'type' {$candidate.layouts[0].fields[0].inType=65536}
        'provider' {$candidate.layouts[0].provider='PRIVATE'}
        'descriptor' {$candidate.layouts[0].descriptorIdentity='A'*64}
        'reason' {$candidate.layouts[0].unsupported='PRIVATE'}
        'selected' {$candidate.selectedEvents=0}
        'encoding' {$candidate.schemaVersion='PRIVATE'}
    }
    $rejected=$false
    try{ConvertFrom-HpmTdhMetadataSummary ($candidate|ConvertTo-Json -Depth 8 -Compress)|Out-Null}catch{if($_.Exception.Message -cne 'io_schema_tdh_failed'){throw 'unsafe_error'};$rejected=$true}
    if(-not $rejected){throw 'summary_negative_missing'};$rejections++
}
$duplicate=$text.Replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1')
try{ConvertFrom-HpmTdhMetadataSummary $duplicate|Out-Null;throw 'duplicate_accepted'}catch{if($_.Exception.Message -cne 'io_schema_tdh_failed'){throw 'duplicate_gate_failed'}}
$failureRejections=0
foreach($phase in @('abi','open','process','information-size','information-read','metadata','close','callback','serialization','cleanup','path-platform','path-shape','path-open','path-information','path-type','path-links','path-size','path-closed','path-identity','callback-record-null','callback-event-limit','callback-deadline','callback-header-size','callback-layout-limit','callback-field-limit','metadata-bounds','metadata-buffer','metadata-array','metadata-name-offset','metadata-name-termination','metadata-name-encoding','metadata-name-duplicate')){
    foreach($code in @($null,0,4294967295)){
        $failureText=@{schemaVersion=1;scope='sampled_native_event_metadata_failure';phase=$phase;status=$code}|ConvertTo-Json -Compress
        $parsed=ConvertFrom-HpmTdhMetadataFailure $failureText
        if($parsed.phase -cne $phase -or $parsed.status -ne $code){throw 'failure_receipt_changed'}
    }
}
foreach($bad in @('', '{}', 'PRIVATE', ('x'*1025),
    '{"schemaVersion":1,"schemaVersion":1,"scope":"sampled_native_event_metadata_failure","phase":"open","status":null}',
    '{"schemaVersion":1,"scope":"sampled_native_event_metadata_failure","phase":"PRIVATE","status":null}',
    '{"schemaVersion":1,"scope":"sampled_native_event_metadata_failure","phase":"open","status":-1}',
    '{"schemaVersion":1,"scope":"sampled_native_event_metadata_failure","phase":"open","status":4294967296}',
    '{"schemaVersion":1,"scope":"sampled_native_event_metadata_failure","phase":"open","status":"PRIVATE"}',
    '{"schemaVersion":1,"scope":"sampled_native_event_metadata_failure","phase":"open","status":1.5}',
    '{"schemaVersion":1,"scope":"sampled_native_event_metadata_failure","phase":"open","status":true}',
    '{"schemaVersion":1,"scope":"sampled_native_event_metadata_failure","phase":"open","status":null,"path":"PRIVATE"}')){
    $rejected=$false
    try{ConvertFrom-HpmTdhMetadataFailure $bad|Out-Null}catch{if($_.Exception.Message -cne 'io_schema_tdh_failed'){throw 'unsafe_failure'};$rejected=$true}
    if(-not $rejected){throw 'failure_negative_missing'};$failureRejections++
}
Add-Type -TypeDefinition @'
using System;
public sealed class HpmTdhDisposeFake : IDisposable {
    public static int Calls; public bool Fail;
    public void Dispose(){Calls++;if(Fail)throw new Exception("PRIVATE_DISPOSE");}
}
'@
$module=Import-Module (Join-Path $Repository 'scripts/lib/persistent-io-schema-tdh.psm1') -Force -PassThru
& $module {
    foreach($mode in @('valid','extra','unknown','wrong-exit')){
        $value=@{schemaVersion=1;scope='sampled_native_event_metadata_failure';phase='process';status=1223}
        if($mode -ceq 'extra'){$value.path='PRIVATE'}
        if($mode -ceq 'unknown'){$value.phase='PRIVATE'}
        $writer=[IO.StringWriter]::new();$original=[Console]::Out;$failed=$false
        try{
            [Console]::SetOut($writer)
            try{Stop-HpmTdhFailure @{ExitCode=$(if($mode -ceq 'wrong-exit'){2}else{1});Output=($value|ConvertTo-Json -Compress)}}catch{if($_.Exception.Message -cne 'io_schema_tdh_failed'){throw 'unsafe_error'};$failed=$true}
        }finally{[Console]::SetOut($original)}
        $output=$writer.ToString();$writer.Dispose()
        if(-not $failed){throw 'failure_green'}
        if($mode -ceq 'valid'){
            if(-not $output.StartsWith('HPM_IO_SCHEMA_TDH_FAILURE=')){throw 'missing_fixed_failure'}
            $receipt=ConvertFrom-Json $output.Substring('HPM_IO_SCHEMA_TDH_FAILURE='.Length)
            if($receipt.phase -cne 'process' -or $receipt.status -ne 1223){throw 'changed_fixed_failure'}
        }elseif($output -cne ''){throw 'unsafe_failure_printed'}
    }
    $a=[HpmTdhDisposeFake]::new();$a.Fail=$true;$b=[HpmTdhDisposeFake]::new()
    if(Close-HpmTdhLeases @($a,$b)){throw 'cleanup_failure_not_latched'}
    if([HpmTdhDisposeFake]::Calls -ne 2){throw 'cleanup_ended_early'}
}
[Console]::Out.WriteLine((@{managedChecks=$result.checks;contractRejections=$rejections+1;failureRejections=$failureRejections;nativeWindowsExecuted=$false;sampledMetadataOnly=$true;fieldTypesVerified=$false;filterAttributionQualified=$false;modelRequests=0}|ConvertTo-Json -Compress))
