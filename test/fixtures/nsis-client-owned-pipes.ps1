param([string]$ScriptFile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($ScriptFile, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'parse_failed' }
$names = @('New-OwnedPipe', 'Update-OwnedPipes', 'Assert-OwnedExit', 'Wait-OwnedExit')
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($function.Name -cin $names) { Invoke-Expression $function.Extent.Text }
}
$checks = 0
foreach ($exitState in @(@{HasExited=$true;ExitCode=1}, @{HasExited=$true;ExitCode=-1}, @{HasExited=$false;ExitCode=0})) {
    $rejected = $false
    try { Assert-OwnedExit $exitState } catch { $rejected = $_.Exception.Message -ceq 'nsis_client_owned_failed' }
    if (-not $rejected) { throw 'exit_accepted' }; $checks++
}
Wait-OwnedExit @{HasExited=$true;ExitCode=0} @(); $checks++
foreach ($size in @(0, 1, 4096, 262144, 262145)) {
    $input = [IO.MemoryStream]::new([byte[]]::new($size))
    $output = [IO.MemoryStream]::new()
    $pipe = New-OwnedPipe $input $output
    $rejected = $false
    try { while (-not $pipe.Ended) { Update-OwnedPipes @($pipe) } } catch { $rejected = $_.Exception.Message -ceq 'nsis_client_owned_failed' }
    if ($rejected -ne ($size -gt 262144) -or $output.Length -gt 262144 -or ($size -le 262144 -and $output.Length -ne $size)) { throw 'limit_failed' }
    $input.Dispose(); $output.Dispose(); $checks++
}
$stdout = [IO.MemoryStream]::new([byte[]]@(1,2,3))
$stderr = [IO.MemoryStream]::new([byte[]]@(4,5,6))
$sink = [IO.MemoryStream]::new()
$pipes = @((New-OwnedPipe $stdout $sink), (New-OwnedPipe $stderr ([IO.Stream]::Null)))
while (@($pipes | Where-Object { -not $_.Ended }).Count -gt 0) { Update-OwnedPipes $pipes }
if ([Convert]::ToHexString($sink.ToArray()) -cne '010203' -or $pipes[1].Count -ne 3) { throw 'discard_failed' }
$checks++
$fault = New-OwnedPipe ([IO.MemoryStream]::new()) ([IO.Stream]::Null)
$fault.Task = [Threading.Tasks.Task]::FromException[int]([IO.IOException]::new('PRIVATE'))
$rejected = $false
try { Update-OwnedPipes @($fault) } catch { $rejected = $true }
if (-not $rejected) { throw 'fault_accepted' }; $checks++
$input = [IO.MemoryStream]::new([byte[]]::new(262145))
$pipe = New-OwnedPipe $input ([IO.Stream]::Null)
$rejected = $false
try { while (-not $pipe.Ended) { Update-OwnedPipes @($pipe) } } catch { $rejected = $_.Exception.Message -ceq 'nsis_client_owned_failed' }
if (-not $rejected) { throw 'stderr_limit_accepted' }; $checks++
[Console]::Out.Write('{"checks":' + $checks + ',"nativeCalls":0,"networkCalls":0}')
