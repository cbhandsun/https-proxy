param(
    [string]$Node,
    [string]$CaseRoot,
    [string]$InstallDirectory,
    [int]$OwnerPid,
    [string]$ManifestSha256,
    [string]$Token,
    $Job
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$child = $null
function Assert-ObserverPhysical([string]$Path) {
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\') -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'observer_prepare_failed' }
    $first = $true
    for ($current = $Path; -not [string]::IsNullOrEmpty($current); $current = [IO.Path]::GetDirectoryName($current)) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($first -and $item.PSIsContainer) -or (-not $first -and -not $item.PSIsContainer)) { throw 'observer_prepare_failed' }
        $first = $false
    }
}
function New-ObserverPreparationPipe([IO.Stream]$Stream, [int]$BufferSize = 1024) {
    if ($BufferSize -lt 1 -or $BufferSize -gt 1024) { throw 'observer_prepare_failed' }
    $buffer = [byte[]]::new($BufferSize)
    return @{Stream=$Stream;Buffer=$buffer;Count=0;Ended=$false;Output=[IO.MemoryStream]::new();Task=$Stream.ReadAsync($buffer,0,$buffer.Length)}
}
function Update-ObserverPreparationPipe($Pipe) {
    if ($Pipe.Ended -or -not $Pipe.Task.IsCompleted) { return }
    $count = $Pipe.Task.GetAwaiter().GetResult()
    if ($count -eq 0) { $Pipe.Ended = $true; return }
    $Pipe.Count += $count
    if ($Pipe.Count -gt 8192) { throw 'observer_prepare_failed' }
    $Pipe.Output.Write($Pipe.Buffer,0,$count)
    $Pipe.Task = $Pipe.Stream.ReadAsync($Pipe.Buffer,0,$Pipe.Buffer.Length)
}
function Wait-ObserverPreparation($Child, [object[]]$Pipes, $WriteTask, $Elapsed, [int]$Maximum = 5000) {
    if ($Maximum -lt 1 -or $Maximum -gt 5000 -or $Pipes.Length -ne 2) { throw 'observer_prepare_failed' }
    $inputClosed = $false
    for (;;) {
        if ($Elapsed.ElapsedMilliseconds -ge $Maximum) { throw 'observer_prepare_failed' }
        if (-not $inputClosed -and $WriteTask.IsCompleted) {
            $null = $WriteTask.GetAwaiter().GetResult(); $Child.StandardInput.Close(); $inputClosed = $true
        }
        foreach ($pipe in $Pipes) { Update-ObserverPreparationPipe $pipe }
        if ($inputClosed -and $Child.HasExited -and $Pipes[0].Ended -and $Pipes[1].Ended) {
            if ($Child.ExitCode -ne 0 -or $Pipes[1].Count -ne 0 -or [Text.Encoding]::UTF8.GetString($Pipes[0].Output.ToArray()) -cne "observer_prepared`n") { throw 'observer_prepare_failed' }
            return
        }
        [Threading.Thread]::Sleep(1)
    }
}
try {
    if ($null -eq $Job) { throw 'observer_prepare_failed' }
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') { throw 'observer_prepare_failed' }
    $expected = Join-Path $env:RUNNER_TEMP 'hpm-installed-clients/payload/runtime/node/node.exe'
    if ($Node -cne $expected -or [IO.Path]::GetFullPath($Node) -cne $Node -or $InstallDirectory -cne (Join-Path $env:RUNNER_TEMP 'hpm-installed-clients/payload')) { throw 'observer_prepare_failed' }
    Assert-ObserverPhysical $Node
    $manifestPath = Join-Path $InstallDirectory 'release-runtime-manifest.json'
    Assert-ObserverPhysical $manifestPath
    if ($ManifestSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ManifestSha256) { throw 'observer_prepare_failed' }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json -AsHashtable
    if ((Get-FileHash -LiteralPath $Node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.nodeSha256) { throw 'observer_prepare_failed' }
    $json = [ordered]@{caseRoot=$CaseRoot;install=$InstallDirectory;token=$Token;pid=$OwnerPid;manifestSha256=$ManifestSha256} | ConvertTo-Json -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192) { throw 'observer_prepare_failed' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Node; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.Environment.Clear()
    foreach ($key in @('SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','RUNNER_TEMP')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if (-not [string]::IsNullOrEmpty($value)) { $start.Environment[$key] = $value }
    }
    $start.ArgumentList.Add((Join-Path $PSScriptRoot 'nsis-client-observer.cjs')); $start.ArgumentList.Add('prepare')
    $child = [Diagnostics.Process]::new(); $child.StartInfo = $start
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    if (-not $child.Start()) { throw 'observer_prepare_failed' }
    $Job.Assign($child)
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $writing = $child.StandardInput.BaseStream.WriteAsync($bytes,0,$bytes.Length)
    $pipes = @((New-ObserverPreparationPipe $child.StandardOutput.BaseStream), (New-ObserverPreparationPipe $child.StandardError.BaseStream))
    Wait-ObserverPreparation $child $pipes $writing $elapsed

} catch { throw 'observer_prepare_failed' } finally { if ($null -ne $child) { $child.Dispose() } }
