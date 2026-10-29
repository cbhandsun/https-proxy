param(
    [string]$SpecFile,
    [string]$SpecSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$process = $null; $job = $null; $started = $false; $assigned = $false; $failed = $false
$pipes = $null
$failurePhase = $null; $ownedPhase = 'admission'
function Set-OwnedFailure([string]$Phase) {
    $script:failed = $true
    if ($null -eq $script:failurePhase) { $script:failurePhase = $Phase }
}
function Assert-Physical([string]$Path, [bool]$Directory) {
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\') -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'nsis_client_owned_failed' }
    $current = $Path; $first = $true
    while (-not [string]::IsNullOrEmpty($current)) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($first -and $item.PSIsContainer -ne $Directory) -or (-not $first -and -not $item.PSIsContainer)) { throw 'nsis_client_owned_failed' }
        $first = $false; $current = [IO.Path]::GetDirectoryName($current)
    }
}
function Assert-Hash([string]$Path, [string]$Expected) {
    Assert-Physical $Path $false
    if ($Expected -cnotmatch '\A[a-f0-9]{64}\z' -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected) { throw 'nsis_client_owned_failed' }
}
function New-OwnedPipe([IO.Stream]$InputStream, [IO.Stream]$OutputStream) {
    $buffer = [byte[]]::new(4096)
    return @{ Stream = $InputStream; Output = $OutputStream; Buffer = $buffer; Count = 0; Ended = $false; Task = $InputStream.ReadAsync($buffer, 0, $buffer.Length) }
}
function Update-OwnedPipes([object[]]$Pipes) {
    foreach ($pipe in $Pipes) {
        if ($pipe.Ended -or -not $pipe.Task.IsCompleted) { continue }
        $count = $pipe.Task.GetAwaiter().GetResult()
        if ($count -eq 0) { $pipe.Ended = $true; continue }
        $pipe.Count += $count
        if ($pipe.Count -gt 262144) { throw 'nsis_client_owned_failed' }
        $pipe.Output.Write($pipe.Buffer, 0, $count)
        $pipe.Output.Flush()
        $pipe.Task = $pipe.Stream.ReadAsync($pipe.Buffer, 0, $pipe.Buffer.Length)
    }
}
function Assert-OwnedExit($Process) {
    if (-not $Process.HasExited) { Set-OwnedFailure 'natural_exit_timeout'; throw 'nsis_client_owned_failed' }
    if ($Process.ExitCode -ne 0) { Set-OwnedFailure 'natural_exit_code'; throw 'nsis_client_owned_failed' }
}
function Wait-OwnedExit($Process, [object[]]$Pipes) {
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    while (-not $Process.HasExited -and $elapsed.ElapsedMilliseconds -lt 5000) {
        Update-OwnedPipes $Pipes
        [Threading.Thread]::Sleep(10)
    }
    Assert-OwnedExit $Process
}
try {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') { throw 'nsis_client_owned_failed' }
    Assert-Hash $SpecFile $SpecSha256
    if ((Get-Item -LiteralPath $SpecFile).Length -gt 65536) { throw 'nsis_client_owned_failed' }
    $spec = [IO.File]::ReadAllText($SpecFile) | ConvertFrom-Json -AsHashtable -Depth 12
    $root = Join-Path $env:RUNNER_TEMP 'hpm-installed-clients'
    Assert-Physical $root $true
    $expectedSpec = if ($spec.schemaVersion -eq 1) { 'client-launch.json' } elseif ($spec.schemaVersion -eq 2 -and $spec.client -ceq 'claude') { 'client-resume.json' } else { throw 'nsis_client_owned_failed' }
    if ($spec.ownedRoot -ine $root -or $spec.client -cnotin @('codex','claude') -or $SpecFile -cne (Join-Path $spec.caseRoot $expectedSpec) -or -not $spec.caseRoot.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'nsis_client_owned_failed' }
    Assert-Physical $spec.caseRoot $true
    if ($spec.schemaVersion -eq 2) { Assert-Hash (Join-Path $spec.caseRoot 'client-launch.json') $spec.predecessorSha256 }
    $node = Join-Path $root 'payload/runtime/node/node.exe'
    $binary = Join-Path $root ('clients/' + $spec.client + '.exe')
    $manifest = Join-Path $root 'payload/release-runtime-manifest.json'
    $launcher = Join-Path $PSScriptRoot 'nsis-client-owned-launcher.cjs'
    Assert-Hash $node $spec.nodeSha256; Assert-Hash $binary $spec.binarySha256
    Assert-Hash $manifest $spec.manifestSha256; Assert-Hash $launcher $spec.launcherSha256
    $ownedPhase = 'launch'
    if (-not ('HpmRuntimeBoundaryJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'nsis-runtime-boundary-job.cs') -ErrorAction Stop }
    $job = [HpmRuntimeBoundaryJob]::new()
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node; $start.WorkingDirectory = $spec.caseRoot
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.Environment.Clear()
    foreach ($key in @('SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','RUNNER_TEMP')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if (-not [string]::IsNullOrEmpty($value)) { $start.Environment[$key] = $value }
    }
    foreach ($argument in @($launcher, $SpecFile, $SpecSha256)) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    if (-not $process.Start()) { throw 'nsis_client_owned_failed' }; $started = $true
    $job.Assign($process); $assigned = $true
    $process.StandardInput.BaseStream.WriteByte(49); $process.StandardInput.BaseStream.Flush()
    $ownedPhase = 'forward'
    $toChild = [Console]::OpenStandardInput().CopyToAsync($process.StandardInput.BaseStream)
    $pipes = @((New-OwnedPipe $process.StandardOutput.BaseStream ([Console]::OpenStandardOutput())), (New-OwnedPipe $process.StandardError.BaseStream ([IO.Stream]::Null)))
    while (-not $toChild.IsCompleted) {
        if ($process.HasExited) { throw 'nsis_client_owned_failed' }
        Update-OwnedPipes $pipes
        [Threading.Thread]::Sleep(10)
    }
    $ownedPhase = 'eof'
    $null = $toChild.GetAwaiter().GetResult()
    $process.StandardInput.Close()
    $ownedPhase = 'natural_exit'
    Wait-OwnedExit $process $pipes
} catch { Set-OwnedFailure $ownedPhase } finally {
    # Even assignment failure releases the waiting launcher without granting it
    # permission to spawn. There is no arbitrary-process kill fallback.
    if ($started) { try { $process.StandardInput.Close() } catch { Set-OwnedFailure 'eof' } }
    if ($null -ne $job) {
        try { $job.StopAndWait(5000) } catch { Set-OwnedFailure 'job_cleanup' } finally { $job.Dispose() }
    }
    if ($started) {
        try { if (-not $process.WaitForExit(5000)) { Set-OwnedFailure 'process_cleanup' } } catch { Set-OwnedFailure 'process_cleanup' }
    }
    if ($null -ne $pipes) {
        try {
            $elapsed = [Diagnostics.Stopwatch]::StartNew()
            while (@($pipes | Where-Object { -not $_.Ended }).Count -gt 0 -and $elapsed.ElapsedMilliseconds -lt 5000) {
                Update-OwnedPipes $pipes
                [Threading.Thread]::Sleep(10)
            }
            if (@($pipes | Where-Object { -not $_.Ended }).Count -gt 0) { Set-OwnedFailure 'drain' }
        } catch { Set-OwnedFailure 'drain' }
    }
    if ($null -ne $process) { $process.Dispose() }
}
try {
    if ($failed) { throw 'nsis_client_owned_failed' }
    Assert-Hash $SpecFile $SpecSha256; Assert-Hash $node $spec.nodeSha256
    Assert-Hash $binary $spec.binarySha256; Assert-Hash $manifest $spec.manifestSha256; Assert-Hash $launcher $spec.launcherSha256
} catch {
    Set-OwnedFailure 'final_identity'
    if ($failurePhase -cnotin @('admission','launch','forward','eof','natural_exit','job_cleanup','process_cleanup','drain','final_identity','natural_exit_timeout','natural_exit_code')) { $failurePhase = 'admission' }
    [Console]::Error.WriteLine('HPM_OWNED_FAILURE=' + $failurePhase)
    [Console]::Error.WriteLine('nsis_client_owned_failed'); exit 1
}
exit 0
