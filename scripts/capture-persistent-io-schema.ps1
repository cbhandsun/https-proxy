$ErrorActionPreference='Stop'
try {
    $preflight=$args.Count -eq 1 -and $args[0] -ceq '--preflight'
    if($args.Count -ne 0 -and -not $preflight){throw 'io_schema_failed'}
    Import-Module (Join-Path $PSScriptRoot 'lib/persistent-io-schema-recording.psm1')
    if($preflight){Invoke-HpmPersistentIoSchemaPreflight}else{Invoke-HpmPersistentIoSchemaDiscovery}
} catch {
    [Console]::Error.WriteLine('persistent_io_schema_failed')
    exit 1
}
