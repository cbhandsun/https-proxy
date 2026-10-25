# FileIo_Name, FileIo_SimpleOp and FileIo_OpEnd:
# https://learn.microsoft.com/en-us/windows/win32/etw/fileio-simpleop
# Rendering failures retain the documented binary payload here:
# https://learn.microsoft.com/en-us/windows/win32/wes/eventschema-eventpayload-processingerrordatatype-element
Import-Module (Join-Path $PSScriptRoot 'persistent-io-binary.psm1')
function ConvertTo-HpmIoPointerKey {
    param([string]$Text)
    try {
        if ($Text -cnotmatch '\A(?:0x[0-9a-fA-F]{1,16}|[0-9]{1,20})\z') { throw 'invalid' }
        if ($Text.StartsWith('0x')) { $value = [UInt64]::Parse($Text.Substring(2),[Globalization.NumberStyles]::AllowHexSpecifier,[Globalization.CultureInfo]::InvariantCulture) }
        else { $value = [UInt64]::Parse($Text,[Globalization.NumberStyles]::None,[Globalization.CultureInfo]::InvariantCulture) }
        return '0x' + $value.ToString('x16')
    } catch { throw 'persistent_io_pointer_refused' }
}
function ConvertTo-HpmPersistentIoRecord {
    param([string]$Text, [int]$Opcode, [long]$TimeMs, [hashtable]$State)
    if ($Text.Length -gt 65536 -or $TimeMs -lt 0) { throw 'refused' }
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($Text), $settings)
    $xml = [Xml.XmlDocument]::new(); $xml.XmlResolver = $null
    try { $xml.Load($reader) } finally { $reader.Dispose() }
    $fields = @{}
    foreach ($entry in $xml.SelectNodes('//*[local-name()="EventData"]/*[local-name()="Data"]')) {
        $key = $entry.GetAttribute('Name')
        if ($fields.ContainsKey($key)) { throw 'refused' }
        $fields[$key] = $entry.InnerText
    }
    $binary = $xml.SelectNodes('/*[local-name()="Event"]/*[local-name()="BinaryEventData"] | /*[local-name()="Event"]/*[local-name()="EventData"]/*[local-name()="Binary"] | /*[local-name()="Event"]/*[local-name()="ProcessingErrorData"]/*[local-name()="EventPayload"]')
    $format = 'named'
    $hex = $null
    if ($binary.Count) {
        if ($binary.Count -ne 1 -or $fields.Count) { throw 'persistent_io_payload_shape_refused' }
        $format = if ($binary[0].ParentNode.LocalName -ceq 'ProcessingErrorData') { 'processing-error' } else { 'binary' }; $hex = $binary[0].InnerText
    } elseif ($fields.Count -eq 1 -and $fields.ContainsKey('')) {
        $format = 'anonymous'; $hex = $fields['']
    } elseif ($fields.Count -eq 0) { $format = 'unmapped' }
    if ($State.ContainsKey('formats')) {
        if (-not $State.formats.ContainsKey($format)) { $State.formats[$format] = 0 }
        $State.formats[$format]++
    }
    if ($null -ne $hex) {
        $versions = $xml.SelectNodes('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="Version"]')
        if ($versions.Count -ne 1 -or $versions[0].InnerText -cnotmatch '\A[0-3]\z') { throw 'persistent_io_payload_shape_refused' }
        $fields = ConvertFrom-HpmFileIoBinary -Hex $hex -Opcode $Opcode -Version ([int]$versions[0].InnerText)
    }
    if ($State.ContainsKey('shapes')) {
        $mask = 0; $bit = 1
        foreach ($key in @('FileObject','FileName','FileKey','IrpPtr','NtStatus')) {
            if ($fields.ContainsKey($key)) { $mask += $bit }; $bit *= 2
        }
        $shape = [string]$mask
        if (-not $State.shapes.ContainsKey($shape)) { $State.shapes[$shape] = 0 }
        $State.shapes[$shape]++
    }
    if ($Opcode -in @(0,32,35,36)) {
        $key = ConvertTo-HpmIoPointerKey ([string]$fields['FileObject']); $name = [string]$fields['FileName']
        $hadName = $State.names.Remove($key)
        if ($Opcode -eq 35 -or $name -notmatch '(?i)[\\/]hpm-wbipc-core-[a-z0-9]{6}[\\/]context[\\/]checkpoint\.sqlite(?:-journal)?$') {
            if (-not $hadName) { return }; $name = ''
        } else { if ($State.names.Count -ge 256) { throw 'refused' }; [void]$State.names.Add($key) }
        [ordered]@{ type='name'; key=$key; timeMs=$TimeMs; name=$name } | ConvertTo-Json -Compress
    } elseif ($Opcode -in @(64,72,77)) {
        $key = ConvertTo-HpmIoPointerKey ([string]$fields['IrpPtr'])
        if ($State.irps.Remove($key)) { [ordered]@{type='invalidate';key=$key;timeMs=$TimeMs;name=''} | ConvertTo-Json -Compress }
    } elseif ($Opcode -in @(65,66,67,68,69,70,71,73,74,75)) {
        $key = ConvertTo-HpmIoPointerKey ([string]$fields['IrpPtr']); $file = ConvertTo-HpmIoPointerKey ([string]$fields['FileKey'])
        if ($Opcode -in @(71,74,75) -or -not $State.names.Contains($file)) {
            if ($State.irps.Remove($key)) { [ordered]@{type='invalidate';key=$key;timeMs=$TimeMs;name=''} | ConvertTo-Json -Compress }
            return
        }
        if ($State.irps.Count -ge 8192) { throw 'refused' }
        [void]$State.irps.Add($key)
        $type = @{65='cleanup';66='close';67='read';68='write';69='set-info';70='delete';73='flush'}[$Opcode]
        [ordered]@{ type=$type; key=$key; timeMs=$TimeMs; name=$file } | ConvertTo-Json -Compress
    } elseif ($Opcode -eq 76) {
        $key = ConvertTo-HpmIoPointerKey ([string]$fields['IrpPtr'])
        if (-not $State.irps.Remove($key)) { return }
        [ordered]@{ type='end'; key=$key; timeMs=$TimeMs; name=[string]$fields['NtStatus'] } | ConvertTo-Json -Compress
    } else { throw 'refused' }
}

function Read-HpmCoverageIoCommand {
    param([IO.TextReader]$Reader = [Console]::In)
    try {
        $waiting = [Diagnostics.Stopwatch]::StartNew()
        $command = [Text.StringBuilder]::new()
        $character = [char[]]::new(1)
        while ($true) {
            $remaining = 600000 - [int]$waiting.ElapsedMilliseconds
            if ($remaining -le 0) { throw 'refused' }
            $read = $Reader.ReadAsync($character,0,1)
            if (-not $read.Wait($remaining) -or $read.GetAwaiter().GetResult() -ne 1 -or $waiting.ElapsedMilliseconds -gt 600000) { throw 'refused' }
            if ($character[0] -eq [char]10) { break }
            if ($command.Length -ge 8) { throw 'refused' }
            [void]$command.Append($character[0])
        }
        if ($command.ToString() -cne 'finish') { throw 'refused' }
        $remaining = 600000 - [int]$waiting.ElapsedMilliseconds
        if ($remaining -le 0) { throw 'refused' }
        $read = $Reader.ReadAsync($character,0,1)
        if (-not $read.Wait($remaining) -or $read.GetAwaiter().GetResult() -ne 0 -or $waiting.ElapsedMilliseconds -gt 600000) { throw 'refused' }
    } catch { throw 'persistent_io_capture_command_refused' }
}

function Invoke-HpmPersistentIoDiagnostic {
    param([switch]$CaptureOnly)
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $false
    $owned = $false
    $root = $null
    $traceInstance = $null
    $phase = 'host'
    $count = 0
    $selected = 0
    $recordAttempts = 0
    $providerCounts = @{ fileIo=0; systemTrace=0; kernelFile=0; other=0 }
    function Invoke-HpmWpr([string[]]$Arguments) {
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = Join-Path $env:SystemRoot 'System32/wpr.exe'
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
        if ([string]::IsNullOrEmpty($traceInstance)) { throw 'refused' }
        $start.ArgumentList.Add('-instancename'); $start.ArgumentList.Add($traceInstance)
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $start
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $cause = 'start'
        try {
            if (-not $process.Start()) { throw 'refused' }
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            $cause = 'deadline'
            if (-not $process.WaitForExit(30000)) { $process.Kill($true); [void]$process.WaitForExit(5000); throw 'refused' }
            $cause = 'pipes'
            foreach ($pipe in @($stdout,$stderr)) {
                $remaining = [Math]::Max(0, 30000 - [int]$clock.ElapsedMilliseconds)
                if (-not $pipe.Wait($remaining)) { throw 'refused' }
            }
            $cause = 'output-limit'
            if ($stdout.GetAwaiter().GetResult().Length -gt 16384 -or $stderr.GetAwaiter().GetResult().Length -gt 16384) { throw 'refused' }
            $cause = 'exit'
            if ($process.ExitCode -ne 0) {
                [Console]::Error.WriteLine('persistent_io_wpr_exit_code=' + $process.ExitCode)
                throw 'refused'
            }
        } catch {
            [Console]::Error.WriteLine('persistent_io_wpr_failed:cause=' + $cause)
            throw 'refused'
        } finally { $process.Dispose() }
    }
    try {
        if (-not $IsWindows -or $env:RUNNER_ARCH -cne 'X64' -or $env:CI -cne 'true' -or $args.Count -ne 0 -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'cbhandsun/https-proxy') { throw 'refused' }
        if ($CaptureOnly -and ($env:HPM_COVERAGE_IO -cnotmatch '\A[a-f0-9]{40}\z' -or $env:HPM_COVERAGE_IO -cne $env:GITHUB_SHA -or $env:HPM_COVERAGE_IO_STAGE -cnotin @('proxy','client') -or -not $env:GITHUB_WORKFLOW_REF.StartsWith('cbhandsun/https-proxy/.github/workflows/windows-persistent-io-coverage.yml@'))) { throw 'refused' }
        Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
        $phase = 'paths'
        $parent = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
        Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($parent)) $parent 'Container'
        $candidate = Join-Path $parent ('hpm-persistent-io-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $candidate | Out-Null
        $root = $candidate
        $traceInstance = 'HpmPersistentIo' + [Guid]::NewGuid().ToString('N')
        $trace = Join-Path $root 'owned.etl'
        $profile = Join-Path $PSScriptRoot '../fixtures/persistent-file-io.wprp'
        Assert-HpmLifecycleArtifactPath $env:GITHUB_WORKSPACE $profile 'Leaf'
        $phase = 'trace-start'
        # Memory mode has bounded circular buffers. Never cancel an existing trace
        # to obtain ownership, and never upload the raw ETL or decoded event data.
        $owned = $true
        Invoke-HpmWpr -Arguments @('-start',($profile + '!HpmSqliteIO'))
        $phase = 'original-tests'
        if ($CaptureOnly) {
            $phase = 'capture-wait'
            # The existing test file runs in its original full coverage shard.
            # A private pipe controls recording only; it never carries a request.
            [Console]::Out.WriteLine('HPM_PERSISTENT_IO_CAPTURE_READY')
            Read-HpmCoverageIoCommand
            $testExit = 0 # The outer original coverage exit remains an independent required gate.
        } else {
            & node --require ./test/helpers/physical-test-temp.cjs --test --test-concurrency=1 test/client-context-target.test.js test/context-recovery-codex-summary.test.js
            $testExit = $LASTEXITCODE
        }
        $phase = 'trace-stop'
        Invoke-HpmWpr -Arguments @('-stop',$trace,'owned synthetic SQLite diagnosis','-skipPdbGen')
        $owned = $false
        $phase = 'trace-file'
        Assert-HpmLifecycleArtifactPath $root $trace 'Leaf'
        $phase = 'trace-size'
        $traceBytes = (Get-Item -LiteralPath $trace).Length
        [Console]::Error.WriteLine('persistent_io_trace_bytes=' + $traceBytes)
        if ($traceBytes -gt 268435456) { throw 'refused' }
        $phase = 'decode-enumeration'
        $decode = @{ names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); irps = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); shapes=@{}; formats=@{} }
        # FileIo GUID/opcodes follow the Microsoft FileIo_Name/SimpleOp/OpEnd
        # contracts. Decode only scalar metadata; all unrelated paths are redacted.
        $summary = Get-WinEvent -Path $trace -Oldest | ForEach-Object {
            $count++
            if ($count -gt 1000000) { $phase = 'decode-limit'; throw 'refused' }
            $phase = 'decode-provider'
            $provider = $_.ProviderId.ToString()
            if ($provider -ceq '90cbdc39-4a3e-11d1-84f4-0000f80464e3') { $providerCounts.fileIo++ }
            elseif ($provider -ceq '9e814aad-3204-11d2-9a82-006008a86939') { $providerCounts.systemTrace++ }
            elseif ($provider -ceq 'edd08927-9cc4-4e65-b970-c2560fb5c289') { $providerCounts.kernelFile++ }
            else { $providerCounts.other++ }
            if ($provider -cne '90cbdc39-4a3e-11d1-84f4-0000f80464e3') { $phase = 'decode-enumeration'; return }
            $selected++
            $opcode = [int]$_.Opcode
            if ($opcode -notin @(0,32,35,36,64,65,66,67,68,69,70,71,72,73,74,75,76,77)) { $phase = 'decode-enumeration'; return }
            $phase = 'decode-record'
            $recordAttempts++
            ConvertTo-HpmPersistentIoRecord -Text ($_.ToXml()) -Opcode $opcode -TimeMs (([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds()) -State $decode
            $phase = 'decode-enumeration'
        } | & node (Join-Path $PSScriptRoot '../summarize-persistent-io.cjs')
        $phase = 'decode-summary'
        if ($LASTEXITCODE -ne 0 -or @($summary).Count -ne 1) { throw 'refused' }
        Write-Output ('HPM_PERSISTENT_IO=' + $summary)
        if ($testExit -ne 0) { $phase = 'original-assertions'; throw 'refused' }
    } catch {
        [Console]::Error.WriteLine('persistent_io_diagnostic_failed:phase=' + $phase)
        if ($phase.StartsWith('decode-')) {
            [Console]::Error.WriteLine('persistent_io_decode_counts:events=' + $count + ';fileIo=' + $selected + ';records=' + $recordAttempts)
            [Console]::Error.WriteLine('persistent_io_decode_shape=' + (@{providers=$providerCounts;fields=$decode.shapes;formats=$decode.formats;knownFiles=$decode.names.Count;pendingFlushes=$decode.irps.Count}|ConvertTo-Json -Depth 4 -Compress))
        }
        exit 1
    } finally {
        $cleanupFailed = $false
        if ($owned) { try { Invoke-HpmWpr -Arguments @('-cancel') } catch { $cleanupFailed = $true } }
        if ($root) {
            try {
                Assert-HpmLifecycleArtifactPath $parent $root 'Container'
                Remove-Item -LiteralPath $root -Recurse -Force
            } catch { $cleanupFailed = $true }
        }
        if ($cleanupFailed) { [Console]::Error.WriteLine('persistent_io_diagnostic_cleanup_failed'); exit 1 }
    }
}
Export-ModuleMember -Function Invoke-HpmPersistentIoDiagnostic
