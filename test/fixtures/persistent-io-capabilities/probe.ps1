param([string]$Repository,[string]$Node)
$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $Repository 'scripts/lib/persistent-io-capabilities.psm1') -Force -PassThru
$rows=& $module {
    $root=Join-Path ([IO.Path]::GetTempPath()) ('hpm-capability-mock-'+[Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory $root)
    $script:binary=Join-Path $root 'mock.bin';[IO.File]::WriteAllText($script:binary,'fixed metadata fixture')
    $script:binaryHash=(Get-FileHash $script:binary).Hash.ToLowerInvariant()
    function Get-CapabilityHost { @{admin=($script:mode -cne 'nonadmin');osVersion='10.0.26100.1';path=$(if($script:mode -ceq 'missing'){$null}else{$script:binary});version=$(if($script:mode -ceq 'missing'){$null}else{'10.0.1.0'});hash=$(if($script:mode -ceq 'missing'){$null}else{$script:binaryHash})} }
    function Close-CapabilityLease($Lease) { $Lease.Dispose();$script:closed=$true;if($script:mode -ceq 'cleanup-failure'){throw 'PRIVATE_CLEANUP'} }
    function Invoke-HpmCapabilityProcess([string]$Executable,[string[]]$Arguments) {
        $script:calls++
        if($Executable -cne $script:binary){throw 'unexpected_executable'}
        if($script:mode -ceq 'command-failure'){throw 'PRIVATE_SENSITIVE_EXCEPTION'}
        if($Arguments.Count -eq 1 -and $Arguments[0] -ceq '-profiles') {
            switch -CaseSensitive ($script:mode) {
                'absent' { return "Available profiles:`nCPU CPU usage" }
                'illegal' { return 'bad;inject Minifilter I/O activity' }
                'duplicate' { return "MiniProbe Minifilter I/O activity`nMiniProbe Minifilter I/O activity" }
                'overflow' { return ('x'*16385) }
                'long-line' { return ('x'*1025) }
                'too-many' { return ((1..5|ForEach-Object { 'Mini'+$_+' Minifilter I/O activity' }) -join "`n") }
                'nul' { return ('MiniProbe Minifilter'+[char]0) }
                default { return "Available profiles:`nMiniProbe Minifilter I/O activity`nCPU CPU usage" }
            }
        }
        if($Arguments.Count -ne 2 -or $Arguments[0] -cne '-profiledetails' -or $Arguments[1] -cne 'MiniProbe'){throw 'unadmitted_command'}
        if($script:mode -ceq 'details-failure'){throw 'PRIVATE_DETAILS'}
        if($script:mode -ceq 'no-keywords'){return 'Opaque metadata description'}
        if($script:mode -ceq 'details-overflow'){return ('x'*16385)}
        return 'FilterIO FilterIOInit FilterIOFastIO FilterIOFailure PRIVATE_UNRELATED_PATH'
    }
    try {
        foreach($script:mode in @('success','missing','nonadmin','absent','illegal','duplicate','overflow','long-line','nul','command-failure','details-overflow','cleanup-failure','no-keywords','details-failure','too-many')) {
            $script:calls=0;$script:closed=$false;$result=$null;$failure=$null
            try{$result=Invoke-HpmPersistentIoCapabilities}catch{$failure=$_.Exception.Message}
            @{mode=$script:mode;calls=$script:calls;leaseClosed=$script:closed;receipt=$result;failure=$failure}
        }
    } finally { Remove-Item $root -Recurse -Force }
}
$process=Import-Module (Join-Path $Repository 'scripts/lib/persistent-io-capabilities-process.psm1') -Force -PassThru
$processRows=& $process {
    param($Node)
    $rows=@()
    foreach($mode in @('success','exit','flood','stderr-flood','timeout','utf8-max','utf8-over','invalid-utf8','invalid-stderr','utf8-bom','utf16-bom','invalid-utf16','utf32-bom','dual-max','stderr-over','utf16be-bom','truncated-utf8','utf16-no-bom')) {
        $code=switch($mode){'success'{"process.stdout.write('safe');process.stderr.write('PRIVATE')"};'exit'{"process.stderr.write('PRIVATE');process.exit(2)"};'flood'{"setInterval(()=>process.stdout.write('x'.repeat(4096)),1)"};'stderr-flood'{"setInterval(()=>process.stderr.write('x'.repeat(4096)),1)"};'timeout'{"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)"}}
        if($mode -ceq 'utf8-max'){$code="process.stdout.write('中'.repeat(5461)+'x')"}
        if($mode -ceq 'utf8-over'){$code="process.stdout.write('中'.repeat(5462))"}
        if($mode -ceq 'invalid-utf8'){$code="process.stdout.write(Buffer.from([0xc3,0x28]))"}
        if($mode -ceq 'invalid-stderr'){$code="process.stdout.write('safe');process.stderr.write(Buffer.from([0xff]))"}
        if($mode -ceq 'utf8-bom'){$code="process.stdout.write(Buffer.from([0xef,0xbb,0xbf,0x73,0x61,0x66,0x65]))"}
        if($mode -ceq 'utf16-bom'){$code="process.stdout.write(Buffer.from([0xff,0xfe,0x73,0,0x61,0,0x66,0,0x65,0]))"}
        if($mode -ceq 'utf16be-bom'){$code="process.stdout.write(Buffer.from([0xfe,0xff,0,0x73,0,0x61,0,0x66,0,0x65]))"}
        if($mode -ceq 'truncated-utf8'){$code="process.stdout.write(Buffer.from([0x73,0xc2]))"}
        if($mode -ceq 'utf16-no-bom'){$code="process.stdout.write(Buffer.from([0x73,0,0x61,0]))"}
        if($mode -ceq 'invalid-utf16'){$code="process.stdout.write(Buffer.from([0xff,0xfe,0,0xd8]))"}
        if($mode -ceq 'utf32-bom'){$code="process.stdout.write(Buffer.from([0xff,0xfe,0,0,0x73,0,0,0]))"}
        if($mode -ceq 'dual-max'){$code="process.stdout.write('x'.repeat(16384));process.stderr.write('y'.repeat(16384))"}
        if($mode -ceq 'stderr-over'){$code="process.stdout.write('safe');process.stderr.write('中'.repeat(5462))"}
        $value=$null;$failure=$null;$closed=$true
        $pidFile=Join-Path ([IO.Path]::GetTempPath()) ('hpm-capability-child-'+[Guid]::NewGuid().ToString('N'))
        try {
            try{$value=Invoke-HpmCapabilityProcess $Node @('-e',$code,$pidFile)}catch{$failure=$_.Exception.Message}
            if($mode -ceq 'timeout') {
                $childId=[int][IO.File]::ReadAllText($pidFile)
                try{$child=[Diagnostics.Process]::GetProcessById($childId);$closed=$child.HasExited;$child.Dispose()}catch [ArgumentException]{$closed=$true}
                if(-not $closed){throw 'owned_process_not_closed'}
            }
        } finally {if(Test-Path -LiteralPath $pidFile){Remove-Item -LiteralPath $pidFile}}
        $rows+=@{mode=$mode;value=$(if($null -ne $value -and $value.Length -gt 16){'<bounded>'}else{$value});valueBytes=$(if($null -ne $value){[Text.Encoding]::UTF8.GetByteCount($value)}else{0});failure=$failure;cleanupVerified=$closed}
    }
    return $rows
} $Node
@{cases=@($rows);processCases=@($processRows)}|ConvertTo-Json -Depth 12 -Compress
