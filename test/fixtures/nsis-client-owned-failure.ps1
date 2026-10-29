param([string]$ScriptFile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($ScriptFile, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'parse_failed' }
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($function.Name -cin @('Set-OwnedFailure', 'Assert-OwnedExit')) { Invoke-Expression $function.Extent.Text }
}
$checks = 0
foreach ($case in @(
    @{ Process = @{ HasExited = $false; ExitCode = 0 }; Phase = 'natural_exit_timeout' },
    @{ Process = @{ HasExited = $true; ExitCode = 1 }; Phase = 'natural_exit_code' },
    @{ Process = @{ HasExited = $true; ExitCode = -1 }; Phase = 'natural_exit_code' }
)) {
    $failed = $false; $failurePhase = $null
    $rejected = $false
    try { Assert-OwnedExit $case.Process } catch { $rejected = $_.Exception.Message -ceq 'nsis_client_owned_failed' }
    if (-not $rejected -or -not $failed -or $failurePhase -cne $case.Phase) { throw 'classification_failed' }
    Set-OwnedFailure 'drain'
    if ($failurePhase -cne $case.Phase) { throw 'first_failure_lost' }
    $checks++
}
$failed = $false; $failurePhase = $null
Assert-OwnedExit @{ HasExited = $true; ExitCode = 0 }
if ($failed -or $null -ne $failurePhase) { throw 'success_changed' }; $checks++
$guards = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if ($failurePhase -cnotin ')
}, $true))
$markers = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Extent.Text -ceq "[Console]::Error.WriteLine('HPM_OWNED_FAILURE=' + `$failurePhase)"
}, $true))
if ($guards.Count -ne 1 -or $markers.Count -ne 1) { throw 'publisher_missing' }
foreach ($candidate in @('natural_exit_timeout', 'natural_exit_code', 'drain', ('PRIVATE' + [char]10 + 'token'))) {
    $failurePhase = $candidate
    Invoke-Expression $guards[0].Extent.Text
    $expected = if ($candidate.StartsWith('PRIVATE')) { 'admission' } else { $candidate }
    $sink = [IO.StringWriter]::new(); $previous = [Console]::Error
    try { [Console]::SetError($sink); Invoke-Expression $markers[0].Extent.Text } finally { [Console]::SetError($previous) }
    if ($sink.ToString().TrimEnd() -cne ('HPM_OWNED_FAILURE=' + $expected)) { throw 'publisher_unsafe' }
    $sink.Dispose(); $checks++
}
[Console]::Out.Write('{"checks":' + $checks + ',"nativeCalls":0,"networkCalls":0}')
