param([string]$Repository,[string]$Node)
$ErrorActionPreference='Stop'
$git=(Get-Command git -CommandType Application|Select-Object -First 1).Source
$sha=(& $git -C $Repository rev-parse HEAD).Trim()
$module=Import-Module (Join-Path $Repository 'scripts/lib/persistent-io-schema-recording.psm1') -Force -PassThru
& $module {
    param($Repository,$Node,$Git,$Sha)
    $actualGit=Get-HpmSchemaTool 'git'
    if($actualGit -isnot [string] -or $actualGit -cne $Git){throw 'command_precedence_not_single'}
    $keys=@('GITHUB_JOB','GITHUB_WORKFLOW_REF','GITHUB_SHA','GITHUB_WORKSPACE','RUNNER_TEMP','SystemRoot');$saved=@{}
    foreach($key in $keys){$saved[$key]=[Environment]::GetEnvironmentVariable($key)}
    $parent=Join-Path ([IO.Path]::GetTempPath()) ('hpm-schema-host-'+[Guid]::NewGuid().ToString('N'));[void](New-Item -ItemType Directory $parent)
    [void](New-Item -ItemType Directory (Join-Path $parent 'System32'))
    $wpr=Join-Path $parent 'System32/wpr.exe';[IO.File]::WriteAllText($wpr,'fixed read-only mock binary')
    $script:hostNode=Join-Path $parent 'node.bin';[IO.File]::WriteAllText($script:hostNode,'fixed physical node leaf')
    $script:hostGit=$Git
    $toolA=Join-Path $parent 'tools-a';$toolB=Join-Path $parent 'tools-b'
    [void](New-Item -ItemType Directory $toolA);[void](New-Item -ItemType Directory $toolB)
    $leaf=if($IsWindows){'git.exe'}else{'git'}
    Copy-Item -LiteralPath $Git -Destination (Join-Path $toolA $leaf);Copy-Item -LiteralPath $Git -Destination (Join-Path $toolB $leaf)
    $savedPath=$env:PATH
    try{
        $env:PATH=$toolA+[IO.Path]::PathSeparator+$toolB
        $candidates=@(Get-Command git -CommandType Application)
        if($candidates.Count -ne 2){throw 'ambiguous_discovery_fixture_failed'}
        $selected=Get-HpmSchemaTool 'git'
        if($selected -isnot [string] -or $selected -cne $candidates[0].Source){throw 'ambiguous_tool_not_resolved_by_precedence'}
    }finally{$env:PATH=$savedPath}
    # Only OS admission/admin and command discovery are replaced. Actual Host,
    # shared physical path validator, real bounded git process and hash run.
    function Assert-HpmSchemaPlatform {if($script:mode -ceq 'platform'){throw 'refused'}}
    function Test-HpmSchemaAdministrator {return $script:mode -cne 'administrator'}
    function Get-HpmSchemaTool([string]$Name){if($Name -ceq 'git'){return $script:hostGit};return $script:hostNode}
    try{
        $env:GITHUB_JOB='minifilter-schema-discovery';$env:GITHUB_WORKFLOW_REF='cbhandsun/https-proxy/.github/workflows/windows-persistent-io-coverage.yml@refs/heads/acceptance/context-recovery/test';$env:GITHUB_SHA=$Sha;$env:GITHUB_WORKSPACE=$Repository;$env:RUNNER_TEMP=$parent;$env:SystemRoot=$parent
        foreach($script:mode in @('normal','authority','platform','administrator','source','wpr-hardlink','wpr-symlink','node-hardlink')){
            $env:GITHUB_JOB='minifilter-schema-discovery';$env:GITHUB_SHA=$Sha
            if($script:mode -ceq 'authority'){$env:GITHUB_JOB='foreign'}
            if($script:mode -ceq 'source'){$env:GITHUB_SHA='0'*40}
            if($script:mode -cin @('wpr-hardlink','wpr-symlink')){
                Move-Item $wpr ($wpr+'.original')
                $kind=if($script:mode -ceq 'wpr-hardlink'){'HardLink'}else{'SymbolicLink'}
                [void](New-Item -ItemType $kind -Path $wpr -Target ($wpr+'.original'))
            }
            if($script:mode -ceq 'node-hardlink'){
                Move-Item $script:hostNode ($script:hostNode+'.original');[void](New-Item -ItemType HardLink -Path $script:hostNode -Target ($script:hostNode+'.original'))
            }
            Initialize-HpmSchemaHostObservation;$failed=$false
            try{$hostInfo=Get-HpmSchemaHost}catch{$failed=$true}
            $expected=switch($script:mode){'normal'{'complete'};'wpr-hardlink'{'complete'};'authority'{'authority'};'platform'{'platform'};'administrator'{'administrator'};'source'{'source-identity'};'node-hardlink'{'node-path'};default{'wpr-path'}}
            if($script:SchemaHostCause -cne $expected -or (($script:mode -cin @('normal','wpr-hardlink')) -eq $failed)){throw ('actual_host_gate_failed_'+$script:mode+':'+$script:SchemaHostCause)}
            if($script:mode -ceq 'normal' -and $hostInfo.sha -cne $Sha){throw 'source_identity_lost'}
            if($script:mode -ceq 'wpr-hardlink' -and -not $script:SchemaHostWitness.wprHardLink){throw 'hardlink_witness_lost'}
            if($script:mode -ceq 'wpr-hardlink'){Invoke-HpmPersistentIoSchemaPreflight}
            if($script:mode -ceq 'wpr-symlink' -and -not $script:SchemaHostWitness.wprReparse){throw 'reparse_witness_lost'}
            if($script:mode -cin @('wpr-hardlink','wpr-symlink')){Remove-Item $wpr;Move-Item ($wpr+'.original') $wpr}
            if($script:mode -ceq 'node-hardlink'){Remove-Item $script:hostNode;Move-Item ($script:hostNode+'.original') $script:hostNode}
        }
        $script:mode='normal'
        foreach($wrong in @('',(Join-Path $parent 'wpr.exe'),(Join-Path $parent 'System32/../System32/wpr.exe'),'\\device\wpr.exe')){
            $rejected=$false;try{Assert-HpmSchemaWprTool $wrong}catch{$rejected=$true};if(-not $rejected){throw 'wrong_tool_path_accepted'}
        }
        Move-Item $wpr ($wpr+'.original');[void](New-Item -ItemType Directory $wpr)
        try{$rejected=$false;try{Assert-HpmSchemaWprTool $wpr}catch{$rejected=$true};if(-not $rejected){throw 'directory_tool_accepted'}}finally{Remove-Item $wpr;Move-Item ($wpr+'.original') $wpr}
        $system32=Join-Path $parent 'System32';Move-Item $system32 ($system32+'.original');[void](New-Item -ItemType SymbolicLink -Path $system32 -Target ($system32+'.original'))
        try{$rejected=$false;try{Assert-HpmSchemaWprTool $wpr}catch{$rejected=$true};if(-not $rejected){throw 'ancestor_reparse_accepted'}}finally{Remove-Item $system32;Move-Item ($system32+'.original') $system32}
        $actual=Get-HpmSchemaHost
        $processCommand=Get-Command Invoke-HpmSchemaCaptureProcess
        function Invoke-HpmSchemaCaptureProcess {
            param($Executable,$Arguments,$DeadlineMs,$MaximumBytes)
            $script:wprCalls++
            if($script:identityMode -ceq 'post'){[IO.File]::WriteAllText($Executable,'changed during invocation')}
            return @{ExitCode=0;Output='PRIVATE_DISCARDED'}
        }
        try{
            foreach($script:identityMode in @('pre','post')){
                [IO.File]::WriteAllText($wpr,'fixed read-only mock binary');$actual.wprHash=(Get-FileHash $wpr).Hash
                if($script:identityMode -ceq 'pre'){[IO.File]::WriteAllText($wpr,'changed before invocation')}
                $script:wprCalls=0;$rejected=$false
                try{Invoke-HpmSchemaWpr $actual ('HpmIoSchema'+'a'*32) @('-status')}catch{$rejected=$true}
                if(-not $rejected -or $script:wprCalls -ne $(if($script:identityMode -ceq 'pre'){0}else{1})){throw 'tool_identity_drift_accepted'}
            }
        }finally{Set-Item Function:Invoke-HpmSchemaCaptureProcess $processCommand.ScriptBlock;[IO.File]::WriteAllText($wpr,'fixed read-only mock binary')}
        Invoke-HpmPersistentIoSchemaPreflight
    }finally{
        Remove-Item $parent -Recurse -Force
        foreach($key in $saved.Keys){if($null -eq $saved[$key]){Remove-Item ('Env:'+ $key) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($key,$saved[$key])}}
    }
} $Repository $Node $git $sha
