Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'nsis-lifecycle.psm1') -DisableNameChecking
# This read-only OS executable may legitimately share a WinSxS hard link.
# The writable-artifact validator, including its hard-link rejection, is unchanged.
function Assert-HpmSchemaWprTool([string]$Path) {
    $systemRoot=[string]$env:SystemRoot
    if([string]::IsNullOrWhiteSpace($systemRoot) -or -not [IO.Path]::IsPathFullyQualified($systemRoot) -or $systemRoot -match '\A[\\/]{2}' -or $Path -match '\A[\\/]{2}'){throw 'io_schema_failed'}
    $expected=Join-Path ([IO.Path]::GetFullPath($systemRoot)) 'System32/wpr.exe'
    if(-not [string]::Equals($Path,$expected,[StringComparison]::OrdinalIgnoreCase)){throw 'io_schema_failed'}
    Assert-HpmLifecycleChildPath ([IO.Path]::GetPathRoot($expected)) $expected
    if(-not (Test-Path -LiteralPath $expected -PathType Leaf)){throw 'io_schema_failed'}
}
function Get-HpmSchemaWprHash([string]$Path) {
    Assert-HpmSchemaWprTool $Path
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash
}
Export-ModuleMember -Function Assert-HpmSchemaWprTool,Get-HpmSchemaWprHash
