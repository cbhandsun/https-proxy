# FileIo_Name, FileIo_SimpleOp and FileIo_OpEnd:
# https://learn.microsoft.com/en-us/windows/win32/etw/fileio-simpleop
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
    if ($Opcode -in @(0,32,35,36)) {
        $key = [string]$fields['FileObject']; $name = [string]$fields['FileName']
        $hadName = $State.names.Remove($key)
        if ($Opcode -eq 35 -or $name -notmatch '(?i)[\\/]hpm-wbipc-core-[a-z0-9]{6}[\\/]context[\\/]checkpoint\.sqlite(?:-journal)?$') {
            if (-not $hadName) { return }; $name = ''
        } else { if ($State.names.Count -ge 256) { throw 'refused' }; [void]$State.names.Add($key) }
        [ordered]@{ type='name'; key=$key; timeMs=$TimeMs; name=$name } | ConvertTo-Json -Compress
    } elseif ($Opcode -eq 73) {
        $key = [string]$fields['IrpPtr']; $file = [string]$fields['FileKey']
        if (-not $State.names.Contains($file)) { return }
        if ($State.irps.Count -ge 8192) { throw 'refused' }
        [void]$State.irps.Add($key)
        [ordered]@{ type='flush'; key=$key; timeMs=$TimeMs; name=$file } | ConvertTo-Json -Compress
    } elseif ($Opcode -eq 76) {
        $key = [string]$fields['IrpPtr']
        if (-not $State.irps.Remove($key)) { return }
        [ordered]@{ type='end'; key=$key; timeMs=$TimeMs; name=[string]$fields['NtStatus'] } | ConvertTo-Json -Compress
    } else { throw 'refused' }
}

function Invoke-HpmPersistentIoDiagnostic {
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $false
    $owned = $false
    $root = $null
    $traceInstance = $null
    $phase = 'host'
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
        try {
            if (-not $process.Start()) { throw 'refused' }
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(30000)) { $process.Kill($true); [void]$process.WaitForExit(5000); throw 'refused' }
            if ($stdout.GetAwaiter().GetResult().Length -gt 16384 -or $stderr.GetAwaiter().GetResult().Length -gt 16384 -or $process.ExitCode -ne 0) { throw 'refused' }
        } finally { $process.Dispose() }
    }
    try {
        if (-not $IsWindows -or $env:CI -cne 'true' -or $args.Count -ne 0 -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'cbhandsun/https-proxy') { throw 'refused' }
        Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1')
        $phase = 'paths'
        $parent = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
        Assert-HpmLifecycleArtifactPath ([IO.Path]::GetPathRoot($parent)) $parent 'Container'
        $candidate = Join-Path $parent ('hpm-persistent-io-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $candidate | Out-Null
        $root = $candidate
        $traceInstance = 'HpmPersistentIo' + [Guid]::NewGuid().ToString('N')
        $trace = Join-Path $root 'owned.etl'
        $phase = 'trace-start'
        # Memory mode has bounded circular buffers. Never cancel an existing trace
        # to obtain ownership, and never upload the raw ETL or decoded event data.
        $owned = $true
        Invoke-HpmWpr -Arguments @('-start','FileIO')
        $phase = 'original-tests'
        & node --require ./test/helpers/physical-test-temp.cjs --test --test-concurrency=1 test/client-context-target.test.js test/context-recovery-codex-summary.test.js
        $testExit = $LASTEXITCODE
        $phase = 'trace-stop'
        Invoke-HpmWpr -Arguments @('-stop',$trace,'owned synthetic SQLite diagnosis','-skipPdbGen')
        $owned = $false
        Assert-HpmLifecycleArtifactPath $root $trace 'Leaf'
        if ((Get-Item -LiteralPath $trace).Length -gt 268435456) { throw 'refused' }
        $phase = 'decode'
        $count = 0
        $decode = @{ names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); irps = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase) }
        # FileIo GUID/opcodes follow the Microsoft FileIo_Name/SimpleOp/OpEnd
        # contracts. Decode only scalar metadata; all unrelated paths are redacted.
        $summary = Get-WinEvent -Path $trace -Oldest | ForEach-Object {
            $count++
            if ($count -gt 1000000) { throw 'refused' }
            if ($_.ProviderId.ToString() -cne '90cbdc39-4a3e-11d1-84f4-0000f80464e3') { return }
            $opcode = [int]$_.Opcode
            if ($opcode -notin @(0,32,35,36,73,76)) { return }
            ConvertTo-HpmPersistentIoRecord -Text ($_.ToXml()) -Opcode $opcode -TimeMs (([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds()) -State $decode
        } | & node (Join-Path $PSScriptRoot '../summarize-persistent-io.cjs')
        if ($LASTEXITCODE -ne 0 -or @($summary).Count -ne 1) { throw 'refused' }
        Write-Output ('HPM_PERSISTENT_IO=' + $summary)
        if ($testExit -ne 0) { $phase = 'original-assertions'; throw 'refused' }
    } catch {
        [Console]::Error.WriteLine('persistent_io_diagnostic_failed:phase=' + $phase)
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
