param([string]$Repository,[string]$Node)
$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $Repository 'scripts/lib/persistent-io-schema.psm1') -PassThru -Force
& $module {
    function Add($state,$text,$id=1){Add-HpmIoSchemaRecord $state ([Guid]'11111111-1111-1111-1111-111111111111') $id 2 3 $text}
    $state=New-HpmIoSchemaState
    Add $state '<Event><EventData><Data Name="Irp">PRIVATE_PATH</Data><Data Name="Count">PRIVATE_TOKEN</Data></EventData></Event>'
    Add $state '<Event><EventData><Data Name="Irp">x</Data><Data Name="Count">y</Data></EventData></Event>'
    $summary=Get-HpmIoSchemaSummary $state
    if($summary.layouts.Count -ne 1 -or $summary.layouts[0].count -ne 2 -or $summary.layouts[0].fields[0].minChars -ne 1){throw 'merge_failed'}
    if(($summary|ConvertTo-Json -Depth 12)-match 'PRIVATE'){throw 'private_value_leaked'}
    Add $state '<Event><BinaryEventData>00112233</BinaryEventData></Event>' 2
    Add $state '<Event><EventData><Data>PRIVATE</Data></EventData></Event>' 3
    Add $state '<Event/>' 4
    if($state.unsupported -ne 3 -or $state.named -ne 2){throw 'unsupported_mislabeled'}
    $failures=0
    foreach($bad in @('<Other/>','<!DOCTYPE Event [<!ENTITY a "PRIVATE">]><Event>&a;</Event>','<Event><EventData><Data Name="x">a</Data><Data Name="x">b</Data></EventData></Event>','<Event><EventData><Data Name="bad/name">x</Data></EventData></Event>','<Event><EventData><Data Name="x"><nested/></Data></EventData></Event>',('x'*65537))){
        $refused=$false;try{Add (New-HpmIoSchemaState) $bad}catch{$refused=$true};if(-not $refused){throw 'invalid_accepted'};$failures++
    }
    foreach($limit in @('fields','layouts','events')){
        $s=New-HpmIoSchemaState
        if($limit -ceq 'events'){$s.events=1000000}
        if($limit -ceq 'fields'){$s.fieldCells=256}
        if($limit -ceq 'layouts'){1..64|ForEach-Object{$s.layouts["$_"]=@{}}}
        $refused=$false;try{Add $s '<Event><EventData><Data Name="x">x</Data></EventData></Event>'}catch{$refused=$true};if(-not $refused){throw 'limit_accepted'};$failures++
    }
    if($failures -ne 9){throw 'negative_cases_missing'}
}
$recording=Import-Module (Join-Path $Repository 'scripts/lib/persistent-io-schema-recording.psm1') -PassThru -Force
& $recording {
    param($Repository)
    $saved=@{};foreach($key in @('GITHUB_JOB','GITHUB_WORKFLOW_REF','GITHUB_SHA')){$saved[$key]=[Environment]::GetEnvironmentVariable($key)}
    try{
        $env:GITHUB_JOB='minifilter-schema-discovery';$env:GITHUB_WORKFLOW_REF='cbhandsun/https-proxy/.github/workflows/windows-persistent-io-coverage.yml@refs/heads/acceptance/context-recovery/test';$env:GITHUB_SHA='a'*40
        if(-not (Test-HpmSchemaAuthority)){throw 'authority_positive_failed'}
        foreach($pair in @(@('GITHUB_JOB','coverage-file-flush'),@('GITHUB_WORKFLOW_REF','foreign/workflow@refs/heads/x'),@('GITHUB_SHA','PRIVATE'))){
            $old=[Environment]::GetEnvironmentVariable($pair[0]);[Environment]::SetEnvironmentVariable($pair[0],$pair[1]);if(Test-HpmSchemaAuthority){throw 'foreign_authority_accepted'};[Environment]::SetEnvironmentVariable($pair[0],$old)
        }
    }finally{foreach($key in $saved.Keys){if($null -eq $saved[$key]){Remove-Item ('Env:'+ $key) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($key,$saved[$key])}}}
    $script:parent=Join-Path ([IO.Path]::GetTempPath()) ('hpm-schema-fixture-'+[Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory $script:parent)
    $script:wpr=Join-Path $script:parent 'mock.bin';[IO.File]::WriteAllText($script:wpr,'fixed')
    function Get-HpmSchemaHost {if($script:mode -ceq 'host'){throw 'PRIVATE'};@{sha=('a'*40);workspace=$Repository;parent=$script:parent;wpr=$script:wpr;node=$script:wpr;wprHash='fixed'}}
    function Assert-HpmLifecycleArtifactPath {param($Parent,$Path,$Kind)if($script:mode -ceq 'path'){throw 'PRIVATE'}}
    function Invoke-HpmSchemaWpr($HostInfo,$Instance,$Arguments){
        $script:commands+=,$Arguments[0]
        if($Arguments[0] -ceq '-start' -and $script:mode -ceq 'start'){throw 'PRIVATE'}
        if($Arguments[0] -ceq '-stop'){
            if($script:mode -ceq 'stop'){throw 'PRIVATE'}
            [IO.File]::WriteAllText($Arguments[1],'trace')
        }
        if($Arguments[0] -ceq '-cancel' -and $script:mode -ceq 'cancel'){throw 'PRIVATE'}
    }
    function Invoke-HpmSchemaOriginalTests($HostInfo){if($script:mode -ceq 'tree-cleanup'){throw 'persistent_io_schema_cleanup_failed'};if($script:mode -cin @('throw','cancel')){throw 'PRIVATE'};@{ExitCode=$(if($script:mode -ceq 'tests'){1}else{0});Output='PRIVATE_TEST_OUTPUT'}}
    function Read-HpmSchemaEvents($Trace,$State){
        if($script:mode -ceq 'schema'){throw 'PRIVATE'}
        if($script:mode -cne 'empty'){Add-HpmIoSchemaRecord $State ([Guid]'11111111-1111-1111-1111-111111111111') 1 2 3 '<Event><EventData><Data Name="Safe">PRIVATE_PATH</Data></EventData></Event>'}
    }
    function Remove-HpmSchemaRoot($Parent,$Root){$script:removed=$true;Remove-Item $Root -Recurse -Force;if($script:mode -ceq 'cleanup'){throw 'PRIVATE'}}
    try{
        foreach($script:mode in @('success','host','path','start','stop','tests','throw','cancel','schema','empty','cleanup','tree-cleanup')){
            $script:removed=$false;$script:commands=@();$failed=$false
            try{Invoke-HpmPersistentIoSchemaDiscovery}catch{if($_.Exception.Message -cne 'io_schema_failed'){throw 'unexpected_error'};$failed=$true}
            if(($script:mode -ceq 'success') -eq $failed){throw 'failure_gate_changed'}
            if($script:mode -cnotin @('success','host','path','schema','empty','tests','cleanup') -and $script:commands[-1] -cne '-cancel'){throw 'cancel_missing'}
            if($script:mode -cne 'host' -and -not $script:removed){throw 'cleanup_missing'}
        }
    }finally{Remove-Item $script:parent -Recurse -Force}
} $Repository

$process=Import-Module (Join-Path $Repository 'scripts/lib/persistent-io-schema-process.psm1') -PassThru -Force
& $process {
    param($Node)
    $normal=Invoke-HpmSchemaCaptureProcess $Node @('-e',"process.stdout.write('safe');process.stderr.write('PRIVATE');process.exit(2)") 30000 16384
    if($normal.ExitCode -ne 2 -or $normal.Output -cne 'safe'){throw 'exit_or_stream_changed'}
    foreach($mode in @('flood','encoding')){
        $pidFile=Join-Path ([IO.Path]::GetTempPath()) ('hpm-schema-child-'+[Guid]::NewGuid().ToString('N'))
        $body=if($mode -ceq 'flood'){"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>process.stdout.write('x'.repeat(4096)),1)"}else{"process.stderr.write(Buffer.from([255]))"}
        $refused=$false
        try{
            try{Invoke-HpmSchemaCaptureProcess $Node @('-e',$body,$pidFile) 30000 16384|Out-Null}catch{$refused=$true}
            if(-not $refused){throw 'process_limit_accepted'}
            if($mode -ceq 'flood'){
                $childId=[int][IO.File]::ReadAllText($pidFile)
                try{$child=[Diagnostics.Process]::GetProcessById($childId);$closed=$child.HasExited;$child.Dispose()}catch [ArgumentException]{$closed=$true}
                if(-not $closed){throw 'owned_process_not_closed'}
            }
        }finally{if(Test-Path -LiteralPath $pidFile){Remove-Item -LiteralPath $pidFile}}
    }
} $Node

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
public sealed class SchemaFakeJob : IDisposable {
    public bool StopCalled, Disposed, FailAssign, FailStop;
    public string ChildFile;
    private Process parent;
    public void Assign(Process process) { parent=process; if(FailAssign) throw new Exception(); }
    public void StopAndWait(int deadline) {
        StopCalled=true;
        if(deadline!=5000 || FailStop) throw new Exception();
        if(!String.IsNullOrEmpty(ChildFile) && File.Exists(ChildFile)) {
            using(var child=Process.GetProcessById(Int32.Parse(File.ReadAllText(ChildFile)))) {
                if(!child.HasExited) child.Kill(true);
                if(!child.WaitForExit(deadline)) throw new Exception();
            }
        }
        if(parent!=null && !parent.HasExited) { parent.Kill(true); if(!parent.WaitForExit(deadline)) throw new Exception(); }
    }
    public void Dispose(){Disposed=true;}
}
'@
& $process {
    param($Node)
    foreach($mode in @('normal','assign','cleanup','held-pipe')){
        $job=[SchemaFakeJob]::new();$job.FailAssign=$mode -ceq 'assign';$job.FailStop=$mode -ceq 'cleanup'
        $pidFile=Join-Path ([IO.Path]::GetTempPath()) ('hpm-schema-owned-'+[Guid]::NewGuid().ToString('N'));$job.ChildFile=$pidFile
        $body="const b=Buffer.alloc(1);require('fs').readSync(0,b,0,1,null);if(b[0]!==49)process.exit(9);process.stdout.write('safe')"
        if($mode -ceq 'held-pipe'){$body=@'
const b=Buffer.alloc(1);require('fs').readSync(0,b,0,1,null);const c=require('child_process').spawn(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",process.argv[1]],{stdio:['ignore','inherit','inherit']});c.unref();process.exit(0)
'@
        }
        $failure=$null
        try{
            try{$result=Invoke-HpmSchemaCaptureProcess $Node @('-e',$body,$pidFile) 30000 16384 $job}catch{$failure=$_.Exception.Message}
            if(-not $job.StopCalled -or -not $job.Disposed){throw 'job_not_closed'}
            if($mode -ceq 'normal'){if($null -ne $failure -or $result.Output -cne 'safe'){throw 'normal_failed'}}
            elseif($mode -ceq 'cleanup'){if($failure -cne 'persistent_io_schema_cleanup_failed'){throw 'cleanup_not_latched'}}
            elseif($failure -cne 'persistent_io_schema_failed'){throw 'failure_not_latched'}
        }finally{if(Test-Path -LiteralPath $pidFile){Remove-Item -LiteralPath $pidFile}}
    }
} $Node
